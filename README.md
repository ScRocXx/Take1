# take/1

**Mess up out loud. Ship take one.**

Take1 is a screen recorder you direct with your voice. Fluff a line, say **“Cut”**, and it rewinds to the start of that sentence, counts you back in with a pre-roll, and splices the retake. Say **“That’s a wrap”** and the video is already finished: MP4, captions, chapters and a submission post.

Built for the Wispr Flow #NoHandsChallenge.

## Run it

Needs Node 18+ and **Chrome or Edge on desktop** (WebCodecs, Web Speech, Document Picture-in-Picture).

```bash
npm install
npm run dev        # opens http://localhost:5173
```

Wear headphones: the pre-roll plays your last two seconds back to you before each punch-in.

## The flow

1. **Green room**: mic check and a rehearsal that teaches the five core commands. Nothing is recorded.
2. **Stage**: share the window you’ll demo, add a camera bubble, draw **Stage Marks** (say their names).
3. **Console**: pops out a floating console. Say **“Action”**.
4. **Dailies**: review the cut, the outtakes lane, transcript, chapters, redaction boxes.
5. **Wrap**: final MP4, `.srt`, YouTube chapters, submission markdown, social post, blooper reel.

## Voice grammar

| Say | What happens |
| --- | --- |
| Action · Rolling · We’re live | Start rolling, resume from Hold, or punch in early during pre-roll |
| Cut · Retake · Cut that | Rewind to the start of the sentence, pre-roll, punch in. Say it again during pre-roll to go back one more line |
| Cut back ten · Back five | Rewind N seconds |
| Scratch that · Undo · Keep it | Undo the last command, or cancel a Cut during pre-roll |
| Hold · Hold tape | Compress dead air 8× until you say Action |
| Zoom terminal · Focus preview | Ease into a Stage Mark |
| Wide · Pull out | Back to full frame |
| Redact that · Blur that | Blur the last 5 s on export (adjust the box in Dailies) |
| Mark it, live demo · Chapter … | Drop a named chapter |
| Camera on / off | Toggle the camera bubble |
| That’s a wrap · Wrap it | Stop and open Dailies |

Commands only fire when spoken on their own, after a short pause, so “a short cut” in narration never triggers. Strict mode requires “Take one, …”. Keyboard backup in the console: `Alt+A` action, `Alt+C` cut, `Alt+H` hold, `Alt+Z` scratch, `Alt+W` wrap.

## How the hard parts work

**The tape is an edit list, not a file.** Video is encoded live with WebCodecs into chunks on an output timeline; audio is raw PCM placed sample-accurately using the AudioContext clock. A Cut truncates both at the splice point and moves what was removed into an outtake. Nothing is re-encoded until export, and only if there are redactions to burn in.

**Keyframe alignment at splices.** Ending a run at any frame is safe, because earlier frames never depend on later ones. Starting one is not, so the first frame after every punch-in is a forced keyframe (`encode(frame, { keyFrame: true })`). A keyframe is also forced every second, so outtakes can be decoded from a nearby GOP (the outtake keeps that GOP prefix).

**Finding the sentence start.** Speech recognition reports words late. A 10 ms RMS envelope with an adaptive noise floor walks back from the first recognized word to the first loud frame after ≥250 ms of quiet. The splice then lands on the quietest 10 ms nearby, and audio splices get 10 ms fades (more reliable than zero-crossing search).

**Spoken commands never reach the final audio.** “Cut” falls inside the discarded region anyway. Non-destructive commands (Zoom, Hold, Mark, Redact, Camera) are muted retroactively: their onset-to-recognition range is stored and silenced with 10 ms fades at export. Because the audio tape is retroactive, this needs no live delay buffer.

**Rolling back the tape doesn’t roll back your screen.** During pre-roll the frame where the tape left off is shown as an onion skin over your live window, with a **Match meter** comparing the two (64×36 grayscale signature). The zoom that was on screen at the splice point is restored automatically.

**The floating console stays out of shot.** Capture defaults to a single window (`displaySurface: 'window'`, `selfBrowserSurface: 'exclude'`), which never includes other windows on top. If you pick a whole monitor, Stage warns you and the console collapses to a small dot while rolling.

**Recording keeps going in a background tab.** Chrome throttles timers and stops `requestAnimationFrame` in hidden tabs. Frames are pulled with `MediaStreamTrackProcessor` and the frame clock runs in a Web Worker, which isn’t throttled.

**Zero-dependency MP4.** `src/engine/mp4.ts` writes ISO BMFF directly (H.264 or VP9 video, AAC or Opus audio, faststart). The only runtime dependency is React.

## Project structure

```
src/
  engine/     director (state machine), audio, compositor, videoTape, snapshots, ticker, exporter, mp4
  voice/      recognizer (Web Speech), grammar
  features/   packet (SRT, chapters, markdown, social post)
  screens/    GreenRoom, Stage, Console, Dailies, Wrap
  ui/         tokens.css, app.css, components, Hud, sounds
  lib/        store, time
```

## Known limits

- Speech recognition uses the browser’s Web Speech API, which streams audio to the browser vendor’s service.
- Recording is kept in memory (about 300 MB per 10 minutes at 1080p). Long sessions are a v2 job for OPFS.
- Outtakes can be played and exported as a blooper reel, but not yet swapped back into the cut.
