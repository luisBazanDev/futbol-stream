const express = require("express");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { OBSWebSocket } = require("obs-websocket-js");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const OBS_ADDRESS = process.env.OBS_ADDRESS || "ws://127.0.0.1:4455";
const OBS_PASSWORD = process.env.OBS_PASSWORD || "";
const OBS_LAPTOP_AUDIO_SOURCE =
  process.env.OBS_LAPTOP_AUDIO_SOURCE || "LAPTOP / MICROFONOS";
const OBS_OVERLAY_SOURCE = process.env.OBS_OVERLAY_SOURCE || "FUTBOL OVERLAY";
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function makeCamera(slot) {
  return {
    slot,
    label: `CAM ${String(slot).padStart(2, "0")}`,
    pushId: null,
    pushUrl: null,
    viewUrl: null,
    connected: false,
    audioEnabled: true,
    obsInputName: `VDO CAM ${String(slot).padStart(2, "0")}`,
  };
}

function makeLaptopAudio() {
  return {
    pushId: null,
    pushUrl: null,
    viewUrl: null,
    configured: false,
  };
}

const defaultState = {
  match: {
    home: "LOCAL",
    away: "VISITANTE",
    homeScore: 0,
    awayScore: 0,
    period: "1T",
    addedSeconds: 0,
    addedTimeUnit: "seconds",
    clock: { status: "stopped", elapsedMs: 0, startedAt: null },
  },
  activeCamera: null,
  activeAudio: "camera",
  laptopAudio: makeLaptopAudio(),
  cameras: Array.from({ length: 5 }, (_, index) => makeCamera(index + 1)),
  obs: { connected: false, streaming: false, recording: false },
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return defaultState;
  }
}

let state = loadState();
if (!state.match.addedTimeUnit) {
  state.match.addedSeconds = Number(state.match.addedSeconds || 0) * 60;
  state.match.addedTimeUnit = "seconds";
  saveState();
}
state.laptopAudio = { ...makeLaptopAudio(), ...(state.laptopAudio || {}) };
state.obs = { connected: false, streaming: false, recording: false, ...(state.obs || {}) };
let obs;
const clients = new Set();

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function elapsedMs() {
  const clock = state.match.clock;
  if (clock.status !== "running" || !clock.startedAt) return clock.elapsedMs;
  return clock.elapsedMs + Date.now() - clock.startedAt;
}

function snapshot() {
  return {
    ...state,
    match: {
      ...state.match,
      clock: { ...state.match.clock, elapsedMs: elapsedMs() },
    },
    serverTime: Date.now(),
  };
}

