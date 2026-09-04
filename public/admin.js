let state;
let pendingMatchPatches = 0;
const $ = (selector) => document.querySelector(selector);
const api = async (url, options = {}) => {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error de servidor');
  return data;
};

function formatTime(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function render() {
  if (!state) return;
  const { match, obs } = state;
  setInputWhenIdle('#home-name', match.home);
  setInputWhenIdle('#away-name', match.away);
  $('#home-score').textContent = match.homeScore;
  $('#away-score').textContent = match.awayScore;
  setInputWhenIdle('#period', match.period);
  setInputWhenIdle('#added', match.addedSeconds);
  $('#clock').textContent = formatTime(match.clock.elapsedMs);
  $('#clock-toggle').textContent = match.clock.status === 'running' ? 'PAUSAR RELOJ' : 'INICIAR RELOJ';
  $('#obs-status').textContent = obs.connected ? (obs.streaming ? 'OBS / STREAMING' : 'OBS ONLINE') : 'OBS OFFLINE';
  $('#record-status').textContent = obs.recording ? 'REC / ON' : 'REC OFF';
  $('#record-status').classList.toggle('recording', Boolean(obs.recording));
  $('#obs-connect').textContent = obs.connected ? 'DESCONECTAR OBS' : 'CONECTAR OBS';
  $('#stream-toggle').disabled = !obs.connected;
  $('#stream-toggle').textContent = obs.streaming || obs.recording ? 'DETENER STREAM / REC' : 'INICIAR STREAM / REC';
  const laptopAudio = state.laptopAudio || {};
  $('#audio-status').textContent = laptopAudio.configured ? 'CONFIGURADO / LISTO' : 'NO CONFIGURADO';
  $('#audio-status').classList.toggle('connected', Boolean(laptopAudio.configured));
  $('#audio-setup').disabled = !obs.connected;
  $('#audio-link').hidden = !laptopAudio.pushUrl;
  if (laptopAudio.pushUrl) $('#audio-push-url').value = laptopAudio.pushUrl;
  document.querySelectorAll('[data-audio]').forEach((button) => button.classList.toggle('active', button.dataset.audio === state.activeAudio));
  $('#camera-list').innerHTML = state.cameras.map((camera) => `
    <article class="camera-card ${state.activeCamera === camera.slot ? 'active' : ''}">
      <div class="camera-index">0${camera.slot}</div>
      <div><div class="camera-name">${escapeHtml(camera.label)}</div><div class="camera-state ${camera.connected ? 'connected' : ''}">${camera.connected ? 'ENLACE GENERADO / LISTA' : 'SIN CONECTAR'}</div></div>
      <div class="camera-actions"><button data-connect="${camera.slot}">${camera.connected ? 'QR / ENLACE' : 'CONECTAR'}</button><button class="air" data-air="${camera.slot}" ${camera.connected ? '' : 'disabled'}>${state.activeCamera === camera.slot ? 'AL AIRE' : 'PONER AL AIRE'}</button></div>
    </article>`).join('');
}

function setInputWhenIdle(selector, value) {
  const input = $(selector);
  if (document.activeElement !== input) input.value = value;
}

function escapeHtml(value) { return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
async function patchMatch(values) {
  pendingMatchPatches += 1;
  try {
    state = await api('/api/match', { method: 'PATCH', body: JSON.stringify(values) });
    render();
  } finally {
    pendingMatchPatches -= 1;
  }
}

document.addEventListener('click', async (event) => {
  const score = event.target.closest('[data-score]');
  const audio = event.target.closest('[data-audio]');
  const connect = event.target.closest('[data-connect]');
  const air = event.target.closest('[data-air]');
  try {
    if (score) await patchMatch({ [score.dataset.score]: Math.max(0, Number(state.match[score.dataset.score]) + Number(score.dataset.delta)) });
    if (audio) { state = await api('/api/audio', { method: 'POST', body: JSON.stringify({ source: audio.dataset.audio }) }); render(); }
    if (event.target.id === 'audio-setup') await setupLaptopAudio();
    if (event.target.id === 'open-audio') window.open(state.laptopAudio.pushUrl, '_blank', 'noopener');
    if (event.target.id === 'copy-audio') { await navigator.clipboard.writeText(state.laptopAudio.pushUrl); event.target.textContent = 'COPIADO'; setTimeout(() => { event.target.textContent = 'COPIAR'; }, 1500); }
    if (connect) await connectCamera(Number(connect.dataset.connect));
    if (air) { state = await api(`/api/cameras/${air.dataset.air}/air`, { method: 'POST' }); render(); }
    if (event.target.id === 'clock-toggle') { state = await api('/api/match/clock', { method: 'POST', body: JSON.stringify({ action: state.match.clock.status === 'running' ? 'pause' : 'start' }) }); render(); }
    if (event.target.id === 'clock-reset') { state = await api('/api/match/clock', { method: 'POST', body: JSON.stringify({ action: 'reset' }) }); render(); }
    if (event.target.id === 'obs-connect') { state = await api(`/api/obs/${state.obs.connected ? 'disconnect' : 'connect'}`, { method: 'POST' }); render(); }
    if (event.target.id === 'stream-toggle') { state = await api('/api/obs/stream', { method: 'POST', body: JSON.stringify({ active: !state.obs.streaming }) }); render(); }
  } catch (error) { window.alert(error.message); }
});

['home-name', 'away-name', 'period', 'added'].forEach((id) => $((`#${id}`)).addEventListener('change', () => {
  const map = { 'home-name': 'home', 'away-name': 'away', period: 'period', added: 'addedSeconds' };
  patchMatch({ [map[id]]: id === 'added' ? Number($(`#${id}`).value) : $(`#${id}`).value });
}));

async function connectCamera(slot) {
  const camera = state.cameras.find((item) => item.slot === slot);
  const label = window.prompt('Nombre de la cámara', camera.label);
  if (label === null) return;
  const result = await api(`/api/cameras/${slot}/connect`, { method: 'POST', body: JSON.stringify({ label }) });
  state = result.state;
  $('#qr-label').textContent = `${result.camera.label} / ESCANEA CON EL TELEFONO`;
  $('#qr-image').src = result.qrDataUrl;
  $('#push-url').value = result.camera.pushUrl;
  $('#qr-dialog').showModal();
  render();
}

async function setupLaptopAudio() {
  const result = await api('/api/audio/setup', { method: 'POST' });
  state = result.state;
  render();
  window.open(result.audio.pushUrl, '_blank', 'noopener');
}

$('#copy-url').addEventListener('click', async () => { await navigator.clipboard.writeText($('#push-url').value); $('#copy-url').textContent = 'ENLACE COPIADO'; setTimeout(() => { $('#copy-url').textContent = 'COPIAR ENLACE'; }, 1500); });

function connectSocket() {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => { $('#connection-dot').className = 'status-dot online'; $('#connection-label').textContent = 'CONECTADO'; };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state' && pendingMatchPatches === 0) {
      state = message.state;
      render();
    }
  };
  socket.onclose = () => { $('#connection-dot').className = 'status-dot offline'; $('#connection-label').textContent = 'REINTENTANDO'; setTimeout(connectSocket, 1500); };
}
connectSocket();
