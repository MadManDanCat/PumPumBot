# PumPumBot

A foolproof Twitch chat → text-to-speech desktop app. Type your channel name, hit Connect, done.

## Features
- Anonymous Twitch IRC connection — **no login, no OAuth, no tokens**
- Local TTS using the system speech engine (Windows SAPI / built-in voices) — instant, offline, free
- Big ON/OFF toggle, Sub Only, Mod Only, Mute, Skip
- Volume & speech-rate sliders, voice picker
- Live "Now Reading" + queue preview
- Built-in spam protection: per-user cooldown, duplicate detection, link blocking, length cap
- OBS browser-source overlay served on `http://127.0.0.1:4488/`
- Dark, minimal UI

## Run from source
```bash
npm install
npm start
```

## Build a one-click Windows installer
```bash
npm install
npm run build
```
Outputs an installer + portable exe in `dist/`.

## How to use
1. Launch PumPumBot.
2. Type your Twitch channel name (e.g. `imstilldadaddy`) and click **Connect**.
3. Pick a voice and adjust volume / speed.
4. (Optional) In OBS → **Add → Browser Source** → paste the overlay URL shown in-app.

## Config
Settings persist automatically to `%APPDATA%/PumPumBot/config.json`. Defaults live in `config.json` at the project root.

| Key | Meaning |
|---|---|
| `channel` | Twitch channel (lowercase, no `#`) |
| `enabled` | Master TTS on/off |
| `volume` | 0.0 – 1.0 |
| `rate` | 0.5 – 2.0 (1.0 = normal) |
| `voice` | Voice name; empty = system default |
| `subOnly` / `modOnly` | Restrict who is read |
| `muted` | Skip everything |
| `maxLength` | Drop messages longer than N chars |
| `blockLinks` | Skip messages containing URLs |
| `perUserCooldownMs` | Min ms between same user's reads |
| `duplicateWindowMs` | Window to suppress duplicate text |
| `readUsername` | Prepend "username says, …" |

## Notes on TTS
This build bundles **Piper TTS** with the `en_US-amy-medium` voice — natural-sounding, fully offline, no API keys. The `vendor/piper/` directory ships with the installer as a packaged resource. To add more voices, download additional `.onnx` + `.onnx.json` pairs from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) into `vendor/piper/voices/` and rebuild — they'll appear in the Voice dropdown automatically.

## Project layout
```
main.js                 Electron main + overlay HTTP/WS server
preload.js              IPC bridge
renderer/index.html     Main UI
renderer/styles.css     Theme
renderer/app.js         IRC + TTS + UI logic
overlay/overlay.html    OBS browser source
config.json             Default config
```

## License
MIT
