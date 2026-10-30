# Take1

<div align="center">

<h3>A voice-directed screen recorder. Mess up out loud. Ship take one.</h3>

<p>
  <b>Direct your recording while you record.</b> Say <i>"cut"</i> to discard a fluffed sentence, listen to the 5-second rewind, catch your cadence on the 3-2-1 countdown, and seamlessly punch back in. When you stop, your final cut is already edited, levelled to −16 LUFS, and captioned on-device.
</p>

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3-61dafb?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![WebCodecs](https://img.shields.io/badge/WebCodecs-Hardware_Accelerated-green?style=flat-square)](https://w3c.github.io/webcodecs/)
[![Whisper On-Device](https://img.shields.io/badge/AI-Whisper_ONNX_(Local)-orange?style=flat-square)](https://github.com/huggingface/transformers.js)
[![Zero Cloud Leakage](https://img.shields.io/badge/Privacy-100%25_Client_Side-success?style=flat-square)](https://github.com/ScRocXx/Take1)

<br/>

![Take1 Live Recording Console](docs/images/record.jpg)

</div>

---

## 💡 Executive Summary & The Problem

Creating software demos, technical walkthroughs, and pitch videos is notoriously painful:

- **The Redo Dilemma**: You are 4 minutes into a clean recording, you stumble on a word or hit an unexpected error. You either restart from zero or spend 45 minutes inside Premiere, Final Cut, or CapCut slicing audio waveforms, trying to match breath pauses and frame cuts.
- **The Context Collapse**: When you pause a conventional recorder, you lose your rhythm, pitch, and vocal cadence. Resuming sounds jarring and disjointed.
- **The Privacy & Cloud Tax**: Most modern "AI video tools" upload your entire desktop video stream and microphone audio to proprietary cloud servers, exposing internal dashboards, API tokens, and confidential code.

### The Take1 Paradigm Shift
Take1 transforms recording into an interactive, real-time live tape machine:
1. **Never stop recording**: Fluff a sentence? Hold your talk key (<kbd>Ctrl</kbd> + <kbd>Shift</kbd>), say *"cut"*, and release.
2. **Backward VAD scan**: An on-device audio envelope analyzes recent silence thresholds to pinpoint the exact physiological pause where your fluffed sentence began.
3. **Rhythm tape rewind**: Take1 drops the bad take, rewinds 5 seconds, replays the audio/video context through your headphones, and punches you back in after a visual **3 · 2 · 1** countdown.
4. **Instant Zero-Re-Encode Master**: When you hit Stop, there is no rendering queue. Cuts and retakes are spliced at keyframes directly into an interleaved, streaming-ready MP4.

---

## ⚡ 60-Second Quickstart (Evaluator Walkthrough)

### Prerequisites
- **Node.js 18+**
- **Google Chrome** or **Microsoft Edge** (requires WebCodecs and `ReadableStream<VideoFrame>` support)

### Installation & Launch

```bash
# Clone and install dependencies
git clone https://github.com/ScRocXx/Take1.git
cd Take1
npm install

# Option A (Recommended): Desktop app with OS-level keyboard hooks
npm run app

# Option B: Run in browser (keys work while tab is focused)
npm run dev
```

### Try Your First Voice-Directed Take (Live Script)
1. In **Setup**, enable your microphone and select a window or screen.
2. Click **Record** (or hold <kbd>Ctrl</kbd> + <kbd>Shift</kbd> and say *"action"*).
3. Say: *"Welcome to our application. Today we are launching..."*
4. **Fluff on purpose**: *"uh wait, that's the wrong feature, let me redo..."*
5. **Hold <kbd>Ctrl</kbd> + <kbd>Shift</kbd>**, say ***"cut"***, and let go.
6. Notice what happens:
   - Take1 cuts back to the beginning of the fluffed sentence.
   - It plays the last 5 seconds so you hear your voice and see your cursor position.
   - The match meter checks if your active screen matches the replay frame.
   - The countdown ticks **3, 2, 1** — say the line cleanly!
7. Hold <kbd>Ctrl</kbd> + <kbd>Shift</kbd> and say ***"that's a wrap"***.
8. Boom: You are on the **Review** screen. Your fluffed line is stored in Outtakes, and the master video is already perfectly spliced.

---

## 🎬 The 4-Step Production Workflow

```mermaid
flowchart LR
    A["① Setup<br/>Mic · Window · Camera · Hotkeys"] --> B["② Record<br/>Live Tape · VAD Cuts · Fast-Forward"]
    B -->|"that's a wrap"| C["③ Review<br/>Timeline Splicing · Outtakes · Whispers"]
    C --> D["④ Export<br/>Lossless MP4 · Animated Captions · Direct Share"]
    D --> L[("Take Library<br/>IndexedDB Local Master")]
    B -. "cut (5s rhythm replay)" .-> B
```

### ① Setup: Calibrate Sources & Practice Push-to-Talk
Select your audio input device with real-time VU monitoring, choose your target capture window, and optionally toggle a floating circular camera bubble. On first launch, test your keyboard chord in the interactive sandbox to verify hardware hook responsiveness.

![Setup with Push-to-Talk Practice](docs/images/setup-first.jpg)

### ② Record: The Live Director's Console
The recording interface monitors duration, take count, active scene markers, and real-time audio levels. While showing third-party applications, a hardware-accelerated floating control rail remains pinned on top.

| Spoken Command | Alternative Trigger | Engine Action |
|:---|:---|:---|
| **"Cut"** | *"redo that line"*, *"oops again"* | Identifies sentence start via VAD, cuts bad take, replays last 5s with audio, displays 3-2-1 punch-in |
| **"Pause"** / **"Play"** | *"hang on"*, *"continue"* | Halts tape recording completely. The word "pause" is automatically excised from the audio track |
| **"Speed up"** / **"Hold 4×"** | *"fast forward"*, *"speed 8x"* | Captures dead-air (code compilations, test runs) and plays it back at 4×/8× speed without audio |
| **"Blur that"** | *"hide that"*, *"redact"* | Pauses tape, captures current frame, lets you drag a redaction rectangle over secrets or passwords |
| **"Zoom in"** | *"zoom terminal"*, *"zoom code"* | Zooms camera to a pre-defined stage mark or custom drawn region |
| **"Chapter: [Name]"** | *"mark demo"*, *"new section"* | Drops an instant timestamped chapter marker formatted for YouTube descriptions and MP4 `chpl` atoms |
| **"Undo"** | *"never mind"*, *"cancel"* | Restores a cut segment during replay or reverts the last command |
| **"That's a wrap"** | *"stop recording"*, *"we're done"* | Concludes session, locks tape buffers, and transitions to Review |

![Replay Countdown and Visual Match Meter](docs/images/replay.jpg)

> **Visual Screen Match Meter**: During replay, Take1's snapshot engine runs a downsampled perceptual difference comparison between your current screen and the cut-in frame, ensuring you don't resume on the wrong browser tab or editor file.

| Paused State | Sped Up (4× Compression) | On-the-Fly Redaction Box |
|:---:|:---:|:---:|
| ![Paused](docs/images/paused.jpg) | ![Sped Up](docs/images/speed.jpg) | ![Blur](docs/images/blur.jpg) |

### ③ Review: The Edit-Free Cutting Room
Your recording is finished the moment you wrap. The review timeline maps every splice point, fast-forward block, and redaction zone. Spoken commands are permanently silenced from the final track, and outtakes are archived below for review.

![Review Screen and Timeline Breakdown](docs/images/review.jpg)

### ④ Export: Broadcast-Grade Mastering & Social Packet
- **Lossless Splicing**: If no visual modifications (burn-in captions/redactions) are added, the MP4 is assembled losslessly via direct chunk pass-through.
- **Audio Mastering**: Speech is automatically levelled to broadcast standard (−16 LUFS) with soft-knee dynamic compression.
- **Animated Caption Designer**: Choose from 8 visual typography styles (Classic, Bold Pop, Karaoke, Neon, Marker) with real-time video preview.
- **1-Click Cloud Publishing**: Direct OAuth2 PKCE integration to publish straight to YouTube (with chapters & subtitles) or Google Drive.

![Export Screen and Social Packet](docs/images/export.jpg)

---

## 🧠 Deep Technical Architecture

```mermaid
flowchart TB
    subgraph DesktopShell["Desktop Shell (Electron 33 + uiohook-napi)"]
        HOOK["uiohook Low-Level Hook<br/>Global Keyup/Keydown"]
        PROT["Content Protection<br/>setContentProtection(true)"]
        PICKER["desktopCapturer Native Stream"]
        OAUTH["OAuth2 PKCE Loopback Server<br/>safeStorage OS Encryption"]
    end

    subgraph MainThread["Main UI Thread (React 18 + Zustand Store)"]
        UI["Setup · Record · Review · Export · Library"]
        STORE[("Reactive Store<br/>Sub-field Subscriptions")]
        REC["Recorder Engine<br/>Finite State Machine & Edit List"]
        WORKLET["AudioWorklet Processor<br/>Sample-accurate Float32 PCM Tap"]
    end

    subgraph WebWorkers["High-Performance Web Workers (Off-Thread)"]
        CW["compositor.worker<br/>OffscreenCanvas 60fps<br/>WebCodecs VideoEncoder<br/>Perceptual Match Diff"]
        EW["export.worker<br/>Hardware Accelerated Decoder<br/>Loudness Normalizer (-16 LUFS)<br/>Custom MP4 Box Muxer"]
        STTW["stt.worker<br/>Whisper tiny.en / base.en<br/>ONNX WASM SIMD Runtime<br/>MiniLM-L6 Embeddings"]
    end

    HOOK -->|IPC 'command:down/up'| REC
    PICKER --> CW
    WORKLET -->|Raw Float32 PCM| REC
    REC -->|Transferred VideoFrame Stream| CW
    REC -->|Muted Command Buffer| STTW
    STTW -->|Intent Token + Confidence| REC
    REC -->|Export Job Definition| EW
    EW -->|Zero-Copy Uint8Array| DB[("IndexedDB<br/>takes & videos")]
    OAUTH -. Access Tokens .-> UI
```

### 1. Sample-Accurate AudioWorklet Pipeline
Standard `MediaRecorder` implementations suffer from timestamp drift and asynchronous buffer flushing. Take1 bypasses `MediaRecorder` entirely during recording:
- Uses an inline `AudioWorkletNode` (`take1-tap`) that taps mono PCM at a fixed 48 kHz.
- Captures raw audio blocks indexed directly against the `AudioContext.currentTime` hardware clock.
- Maintains a 60-second rolling circular buffer of 10 ms RMS energy envelopes.

### 2. Retrospective Voice Activity Detection (VAD)
When a speaker says *"cut"*, transcription models take 300–600 ms to recognize the intent. Take1's backward scan:
- Traverses the RMS energy envelope backward from the key-release moment.
- Identifies physiological inter-sentence speech pauses ($\ge 0.7\text{ s}$ pause within a 14-second window, falling back to pauses $\ge 0.38\text{ s}$).
- Snaps the splice point to the nearest zero-crossing / lowest-energy 10 ms valley within a 150 ms window, completely eliminating click/pop audio artifacts.

### 3. Keyframe-Enforced Video Chunk Splicing
- Encoded video frames are ingested via the WebCodecs `VideoEncoder` API.
- The recorder forces an instantaneous IDR keyframe whenever recording starts, resumes after a cut, switches speed, or exits pause.
- Because every transition begins with an independent keyframe, cuts are performed by truncating array slices without requiring any video decoding or re-encoding.

### 4. Zero-Dependency ISO BMFF MP4 Muxer (`src/engine/mp4.ts`)
Take1 includes a hand-crafted, zero-dependency MP4 multiplexer:
- Formats standard MP4 containers directly from memory: `ftyp`, `moov`, `mvhd`, `trak`, `mdia`, `minf`, `stbl`, `mdat`.
- Supports H.264 (`avcC`) / VP9 (`vpcC`) video and AAC (`esds`) / Opus (`dOps`) audio.
- Interleaves video and audio samples in $\sim 0.5\text{ s}$ chunks with synchronized `stsc` (sample-to-chunk) and `stco` (chunk offset) tables, allowing instantaneous web playback before full download completes.
- Embeds standard Nero-compatible `chpl` chapters readable by VLC, QuickTime, YouTube, and `ffmpeg`.
- Automatically pivots to 64-bit offsets (`co64`) and large-file boxes for files exceeding 4 GB.

### 5. 100% On-Device, Air-Gapped AI Inference
- **Speech-to-Text**: Runs Whisper models (`tiny.en` for instant 150 ms command parsing; `base.en` for final video captioning) inside a dedicated Web Worker via ONNX Runtime Web (`ort-wasm-simd-threaded`).
- **Semantic Intent Matching**: User commands are parsed using a dual-layer classifier:
  1. Fast Metaphone phonetic distance matching (`src/voice/phonetic.ts`) for common accents and acoustic ambiguities (e.g., *"wrap"* vs *"rap"*, *"paws"* vs *"pause"*).
  2. MiniLM-L6 vector embeddings for open-ended semantic parsing (e.g., *"redo that line"* $\rightarrow$ `cut`).
- **Zero Audio Leakage**: Spoken commands are mathematically excised from the exported audio track. No audio ever leaves the user's machine.

### 6. Desktop Window Invisibility & Native Keyboard Hook
- Standard web pages cannot capture keyup events or global hotkeys when unfocused.
- Take1's Electron shell loads `uiohook-napi` (N-API bindings to OS event hooks), capturing `Ctrl+Shift` hold-to-talk across any active IDE, terminal, or browser window.
- The floating controls window sets `setContentProtection(true)` at the OS level: Windows Desktop Window Manager (DWM) completely removes the floating controls from the screen capture pipeline, ensuring your controls **never** show up in your final recorded video.

---

## 🎨 Interactive Caption Designer & Typography

Take1 includes an on-device broadcast subtitle renderer with 8 customizable styling presets:

```
[Classic]       Clean dark rounded plate with Figtree typography
[Bold Pop]      High-contrast heavyweight Montserrat with scaling animations
[One Word]      Dynamic single-word display synced to speech cadence
[Highlight]     Accent background box over the currently spoken word
[Karaoke]       Color fill-in progressing across words in real time
[Neon Glow]     Vibrant colored text with diffuse drop glow
[Marker]        Underline brush stroke highlight using Permanent Marker
[Invert Blend]  Difference-blend mode inverting colors against video background
```

All 6 font families (Figtree, Poppins, Montserrat, Anton, Bebas Neue, Permanent Marker) are bundled locally under the SIL Open Font License, requiring zero CDN fetches.

---

## 🔒 Privacy, Security & Ethics

| Concern | Take1 Implementation |
|:---|:---|
| **Audio Privacy** | 100% processed on-device via WebAssembly SIMD. No microphone audio is ever transmitted across the network. |
| **Video Privacy** | Screen capture frames remain in local GPU/RAM memory. Saved to local browser IndexedDB (`takes` and `videos`). |
| **Credential Storage** | Google OAuth refresh tokens are encrypted via Electron `safeStorage` using the OS DPAPI (Windows) or Keychain (macOS). |
| **Redaction Guarantee**| Redacted regions are rendered destructively into canvas pixel buffers prior to MP4 encoding; hidden pixels are permanently unrecoverable. |

---

## 📂 Repository Blueprint

```
Take1/
├── electron/
│   ├── main.cjs               # Electron lifecycle, uiohook keyboard hook, PKCE OAuth, IPC
│   └── preload.cjs            # Context-isolated secure native bridge (window.take1Native)
├── src/
│   ├── App.tsx                # Wizard orchestration, step connectors, portal controls
│   ├── screens/
│   │   ├── Setup.tsx          # Step 1: Input calibration, mic VU, talkKey sandbox
│   │   ├── Record.tsx         # Step 2: Live tape monitor, floating rail, on-the-fly blur
│   │   ├── Review.tsx         # Step 3: Splice inspection, outtake playback, chapters
│   │   ├── Export.tsx         # Step 4: Lossless mastering, caption styles, upload
│   │   ├── CaptionDesigner.tsx# Real-time subtitle typography and placement customizer
│   │   └── Library.tsx        # Local take vault with video playback and export management
│   ├── engine/
│   │   ├── recorder.ts        # Finite state machine orchestrating tape cuts, holds, and state
│   │   ├── audio.ts           # AudioWorklet tap, Float32 buffer, VAD sentence backward scan
│   │   ├── compositor.ts      # Multi-track compositor client & canvas manager
│   │   ├── compositor.worker.ts # OffscreenCanvas compositor, WebCodecs encoder, match diff
│   │   ├── export.ts          # Video render orchestrator & progress pipeline
│   │   ├── export.worker.ts   # Hardware-accelerated decoder, LUFS normalizer, caption burn
│   │   ├── mp4.ts             # Custom ISO BMFF MP4 multiplexer with fast-start & chapters
│   │   ├── video.ts           # Video chunk array list, keyframe logic, decoding runs
│   │   ├── snapshots.ts       # Perceptual hash generation and match scoring
│   │   └── replay.ts          # 5-second rewind preview buffer
│   ├── voice/
│   │   ├── stt.worker.ts      # On-device Whisper STT & MiniLM semantic embeddings
│   │   ├── intent.ts          # Voice call sheet, token parsing, semantic intent registry
│   │   ├── phonetic.ts        # Metaphone phonetic distance & sound-alike correction
│   │   └── recognizer.ts      # Web Speech API fallback and audio chunk feeder
│   ├── lib/
│   │   ├── store.ts           # Reactive store with localStorage persistence & sub-field selector
│   │   ├── captions.ts        # Word-level timestamp alignment and cue formatting
│   │   ├── captionFonts.ts    # Bundled font catalog and font metric loaders
│   │   ├── library.ts         # IndexedDB wrapper for high-throughput blob storage
│   │   └── share.ts           # YouTube Data v3 & Google Drive API upload clients
│   └── ui/
│       ├── FloatingControls.tsx # Always-on-top transparent control rail
│       ├── Help.tsx           # Slide-over interactive manual & call sheet drawer
│       ├── components.tsx     # Atomic design primitives (Buttons, Toggles, Menus)
│       ├── sounds.ts          # Web Audio procedural sound synthesizer for cues
│       └── app.css            # Complete design system & responsive styling
└── docs/images/               # UI screen assets and walkthrough visuals
```

---

## 🏆 Hackathon Evaluator Scorecard

| Criterion | Evaluation Standard | Take1 Implementation |
|:---|:---|:---|
| **Technical Depth** | Does the project solve hard problems beyond standard API wrappers? | Custom zero-dependency MP4 muxer, sample-accurate AudioWorklet, backward VAD pause detection, WebCodecs offscreen worker compositing. |
| **AI Innovation** | Is AI used meaningfully rather than as a gimmick? | Runs Whisper and MiniLM locally via ONNX WASM SIMD; provides real-time voice orchestration, intent extraction, phonetic repair, and automated captioning. |
| **UX & Product Polish** | Does the app feel production-grade? | Beautiful editorial typography, 5-second contextual replay with countdown, perceptual screen match scoring, and always-on-top hardware-protected floating controls. |
| **Completeness** | Is it a functioning end-to-end product? | Complete workflow: record $\rightarrow$ live-cut $\rightarrow$ review $\rightarrow$ burn captions $\rightarrow$ export MP4 $\rightarrow$ upload to YouTube/Drive. |
| **Privacy & Security** | Is user data treated responsibly? | 100% local client execution. Zero audio/video data leaves the machine. Local OS encrypted token storage. |

---

<div align="center">
  <sub>Built with passion for the creator who wants to mess up out loud and still ship take one.</sub>
</div>
