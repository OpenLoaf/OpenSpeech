<div align="center">
  <img src="images/logo-rounded.png" alt="OpenSpeech" width="120" />

  <h1>OpenSpeech</h1>

  <p><strong>Press a hotkey, speak, and your words appear right at the cursor.</strong></p>

  <p>Cross-platform AI voice typing for the desktop.</p>

  <p>
    <a href="https://github.com/OpenLoaf/OpenSpeech/releases/latest"><img src="https://img.shields.io/github/v/release/OpenLoaf/OpenSpeech?include_prereleases&style=flat-square" alt="Release" /></a>
    <a href="../LICENSE"><img src="https://img.shields.io/github/license/OpenLoaf/OpenSpeech?style=flat-square" alt="License" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
  </p>

  <p>
    <a href="../README.md">简体中文</a>
    · <strong>English</strong>
    · <a href="README.zh-TW.md">繁體中文</a>
  </p>
</div>

---

## About

OpenSpeech is a cross-platform desktop voice typing tool. Press a hotkey in any app to start recording, press it again, and the transcribed text is written at your cursor. Released for Windows, macOS and Linux at the same time.

**Speak in plain words and the transcript lands at your cursor as a clean, structured note.** Record → transcribe → AI clean-up smooths over filler words, slips of the tongue and self-corrections, then reformats the result the way you want it:

<p align="center">
  <img src="images/demo-en.gif" alt="OpenSpeech demo: record, transcribe, AI clean-up, write to cursor" width="640" />
</p>

## Features

- **Global voice input** — Works in editors, browsers, chat apps and terminals. No per-app integration required.
- **Customisable hotkeys** — Defaults: `Fn + Ctrl` on macOS, `Ctrl + Win` on Windows, `Ctrl + Super` on Linux. Rebind to anything you like.
- **Real-time AI clean-up** — Removes filler words like "um/uh", fixes slips of the tongue, and produces text you can use as-is.
- **History & retry** — Every transcription is saved locally; review, copy, or re-transcribe at any time.
- **Personal dictionary** — Add proper nouns, people's names and jargon to improve accuracy.
- **Localised UI** — Simplified Chinese and English; light/dark themes follow the system.
- **Tray / autostart / in-app updates** — The usual desktop niceties.

## Screenshots

<p align="center">
  <img src="images/english.png" alt="OpenSpeech English UI" width="640" />
</p>

## Install

Grab the installer for your platform from [Releases](https://github.com/OpenLoaf/OpenSpeech/releases/latest):

- **macOS**: `OpenSpeech_x.y.z_universal.dmg` (macOS 10.15+)
- **Windows**: `OpenSpeech_x.y.z_x64-setup.exe`
- **Linux**: `.AppImage` / `.deb` / `.rpm`

You'll be asked to grant microphone access on first launch; macOS additionally needs Accessibility permission.

## Roadmap (To-Do)

### Shipped
- [x] Cloud-based audio transcription via SaaS
- [x] Real-time transcription with AI clean-up
- [x] History and retry
- [x] Dictionary

### In progress
- [ ] Long-form / meeting mode

### Planned
Multi-provider STT integrations:

- [ ] Microsoft Azure Speech
- [ ] Google Cloud Speech-to-Text
- [ ] Tencent Cloud Speech
- [ ] Alibaba Cloud Speech
- [ ] Volcengine (Doubao) Speech
- [ ] iFlytek Speech
- [ ] OpenAI Whisper API
- [ ] Deepgram
- [ ] AssemblyAI

## Quick start

1. Launch OpenSpeech and grant the requested permissions.
2. Click into any text input to place the cursor.
3. Press the hotkey to start talking —
   - macOS: `Fn + Ctrl`
   - Windows: `Ctrl + Win`
   - Linux: `Ctrl + Super`
4. Press the same hotkey again to stop. The transcription is inserted at the cursor.

## Development

Stack: Tauri 2 · React 19 · TypeScript · Rust · Tailwind CSS 4.

```bash
git clone https://github.com/OpenLoaf/OpenSpeech.git
cd OpenSpeech
pnpm install
pnpm tauri dev
```

Requirements: Node.js ≥ 18, pnpm ≥ 9, Rust stable. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for platform-specific dependencies.

## Contributing

Issues and pull requests are welcome. For non-trivial changes, please open an issue first to discuss the approach.

## License

[MIT](../LICENSE) © OpenLoaf
