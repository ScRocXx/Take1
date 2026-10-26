import { useEffect } from 'react';
import { native } from '../lib/native';
import { store, useStore } from '../lib/store';
import { CALL_SHEET } from '../voice/intent';
import { Glyph, Keys } from './components';

const SHORTCUT_ROWS: [string, string][] = [
  ['record', 'Start recording / stop and wrap'],
  ['cut', 'Cut: redo the last sentence, no voice needed'],
  ['hold', 'Hold dead air / resume'],
  ['mic', 'Mute / unmute your mic'],
  ['pill', 'Show / hide the floating pill'],
];

/** The manual, always one click away ("How it works" in the top bar). */
export function Help() {
  const talk = useStore((s) => s.talkKey);
  const sc = useStore((s) => s.shortcuts);
  const close = () => store.set({ helpOpen: false });
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <div className="drawer-scrim" onClick={close}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="How Take1 works">
        <header>
          <p className="overline">How it works</p>
          <button className="btn btn-quiet" onClick={close}>
            Close
          </button>
        </header>
        <h2 className="drawer-title">
          Talk. Fluff it. <em>Say cut.</em> Keep going.
        </h2>
        <p className="muted">You never stop the recording to fix a mistake. Take1 fixes it while you’re still rolling.</p>

        <ol className="loop">
          <li>
            <span className="loop-g">
              <Glyph kind="action" size={30} />
            </span>
            <strong>Record and narrate</strong>
            <span>Press Record. Talk through your demo like normal.</span>
          </li>
          <li>
            <span className="loop-g">
              <Glyph kind="listen" size={30} />
            </span>
            <strong>Fluffed a line?</strong>
            <span>
              Hold <Keys accel={talk} />, say <q>cut</q>, let go.
            </span>
          </li>
          <li>
            <span className="loop-g">
              <Glyph kind="cut" size={30} />
            </span>
            <strong>It rewinds and replays</strong>
            <span>Back to the start of that sentence, then the last 5 s play so you catch your rhythm.</span>
          </li>
          <li>
            <span className="loop-g">
              <Glyph kind="punch" size={30} />
            </span>
            <strong>3, 2, 1, you’re back</strong>
            <span>Say the sentence again. The bad take is gone from the video.</span>
          </li>
        </ol>

        <section className="help-sec">
          <h3>Push to talk</h3>
          <div className="ptt">
            <Keys accel={talk} />
            <p>
              Commands are only heard <strong>while you hold the keys</strong> (or press and hold the pill’s voice button). Let go and Take1 acts. The rest of
              the time it isn’t listening: everything you say is narration on the tape, and your spoken commands are muted out of the final audio.
            </p>
          </div>
          <p className="muted small">
            {native
              ? 'Desktop app: the keys work from any app, even while Take1 is hidden.'
              : 'Browser: keys only work while the Take1 tab or the floating pill window is focused. While you present another window, use the pill: press and hold its voice button. For keys that work everywhere, run the desktop app (npm run app).'}{' '}
            Fn can’t be used: on Windows laptops the Fn key never reaches the operating system. Change the talk key in Record → Settings.
          </p>
        </section>

        <section className="help-sec">
          <h3>Say it your way</h3>
          <ul className="say-list">
            {CALL_SHEET.map((c) => (
              <li key={c.key}>
                <Glyph kind={c.key} size={20} />
                <div>
                  <q>{c.say}</q> <small>{c.also}</small>
                  <span>{c.does}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="help-sec">
          <h3>Buttons and shortcuts</h3>
          <table className="keys-table">
            <tbody>
              <tr>
                <td>
                  Hold <Keys accel={talk} />
                </td>
                <td>Give a voice command, release to send</td>
              </tr>
              {SHORTCUT_ROWS.map(([k, d]) => (
                <tr key={k}>
                  <td>
                    <Keys accel={sc[k]} />
                  </td>
                  <td>{d}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <Keys accel="Esc" />
                </td>
                <td>Cancel a command while listening</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="help-sec">
          <h3>After you stop</h3>
          <dl className="after">
            <dt>Review</dt>
            <dd>Watch the finished cut. The timeline marks every splice (where a retake was joined), held waits and blurred sections. Below it, the outtakes: every line you retook, playable.</dd>
            <dt>Export</dt>
            <dd>Download the MP4. Generate captions on your device, download them as .srt / .vtt or burn them into the video. Copy a ready-made submission post and chapters.</dd>
            <dt>Library</dt>
            <dd>Every exported take is saved on this computer. Play, rename, download or delete them any time.</dd>
          </dl>
        </section>
      </aside>
    </div>
  );
}
