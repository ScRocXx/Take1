import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTrack, drawCaptions, drawGroup, FONTS, PRESETS, saveStyle, type Anim, type CaptionStyle, type FontId, type Group, type Highlight, type TimedLine } from '../lib/captions';
import { ensureFont } from '../lib/captionFonts';
import { clock } from '../lib/time';
import { Button } from '../ui/components';

const ANIMS: [Anim, string][] = [
  ['none', 'None'],
  ['pop', 'Pop'],
  ['rise', 'Rise'],
  ['fade', 'Fade'],
  ['bounce', 'Bounce'],
  ['type', 'Word by word'],
];

const HIGHLIGHTS: [Highlight, string][] = [
  ['none', 'None'],
  ['color', 'Colour'],
  ['box', 'Box'],
  ['fill', 'Fill as spoken'],
  ['scale', 'Grow'],
  ['marker', 'Marker'],
];

const SPOTS: [string, number][] = [
  ['Top', 0.14],
  ['Middle', 0.5],
  ['Bottom', 0.84],
];

const SWATCHES = ['#ffffff', '#111111', '#ffd23f', '#3ee08f', '#7b3fe4', '#ff3fa4', '#2d9bff', '#ff6a2b'];

/** Sample words for the style tiles: the middle word is the one being spoken. */
function sample(s: CaptionStyle): { g: Group; t: number } {
  const all = ['say', 'it', 'loud'].map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.4 }));
  const n = s.words === 0 ? 3 : Math.min(3, s.words);
  const words = n === 1 ? [all[1]] : n === 2 ? all.slice(0, 2) : all;
  return { g: { start: words[0].start, end: 9, words }, t: 0.65 };
}

function Tile({ id, label, style, on, onPick }: { id: string; label: string; style: CaptionStyle; on: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    ensureFont(style.font).then(() => {
      const c = ref.current;
      if (!live || !c) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = 132 * dpr;
      const H = 76 * dpr;
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d')!;
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#3c4a5c');
      bg.addColorStop(1, '#16181d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e9e4cf';
      ctx.fillRect(W * 0.55, 0, W * 0.45, H); // a light area, so blending and outlines show
      const { g, t } = sample(style);
      drawGroup(ctx, W, H, t, g, { ...style, x: 0.5, y: 0.5, size: Math.min(0.42, style.size * 3.2), anim: 'none' });
    });
    return () => {
      live = false;
    };
  }, [style]);
  return (
    <button className={`cap-tile${on ? ' on' : ''}`} onClick={onPick} aria-pressed={on} data-preset={id}>
      <canvas ref={ref} />
      <span>{label}</span>
    </button>
  );
}