function broadcast() {
  const message = JSON.stringify({ type: "state", state: snapshot() });
  for (const client of clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function changed() {
  saveState();
  broadcast();
}

function randomId() {
  return crypto.randomBytes(10).toString("hex");
}

function cameraBySlot(slot) {
  return state.cameras.find((camera) => camera.slot === Number(slot));
}

async function getProgramScene() {
  const response = await obs.call("GetCurrentProgramScene");
  return response.currentProgramSceneName;
}

async function ensureOverlayOnTop() {
  if (!obs || !state.obs.connected) return;
  const sceneName = await getProgramScene();
  let sceneItemId;
  try {
    const item = await obs.call("GetSceneItemId", {
      sceneName,
      sourceName: OBS_OVERLAY_SOURCE,
    });
    sceneItemId = item.sceneItemId;
  } catch {
    await obs.call("CreateInput", {
      sceneName,
      inputName: OBS_OVERLAY_SOURCE,
      inputKind: "browser_source",
      inputSettings: {
        url: `http://127.0.0.1:${PORT}/overlay`,
        width: 1920,
        height: 1080,
        shutdown: false,
        restart_when_active: true,
      },
      sceneItemEnabled: true,
    });
    const item = await obs.call("GetSceneItemId", {
      sceneName,
      sourceName: OBS_OVERLAY_SOURCE,
    });
    sceneItemId = item.sceneItemId;
  }
  const { sceneItems } = await obs.call("GetSceneItemList", { sceneName });
  await obs.call("SetSceneItemIndex", {
    sceneName,
    sceneItemId,
    sceneItemIndex: Math.max(0, sceneItems.length - 1),
  });
}

async function ensureLaptopAudioSource() {
  if (!obs || !state.obs.connected || !state.laptopAudio.viewUrl) return;
  const sceneName = await getProgramScene();
  let sourceExists = false;
  try {
    await obs.call("GetSceneItemId", {
      sceneName,
      sourceName: OBS_LAPTOP_AUDIO_SOURCE,
    });
    sourceExists = true;
  } catch {
    // The source is created below in the current program scene.
  }

  const inputSettings = {
    url: state.laptopAudio.viewUrl,
    width: 640,
    height: 360,
    shutdown: false,
    restart_when_active: true,
    reroute_audio: true,
  };

  if (sourceExists) {
    await obs.call("SetInputSettings", {
      inputName: OBS_LAPTOP_AUDIO_SOURCE,
      inputSettings,
    });
  } else {
    await obs.call("CreateInput", {
      sceneName,
      inputName: OBS_LAPTOP_AUDIO_SOURCE,
      inputKind: "browser_source",
      inputSettings,
      sceneItemEnabled: true,
    });
  }
  state.laptopAudio.configured = true;
}

async function syncCameraToObs(camera) {
  if (!obs || !state.obs.connected || !camera.viewUrl) return;
  const sceneName = await getProgramScene();
  try {
    await obs.call("CreateInput", {
      sceneName,
      inputName: camera.obsInputName,
      inputKind: "browser_source",
      inputSettings: {
        url: camera.viewUrl,
        width: 1920,
        height: 1080,
        reroute_audio: true,
      },
      sceneItemEnabled: camera.slot === state.activeCamera,
    });
  } catch (error) {
    if (!String(error.message).toLowerCase().includes("already exists"))
      throw error;
    await obs.call("SetInputSettings", {
      inputName: camera.obsInputName,
      inputSettings: { url: camera.viewUrl },
    });
  }
}

async function setObsCamera(slot) {
  if (!obs || !state.obs.connected) return;
  const sceneName = await getProgramScene();
  for (const camera of state.cameras) {
    if (!camera.viewUrl) continue;
    try {
      const item = await obs.call("GetSceneItemId", {
        sceneName,
        sourceName: camera.obsInputName,
      });
      await obs.call("SetSceneItemEnabled", {
        sceneName,
        sceneItemId: item.sceneItemId,
        sceneItemEnabled: camera.slot === slot,
      });
    } catch (error) {
      console.warn(
        `No se pudo cambiar ${camera.obsInputName}: ${error.message}`,
      );
    }
  }
  await ensureOverlayOnTop();
}

async function setObsAudio() {
  if (!obs || !state.obs.connected) return;
  for (const camera of state.cameras) {
    if (!camera.viewUrl) continue;
    try {
      await obs.call("SetInputMute", {
        inputName: camera.obsInputName,
        inputMuted:
          !["camera", "both", "all"].includes(state.activeAudio) ||
          (state.activeAudio !== "all" && camera.slot !== state.activeCamera),
      });
    } catch (error) {
      console.warn(
        `No se pudo cambiar el audio de ${camera.obsInputName}: ${error.message}`,
      );
    }
  }
  if (state.laptopAudio.configured) {
    try {
      await obs.call("SetInputMute", {
        inputName: OBS_LAPTOP_AUDIO_SOURCE,
        inputMuted: !["laptop", "both", "all"].includes(state.activeAudio),
      });
    } catch (error) {
      console.warn(`No se pudo cambiar el audio de la laptop: ${error.message}`);
    }
  }
}

async function syncObsStatus() {
  const streamStatus = await obs.call("GetStreamStatus");
  const recordStatus = await obs.call("GetRecordStatus");
  state.obs.streaming = Boolean(streamStatus.outputActive);
  state.obs.recording = Boolean(recordStatus.outputActive);
}

async function connectObs() {
  if (state.obs.connected) return;
  obs = new OBSWebSocket();
  try {
    await obs.connect(OBS_ADDRESS, OBS_PASSWORD);
    state.obs.connected = true;
    for (const camera of state.cameras) await syncCameraToObs(camera);
    if (state.laptopAudio.viewUrl) await ensureLaptopAudioSource();
    await ensureOverlayOnTop();
    if (state.activeCamera) await setObsCamera(state.activeCamera);
    await setObsAudio();
    await syncObsStatus();
    changed();
    obs.on("StreamStateChanged", (event) => {
      state.obs.streaming = Boolean(event.outputActive);
      changed();
    });
    obs.on("RecordStateChanged", (event) => {
      state.obs.recording = Boolean(event.outputActive);
      changed();
    });
    obs.on("CurrentProgramSceneChanged", () => {
      ensureOverlayOnTop().catch((error) =>
        console.warn(`No se pudo reordenar el overlay: ${error.message}`),
      );
    });
  } catch (error) {
    state.obs.connected = false;
    obs = null;
    throw error;
  }
}

function disconnectObs() {
  if (obs) obs.disconnect();
  obs = null;
  state.obs.connected = false;
  state.obs.streaming = false;
  state.obs.recording = false;
  changed();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (_req, res) => res.json(snapshot()));

app.patch("/api/match", (req, res) => {
  const allowed = [
    "home",
    "away",
    "homeScore",
    "awayScore",
    "period",
    "addedSeconds",
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) state.match[key] = req.body[key];
  }
  changed();
  res.json(snapshot());
});

app.post("/api/match/extra-time", (req, res) => {
  const minutes = Number(req.body.minutes);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 99) {
    return res.status(400).json({ error: "El tiempo extra debe estar entre 0 y 99 minutos" });
  }
  state.match.addedSeconds = Math.round(minutes * 60);
  state.match.addedTimeUnit = "seconds";
  changed();
  res.json(snapshot());
});

