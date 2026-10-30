import { useEffect } from 'react';
import { native } from '../lib/native';
import { phone } from '../lib/device';
import { store, useStore, DEFAULT_SHORTCUTS } from '../lib/store';
import { CALL_SHEET } from '../voice/intent';
import { Glyph, Keys } from './components';

const SHORTCUT_ROWS: [string, string][] = [
  ['record', 'Start recording / stop'],
  ['pause', 'Pause / play'],
  ['cut', 'Cut: remove the last sentence, no voice needed'],
  ['hold', 'Speed up the waiting / back to normal speed'],
  ['mic', 'Mute / unmute your mic'],
  ['pill', 'Show / hide the floating bar'],
];

/** The manual, one click away ("How it works" in the top bar). */
export function Help() {
  const talk = useStore((s) => s.talkKey);
  const sc = useStore((s) => s.shortcuts);
  const speed = useStore((s) => s.settings.speed);
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
          Talk, and fix mistakes <em>as you go.</em>
        </h2>
        <p className="muted">You never stop recording to fix a mistake, and there’s no editing afterwards.</p>

        <ol className="loop">
          <li>
            <span className="loop-g">
              <Glyph kind="action" size={30} />
            </span>
            <strong>Record and talk</strong>
            <span>Press Record. Talk through your demo as you normally would.</span>
          </li>
          <li>
            <span className="loop-g">
              <Glyph kind="listen" size={30} />
            </span>
            <strong>Fluffed a sentence?</strong>
            <span>
              Hold <Keys accel={talk} />, say <q>cut</q>, let go.
            </span>
          </li>
          <li>
            <span className="loop-g">
              <Glyph kind="cut" size={30} />
            </span>
            <strong>That sentence is removed</strong>
            <span>Take1 finds where the sentence started, removes it, and plays the 5 s before it so you can pick up the rhythm.</span>
          </li>
          <li>
            <span className="loop-g">
              <Glyph kind="play" size={30} />
            </span>
            <strong>3, 2, 1, say it again</strong>
            <span>Recording resumes on its own. The bad take never makes it into the video.</span>
          </li>
        </ol>

        <section className="help-sec">
          <h3>Push to talk</h3>
          <div className="ptt">
            <Keys accel={talk} />
            <p>
              Commands are only heard <strong>while you hold the keys</strong> (or press and hold a voice button). Let go and Take1 acts. The rest of the
              time it isn’t listening for commands: everything you say is part of the recording, and the commands you speak are removed from the audio.
            </p>
          </div>
          <p className="muted small">
            {phone
              ? 'On this phone you can try the commands with the hold button on the home page. Recording happens on a computer, in Chrome or Edge, where you hold the keys instead.'
              : native
              ? 'Desktop app: the keys work from any app, even while Take1 is hidden. You can also turn on the wake phrase in Settings and just say “Take one, cut”.'
              : 'Browser: the keys only work while the Take1 tab or the floating bar is focused. While you show another window, press and hold the voice button on the floating bar. The desktop app (Get the app, top right) makes the keys work everywhere.'}{' '}
            {!phone && <>Fn can’t be used: on Windows laptops it never reaches the operating system. You can change the talk key in {native ? 'Settings' : 'Record → Settings'}.</>}
          </p>
        </section>

        <section className="help-sec">
          <h3>What you can say</h3>
          <ul className="say-list">
            {CALL_SHEET.map((c) => (
              <li key={c.key}>
                <Glyph kind={c.key} size={20} />
                <div>
                  <q>{c.say}</q> <small>{c.also}</small>
                  <span>{c.key === 'hold' ? c.does.replace('4×', `${speed}×`) : c.does}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted small">You don’t need the exact words: Take1 matches what you mean, and words that sound alike (“rap”, “paws”) still work.</p>
        </section>

        <section className="help-sec">
          <h3>{phone ? 'Shortcuts on a computer' : 'Shortcuts'}</h3>
          <table className="keys-table">
            <tbody>
              <tr>
                <td>
                  Hold <Keys accel={talk} />
                </td>
                <td>Give a voice command; release to send</td>
              </tr>
              {SHORTCUT_ROWS.map(([k, d]) => (
                <tr key={k}>
                  <td>
                    <Keys accel={sc[k] ?? DEFAULT_SHORTCUTS[k]} />
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
            <dd>Watch the finished video. The strip under it marks joins, sped-up parts and blurs. Transcribe it, edit chapters, and watch the sentences you redid.</dd>
            <dt>Export</dt>
            <dd>Download the MP4 (chapters included), captions as .srt / .vtt or drawn in (pick a style, drag them where you want, choose the font, colours and animation), chapters for YouTube, and send it to a folder, YouTube or Google Drive.</dd>
            <dt>Library</dt>
            <dd>Every export is saved on this computer. Play, rename, download or delete them any time.</dd>
          </dl>
        </section>
      </aside>
    </div>
  );
}
