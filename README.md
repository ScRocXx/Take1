# Take1

**Mess up out loud. Ship take one.**

Take1 is a screen recorder you direct with your voice. Fluff a line, press **Ctrl + Alt + Space** and say “cut” (or “redo that line”). It rewinds to the start of your sentence, replays the last five seconds so you can find your rhythm, and punches you back in. Say “that’s a wrap” and the video is finished: MP4, captions, chapters, a submission post and a blooper reel.

Built for the Wispr Flow #NoHandsChallenge.

## Run it

Needs Node 18+.

```bash
npm install
npm run app        # desktop app: global hotkeys + floating pill (recommended)
npm run app:dev    # same, with hot reload
npm run dev        # browser only (Chrome / Edge)
```

The first time you turn the mic on, the local voice engine downloads (about 60 MB, once). After that it runs offline on your machine.

## How you use it

1. **Green room**: pick a mic and watch the bars move. Try a few commands; nothing is recorded.
2. **Stage**: choose the window you’ll demo, optionally a camera bubble, and draw **Stage Marks** (“terminal”, “preview”) you can zoom into by name.
3. **The pill**: the main window steps aside and a small capsule sits at the bottom of your screen, like Flow’s. Hover it for the controls: mic, record/stop, cut, hold, timecode, command.
4. **Dailies**: review the cut, the splices, the outtakes, and an on-device transcript.
5. **Wrap**: final MP4 plus `.srt`, YouTube chapters, a submission post, a social post and a blooper reel.

### It never listens on its own

Take1 only interprets speech after you ask it to: press the command shortcut or click the pill. It listens until you stop talking (or press Esc), acts, and goes quiet. Your narration is recorded but never treated as a command.

### Shortcuts (global in the desktop app, editable in Settings)

| Shortcut | Does |
| --- | --- |
| `Ctrl+Alt+Space` | Give a voice command |
| `Ctrl+Alt+R` | Record / stop (the manual switch) |
| `Ctrl+Alt+C` | Cut: redo the last sentence |
| `Ctrl+Alt+H` | Hold / resume |
| `Ctrl+Alt+M` | Mute / unmute the mic |
| `Ctrl+Alt+T` | Show / hide the pill |
| `Esc` | Cancel a command while listening |

### Say it your way

| Intent | Examples that work |
| --- | --- |
| Action | “action”, “we’re live”, “keep going”, “resume” |
| Cut | “cut”, “redo that line”, “I messed up”, “one more time”, “go back” |
| Back N seconds | “go back ten seconds”, “rewind five” |
| Hold | “hold”, “speed this up”, “waiting for the build”, “pause” |
| Zoom / Wide | “zoom in on the terminal”, “focus preview” / “zoom out”, “full screen” |
| Redact | “redact that”, “blur that”, “that was my API key” |
| Chapter | “mark it, live demo”, “new chapter: setup” |
| Scratch that | “never mind”, “undo”, “cancel” (during a replay it cancels the Cut) |
| Camera / Mic | “camera off”, “mute the mic”, “unmute” |
| Wrap | “that’s a wrap”, “we’re done”, “stop recording” |

Commands are understood in three layers: phonetic repair of common mishearings (“rap” → wrap, “cot” → cut, “hole” → hold), a weighted phrase lexicon with entity extraction (seconds, mark names, chapter titles), and local sentence embeddings (MiniLM) for paraphrases. If it isn’t sure, the pill asks “did you mean” with one-click options.

## How the hard parts work

**The tape is an edit list.** Video is encoded live with WebCodecs into chunks on an output timeline; audio is PCM placed sample-accurately using the AudioContext clock. A Cut truncates both and moves what was removed into an outtake. Nothing is re-encoded until export, and only when redactions must be burned in.

**Keyframes at splices.** The first frame after every punch-in is a forced keyframe, so the new take never references thrown-away frames. The same applies after Hold trims a spoken command. A keyframe every second lets outtakes and replays decode from a nearby GOP.

**Finding the sentence start without live transcription.** The audio tape is scanned backwards in 10 ms windows against an adaptive noise floor: skip the pause before you pressed the shortcut, walk back through your last sentence, stop at a ≥380 ms gap. The splice lands on the quietest 10 ms nearby. Saying “cut” again during the replay goes back one more sentence.

**The 5-second replay is the real tape.** During the rewind, the last five seconds are decoded from the tape and played back in sync with the audio, with the countdown in the final three seconds. The final frame is overlaid on your live screen with a match meter, so you can line your window back up before the punch-in.

**Spoken commands never reach the final audio.** Because command mode has a known start, the exact span from shortcut to action is muted retroactively (10 ms fades). For Hold, that span is trimmed off the tape entirely, so there is no dead air.

**The pill stays out of the video.** In the desktop app the pill is a transparent, always-on-top, non-focusable window with content protection, which excludes it from screen capture even when you record the whole screen. In the browser it’s a Picture-in-Picture window, so capture a single window.

**Recording doesn’t stall in the background.** The desktop app disables background throttling. The browser build pulls frames with `MediaStreamTrackProcessor` and runs its frame clock in a Web Worker.

**Zero-dependency MP4.** `src/engine/mp4.ts` writes ISO BMFF directly (H.264 or VP9, AAC or Opus, faststart).

## Project structure

```
electron/       main.cjs (hotkeys, pill window, source picker), preload.cjs
src/engine/     director (state machine), audio (+ VAD), compositor, videoTape, replay, snapshots, exporter, mp4, ticker
src/voice/      intent (semantic matching), stt + stt.worker (local Whisper + MiniLM), recognizer (browser fallback)
src/ui/         Pill, components (glyphs, bars, replay), tokens.css, app.css, sounds
src/screens/    GreenRoom, Stage, Console, Dailies, Wrap
```

## Design

The interface follows Wispr Flow’s design language: lemon-cream canvas `#ffffeb`, ink `#1a1a1a`, EB Garamond display over Figtree, a lavender primary action, fathom green as the one dark panel, and glow orange as the signal colour. Take1 adds one brick-red tally light that only appears while tape is rolling. Every action has its own animated glyph in the same line style: reels spin back for Cut, chevrons run for Hold, brackets close for Zoom, a bar wipes for Redact, a ribbon drops for Chapter, the clapper closes for Wrap.

## Known limits

- Recordings are held in memory (about 300 MB per 10 minutes at 1080p).
- Outtakes can be watched and exported as a blooper reel, but not yet swapped back into the cut.
- Global shortcuts toggle listening (press, speak, it ends on silence). Hold-to-talk would need a native keyboard hook.