app.post("/api/match/clock", (req, res) => {
  const action = req.body.action;
  const clock = state.match.clock;
  if (action === "start" && clock.status !== "running") {
    clock.status = "running";
    clock.startedAt = Date.now();
  } else if (action === "pause" && clock.status === "running") {
    clock.elapsedMs = elapsedMs();
    clock.status = "paused";
    clock.startedAt = null;
  } else if (action === "reset") {
    clock.status = "stopped";
    clock.elapsedMs = 0;
    clock.startedAt = null;
  }
  changed();
  res.json(snapshot());
});

app.post("/api/cameras/:slot/connect", async (req, res) => {
  const camera = cameraBySlot(req.params.slot);
  if (!camera) return res.status(404).json({ error: "Cámara no encontrada" });
  camera.label = String(req.body.label || camera.label).slice(0, 40);
  if (!camera.pushId || !/^[a-zA-Z0-9]+$/.test(camera.pushId))
    camera.pushId = randomId();
  camera.pushUrl = `https://vdo.ninja/?push=${camera.pushId}&ps=0&ad=1`;
  camera.viewUrl = `https://vdo.ninja/?view=${camera.pushId}&cleanoutput=1&autoplay=1`;
  camera.connected = true;
  const qrDataUrl = await QRCode.toDataURL(camera.pushUrl, {
    margin: 1,
    width: 440,
  });
  try {
    await syncCameraToObs(camera);
    await ensureOverlayOnTop();
  } catch (error) {
    console.warn(`OBS no pudo crear ${camera.obsInputName}: ${error.message}`);
  }
  changed();
  res.json({ camera, qrDataUrl, state: snapshot() });
});

app.patch("/api/cameras/:slot", (req, res) => {
  const camera = cameraBySlot(req.params.slot);
  if (!camera) return res.status(404).json({ error: "Cámara no encontrada" });
  if (req.body.label !== undefined)
    camera.label = String(req.body.label).slice(0, 40);
  if (req.body.audioEnabled !== undefined)
    camera.audioEnabled = Boolean(req.body.audioEnabled);
  changed();
  res.json(snapshot());
});

