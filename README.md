# Futbol Stream Control

Servidor pequeño para controlar OBS desde una laptop conectada por Tailscale, gestionar hasta cinco teléfonos con VDO.Ninja y mostrar un overlay minimalista.

## Arranque

```bash
npm install
npm start
```

Abrir:

- Panel: `http://localhost:3000/admin`
- Overlay para OBS: `http://localhost:3000/overlay`

Para acceder desde la laptop, reemplaza `localhost` por la IP Tailscale del PC.

## OBS

1. Activa WebSocket Server en OBS, puerto `4455`.
2. Si configuras una contraseña, arranca el servidor con `OBS_PASSWORD`.
3. Añade el overlay como Browser Source usando `http://127.0.0.1:3000/overlay`.
4. Pulsa `CONECTAR OBS` en el panel.
5. El servidor crea `FUTBOL OVERLAY` y la coloca encima de las cámaras.
6. Al conectar cada cámara, el servidor crea una fuente Browser Source en la escena activa de OBS.
7. `INICIAR STREAM / REC` inicia la transmisión y la grabación de OBS usando la configuración de salida que ya tengas en OBS.

Variables opcionales:

```bash
OBS_ADDRESS=ws://127.0.0.1:4455 OBS_PASSWORD=tu-clave npm start
```

Si ya tienes una fuente de overlay creada manualmente, renómbrala a `FUTBOL OVERLAY` o define su nombre con `OBS_OVERLAY_SOURCE`.

Para los micrófonos de la laptop, conecta OBS desde el panel y pulsa `CONFIGURAR AUDIO LAPTOP`. El servidor crea automáticamente la fuente remota `LAPTOP / MICROFONOS` y muestra un enlace para abrir VDO.Ninja en la laptop. Autoriza los micrófonos y deja esa pestaña activa. El panel silencia y activa esa fuente cuando se selecciona el audio de la laptop. `TODAS LAS FUENTES` mantiene activos todos los audios de cámaras y laptop. Puedes cambiar el nombre con `OBS_LAPTOP_AUDIO_SOURCE`.

## Cámaras móviles

1. En el panel pulsa `CONECTAR` en un slot.
2. Escanea el QR con el teléfono.
3. Permite cámara y micrófono en VDO.Ninja.
4. Pulsa `PONER AL AIRE` cuando quieras usarla.

La fuente se crea en OBS usando el enlace de visualización de VDO.Ninja. Mantén los teléfonos conectados a corriente y evita que el navegador se suspenda.

## Notas

- El estado del partido se guarda en `data/state.json`.
- El servidor escucha en `0.0.0.0` para funcionar a través de Tailscale.
- OBS queda conectado localmente en `127.0.0.1:4455`; no hace falta exponer ese puerto.
- La interfaz no incluye autenticación todavía. Úsala dentro de tu tailnet y no publiques el puerto directamente en Internet.