export function CaptionDesigner({
  lines,
  plain,
  width,
  height,
  style,
  onChange,
  applied,
  busy,
  onApply,
  onRemove,
}: {
  lines: TimedLine[];
  plain: Blob;
  width: number;
  height: number;
  style: CaptionStyle;
  onChange: (s: CaptionStyle) => void;
  /** the style drawn into the current MP4, if any */
  applied: CaptionStyle | null;
  busy: boolean;
  onApply: () => void;
  onRemove: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const url = useMemo(() => URL.createObjectURL(plain), [plain]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const track = useMemo(() => buildTrack(lines, style), [lines, style.words]);
  const live = useRef({ style, track });
  live.current = { style, track };
  const [playing, setPlaying] = useState(true);
  const [now, setNow] = useState(0);
  const [drag, setDrag] = useState<{ snapX: boolean } | null>(null);
  const [fontReady, setFontReady] = useState(0);

  useEffect(() => {
    ensureFont(style.font).then(() => setFontReady((n) => n + 1));
  }, [style.font]);

  // start the preview where the talking starts
  useEffect(() => {
    const v = video.current;
    if (!v || !track.length) return;
    const go = () => {
      v.currentTime = Math.max(0, track[0].start - 0.3);
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  }, [url]);

  // draw the preview: the video frame, then the captions at that moment
  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    let lastClock = -1;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const v = video.current;
      const box = c.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(2, Math.round(box.width * dpr));
      const H = Math.max(2, Math.round(box.height * dpr));
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      if (v && v.readyState >= 2) ctx.drawImage(v, 0, 0, W, H);
      else {
        ctx.fillStyle = '#1d1f24';
        ctx.fillRect(0, 0, W, H);
      }
      const t = v?.currentTime ?? 0;
      drawCaptions(ctx, W, H, t, live.current.track, live.current.style);
      const sec = Math.floor(t);
      if (sec !== lastClock) {
        lastClock = sec;
        setNow(t);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [fontReady]);

  const set = (p: Partial<CaptionStyle>) => {
    const next = { ...style, ...p, preset: 'custom' };
    onChange(next);
    saveStyle(next);
  };
  const pick = (s: CaptionStyle) => {
    onChange(s);
    saveStyle(s);
  };

  const place = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width;
    const y = Math.min(0.95, Math.max(0.05, (e.clientY - r.top) / r.height));
    const snapX = Math.abs(x - 0.5) < 0.04;
    if (snapX) x = 0.5;
    setDrag({ snapX });
    set({ x: Math.min(0.95, Math.max(0.05, x)), y });
  };

  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const same = applied && JSON.stringify(applied) === JSON.stringify(style);

  return (
    <section className="card cap-design" id="caption-style">
      <header className="cap-head">
        <div>
          <h3>Caption style</h3>
          <p className="muted small">Pick a look, then drag the caption on the picture to place it. What you see here is what gets drawn in.</p>
        </div>
        <div className="row">
          {applied && (
            <Button kind="quiet" disabled={busy} onClick={onRemove}>
              Remove from video
            </Button>
          )}
          <Button kind="primary" disabled={busy || !!same} onClick={onApply}>
            {same ? 'Drawn into the video' : applied ? 'Update the video' : 'Draw into the video'}
          </Button>
        </div>
      </header>

      <div className="cap-body">
        <div className="cap-stage">
          <div className="cap-frame" style={{ aspectRatio: `${width} / ${height}` }}>
            <canvas
              ref={canvas}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                place(e);
              }}
              onPointerMove={(e) => drag && place(e)}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
              aria-label="Caption preview. Drag to place the caption."
            />
            {drag && <i className="cap-guide-y" style={{ top: `${style.y * 100}%` }} />}
            {drag?.snapX && <i className="cap-guide-x" />}
          </div>
          <video ref={video} src={url} muted loop playsInline autoPlay onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} className="cap-src" />
          <div className="cap-transport">
            <button className="btn btn-quiet" onClick={togglePlay}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <span className="small muted">{clock(now)} · drag the caption to move it</span>
          </div>
        </div>

        <div className="cap-controls">
          <div className="cap-tiles">
            {PRESETS.map((p) => (
              <Tile key={p.id} id={p.id} label={p.label} style={p.style} on={style.preset === p.id} onPick={() => pick(p.style)} />
            ))}
          </div>

          <div className="cap-grid">
            <label className="cap-field">
              <span>Font</span>
              <select value={style.font} onChange={(e) => set({ font: e.target.value as FontId })}>
                {(Object.keys(FONTS) as FontId[]).map((id) => (
                  <option key={id} value={id}>
                    {FONTS[id].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="cap-field">
              <span>Size</span>
              <input type="range" min={0.03} max={0.2} step={0.005} value={style.size} onChange={(e) => set({ size: Number(e.target.value) })} />
            </label>

            <div className="cap-field">
              <span>Words at a time</span>
              <div className="seg">
                {([1, 2, 3, 0] as const).map((n) => (
                  <button key={n} className={style.words === n ? 'on' : ''} onClick={() => set({ words: n })}>
                    {n === 0 ? 'Line' : n}
                  </button>
                ))}
              </div>
            </div>
            <div className="cap-field">
              <span>Position</span>
              <div className="seg">
                {SPOTS.map(([label, y]) => (
                  <button key={label} className={Math.abs(style.y - y) < 0.04 && style.x === 0.5 ? 'on' : ''} onClick={() => set({ x: 0.5, y })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="cap-field wide">
              <span>Animation</span>
              <div className="cap-chips">
                {ANIMS.map(([id, label]) => (
                  <button key={id} className={style.anim === id ? 'on' : ''} onClick={() => set({ anim: id })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="cap-field wide">
              <span>Spoken word</span>
              <div className="cap-chips">
                {HIGHLIGHTS.map(([id, label]) => (
                  <button key={id} className={style.highlight === id ? 'on' : ''} onClick={() => set({ highlight: id })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="cap-field">
              <span>Text colour</span>
              <Swatches value={style.color} onPick={(color) => set({ color })} />
            </div>
            <div className="cap-field">
              <span>Highlight colour</span>
              <Swatches value={style.accent} onPick={(accent) => set({ accent })} />
            </div>

            <div className="cap-field wide">
              <span>Effects</span>
              <div className="cap-chips">
                <button className={style.upper ? 'on' : ''} onClick={() => set({ upper: !style.upper })}>
                  UPPERCASE
                </button>
                <button className={style.outline ? 'on' : ''} onClick={() => set({ outline: !style.outline })}>
                  Outline
                </button>
                <button className={style.shadow ? 'on' : ''} onClick={() => set({ shadow: !style.shadow })}>
                  Shadow
                </button>
                <button className={style.glow ? 'on' : ''} onClick={() => set({ glow: !style.glow })}>
                  Glow
                </button>
                <button className={style.backing !== 'none' ? 'on' : ''} onClick={() => set({ backing: style.backing === 'none' ? 'rows' : style.backing === 'rows' ? 'block' : 'none' })}>
                  {style.backing === 'block' ? 'Background: one box' : 'Background'}
                </button>
                <button className={style.blend ? 'on' : ''} onClick={() => set({ blend: !style.blend })} title="The text inverts the picture behind it">
                  Blend
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Swatches({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="cap-swatches">
      {SWATCHES.map((c) => (
        <button key={c} className={value.toLowerCase() === c ? 'on' : ''} style={{ background: c }} onClick={() => onPick(c)} aria-label={c} />
      ))}
      <label className="cap-custom" title="Any colour">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  );
}