app.post("/api/cameras/:slot/air", async (req, res) => {
  const camera = cameraBySlot(req.params.slot);
  if (!camera || !camera.viewUrl)
    return res.status(400).json({ error: "Conecta la cámara primero" });
  state.activeCamera = camera.slot;
  try {
    await setObsCamera(camera.slot);
  } catch (error) {
    console.warn(error.message);
  }
  try {
    await setObsAudio();
  } catch (error) {
    console.warn(error.message);
  }
  changed();
  res.json(snapshot());
});

app.post("/api/audio", (req, res) => {
  const source = ["camera", "laptop", "both", "all", "muted"].includes(req.body.source)
    ? req.body.source
    : "camera";
  if (["laptop", "both"].includes(source) && !state.laptopAudio.configured) {
    return res.status(400).json({ error: "Configura primero el audio de la laptop" });
  }
  state.activeAudio = source;
  setObsAudio().catch((error) => console.warn(error.message));
  changed();
  res.json(snapshot());
});

app.post("/api/audio/setup", async (_req, res) => {
  if (!obs || !state.obs.connected) {
    return res.status(400).json({ error: "Conecta OBS antes de configurar el audio" });
  }
  if (!state.laptopAudio.pushId || !/^[a-zA-Z0-9]+$/.test(state.laptopAudio.pushId)) {
    state.laptopAudio.pushId = randomId();
  }
  state.laptopAudio.pushUrl = `https://vdo.ninja/?push=${state.laptopAudio.pushId}&vd=0&ad=1`;
  state.laptopAudio.viewUrl = `https://vdo.ninja/?view=${state.laptopAudio.pushId}&cleanoutput=1&autoplay=1`;
  try {
    await ensureLaptopAudioSource();
    await ensureOverlayOnTop();
    changed();
    res.json({ audio: state.laptopAudio, state: snapshot() });
  } catch (error) {
    state.laptopAudio.configured = false;
    res.status(502).json({ error: `No se pudo crear el audio en OBS: ${error.message}` });
  }
});

app.post("/api/obs/connect", async (_req, res) => {
  try {
    await connectObs();
    res.json(snapshot());
  } catch (error) {
    res
      .status(502)
      .json({ error: `No se pudo conectar a OBS: ${error.message}` });
  }
});

app.post("/api/obs/disconnect", (_req, res) => {
  disconnectObs();
  res.json(snapshot());
});

app.post("/api/obs/stream", async (req, res) => {
  if (!obs || !state.obs.connected)
    return res.status(400).json({ error: "OBS no está conectado" });
  if (req.body.active) {
    let recordingStarted = false;
    try {
      if (!state.obs.recording) {
        await obs.call("StartRecord");
        recordingStarted = true;
        state.obs.recording = true;
      }
      if (!state.obs.streaming) {
        await obs.call("StartStream");
        state.obs.streaming = true;
      }
      changed();
      return res.json(snapshot());
    } catch (error) {
      if (recordingStarted) {
        try {
          await obs.call("StopRecord");
          state.obs.recording = false;
        } catch (stopError) {
          console.warn(`No se pudo revertir la grabación: ${stopError.message}`);
        }
      }
      return res.status(502).json({ error: `No se pudo iniciar stream y grabación: ${error.message}` });
    }
  }

  const errors = [];
  try {
    if (state.obs.streaming) await obs.call("StopStream");
    state.obs.streaming = false;
  } catch (error) {
    errors.push(`stream: ${error.message}`);
  }
  try {
    if (state.obs.recording) await obs.call("StopRecord");
    state.obs.recording = false;
  } catch (error) {
    errors.push(`grabación: ${error.message}`);
  }
  if (errors.length) {
    changed();
    return res.status(502).json({ error: `No se pudo detener ${errors.join("; ")}` });
  }
  changed();
  res.json(snapshot());
});

app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html")),
);
app.get("/overlay", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "overlay.html")),
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: "state", state: snapshot() }));
  socket.on("close", () => clients.delete(socket));
});

setInterval(() => {
  if (state.match.clock.status === "running") broadcast();
}, 1000);

server.listen(PORT, HOST, () => {
  console.log(`Futbol Stream escuchando en http://${HOST}:${PORT}`);
  console.log(`Panel:   http://localhost:${PORT}/admin`);
  console.log(`Overlay: http://localhost:${PORT}/overlay`);
});
