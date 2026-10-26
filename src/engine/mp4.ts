/**
 * Minimal, dependency-free MP4 writer (ISO BMFF, "faststart": moov before mdat).
 * Video: H.264 (avcC from WebCodecs decoderConfig.description) or VP9 (vpcC).
 * Audio: AAC (esds) or Opus (dOps).
 */

export interface MuxSample {
  data: Uint8Array;
  ts: number; // µs
  dur: number; // µs
  key: boolean;
}

export interface MuxVideo {
  codec: string; // avc1.* | vp09.*
  width: number;
  height: number;
  description?: AllowSharedBufferSource;
  samples: MuxSample[];
}

export interface MuxAudio {
  codec: 'aac' | 'opus';
  sampleRate: number;
  channels: number;
  description?: AllowSharedBufferSource;
  samples: MuxSample[];
}

const enc = new TextEncoder();

class W {
  parts: Uint8Array[] = [];
  len = 0;
  u8(v: number) {
    return this.bytes(new Uint8Array([v & 255]));
  }
  u16(v: number) {
    return this.bytes(new Uint8Array([(v >> 8) & 255, v & 255]));
  }
  u24(v: number) {
    return this.bytes(new Uint8Array([(v >> 16) & 255, (v >> 8) & 255, v & 255]));
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0);
    return this.bytes(b);
  }
  i16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, v);
    return this.bytes(b);
  }
  str(s: string) {
    return this.bytes(enc.encode(s));
  }
  zeros(n: number) {
    return this.bytes(new Uint8Array(n));
  }
  bytes(b: Uint8Array) {
    this.parts.push(b);
    this.len += b.length;
    return this;
  }
  out() {
    const o = new Uint8Array(this.len);
    let p = 0;
    for (const b of this.parts) {
      o.set(b, p);
      p += b.length;
    }
    return o;
  }
}

const toU8 = (b?: AllowSharedBufferSource): Uint8Array =>
  !b ? new Uint8Array(0) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b as ArrayBuffer);

function box(type: string, ...content: Uint8Array[]) {
  const w = new W();
  const size = 8 + content.reduce((a, c) => a + c.length, 0);
  w.u32(size).str(type);
  content.forEach((c) => w.bytes(c));
  return w.out();
}

function full(type: string, version: number, flags: number, ...content: Uint8Array[]) {
  const h = new W().u8(version).u24(flags).out();
  return box(type, h, ...content);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function matrix() {
  const w = new W();
  MATRIX.forEach((v) => w.u32(v));
  return w.out();
}

interface Track {
  kind: 'vide' | 'soun';
  id: number;
  timescale: number;
  durations: number[]; // in timescale units
  sizes: number[];
  keys: boolean[];
  offsets: number[];
  entry: Uint8Array; // stsd sample entry
  width: number;
  height: number;
}

function stbl(t: Track) {
  // stts: run-length encoded durations
  const runs: [number, number][] = [];
  for (const d of t.durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  const stts = new W().u32(runs.length);
  runs.forEach(([c, d]) => stts.u32(c).u32(d));
  const stsc = new W().u32(1).u32(1).u32(1).u32(1);
  const stsz = new W().u32(0).u32(t.sizes.length);
  t.sizes.forEach((s) => stsz.u32(s));
  const stco = new W().u32(t.offsets.length);
  t.offsets.forEach((o) => stco.u32(o));
  const parts = [
    full('stsd', 0, 0, new W().u32(1).out(), t.entry),
    full('stts', 0, 0, stts.out()),
  ];
  if (t.kind === 'vide' && t.keys.some((k) => !k)) {
    const keyIdx = t.keys.map((k, i) => (k ? i + 1 : 0)).filter(Boolean);
    const stss = new W().u32(keyIdx.length);
    keyIdx.forEach((i) => stss.u32(i));
    parts.push(full('stss', 0, 0, stss.out()));
  }
  parts.push(full('stsc', 0, 0, stsc.out()), full('stsz', 0, 0, stsz.out()), full('stco', 0, 0, stco.out()));
  return box('stbl', ...parts);
}

function trak(t: Track, movieDur: number) {
  const mediaDur = t.durations.reduce((a, b) => a + b, 0);
  const tkhd = new W()
    .u32(0)
    .u32(0)
    .u32(t.id)
    .u32(0)
    .u32(movieDur)
    .zeros(8)
    .u16(0)
    .u16(0)
    .u16(t.kind === 'soun' ? 0x0100 : 0)
    .u16(0)
    .bytes(matrix())
    .u32(t.width << 16)
    .u32(t.height << 16)
    .out();
  const mdhd = new W().u32(0).u32(0).u32(t.timescale).u32(mediaDur).u16(0x55c4).u16(0).out();
  const name = t.kind === 'vide' ? 'Take1 Video' : 'Take1 Audio';
  const hdlr = new W().u32(0).str(t.kind).zeros(12).str(name).u8(0).out();
  const mhd = t.kind === 'vide' ? full('vmhd', 0, 1, new W().zeros(8).out()) : full('smhd', 0, 0, new W().zeros(4).out());
  const dinf = box('dinf', full('dref', 0, 0, new W().u32(1).out(), full('url ', 0, 1)));
  return box(
    'trak',
    full('tkhd', 0, 3, tkhd),
    box('mdia', full('mdhd', 0, 0, mdhd), full('hdlr', 0, 0, hdlr), box('minf', mhd, dinf, stbl(t))),
  );
}

function visualEntry(type: string, width: number, height: number, config: Uint8Array) {
  const w = new W()
    .zeros(6)
    .u16(1)
    .u16(0)
    .u16(0)
    .zeros(12)
    .u16(width)
    .u16(height)
    .u32(0x00480000)
    .u32(0x00480000)
    .u32(0)
    .u16(1)
    .zeros(32)
    .u16(0x0018)
    .i16(-1)
    .bytes(config);
  return box(type, w.out());
}

function vpcC(codec: string) {
  // vp09.PP.LL.DD[.CC.cp.tc.mc.FF]
  const p = codec.split('.').map((x) => parseInt(x, 10));
  const profile = p[1] || 0;
  const level = p[2] || 10;
  const depth = p[3] || 8;
  const chroma = isNaN(p[4]) ? 1 : p[4];
  const prim = isNaN(p[5]) ? 1 : p[5];
  const tc = isNaN(p[6]) ? 1 : p[6];
  const mc = isNaN(p[7]) ? 1 : p[7];
  const range = isNaN(p[8]) ? 0 : p[8];
  const body = new W()
    .u8(profile)
    .u8(level)
    .u8((depth << 4) | (chroma << 1) | range)
    .u8(prim)
    .u8(tc)
    .u8(mc)
    .u16(0)
    .out();
  return full('vpcC', 1, 0, body);
}

function descriptor(tag: number, body: Uint8Array) {
  // expandable size, 4-byte form for safety
  const n = body.length;
  const w = new W().u8(tag).u8(0x80 | ((n >> 21) & 0x7f)).u8(0x80 | ((n >> 14) & 0x7f)).u8(0x80 | ((n >> 7) & 0x7f)).u8(n & 0x7f);
  return w.bytes(body).out();
}

function audioEntry(a: MuxAudio) {
  const base = new W()
    .zeros(6)
    .u16(1)
    .zeros(8)
    .u16(a.channels)
    .u16(16)
    .u16(0)
    .u16(0)
    .u32((a.codec === 'opus' ? 48000 : a.sampleRate) << 16)
    .out();
  if (a.codec === 'aac') {
    const asc = toU8(a.description);
    const dsi = descriptor(0x05, asc);
    const dcd = descriptor(0x04, new W().u8(0x40).u8(0x15).u24(0).u32(128000).u32(128000).bytes(dsi).out());
    const sl = descriptor(0x06, new Uint8Array([0x02]));
    const es = descriptor(0x03, new W().u16(1).u8(0).bytes(dcd).bytes(sl).out());
    return box('mp4a', base, full('esds', 0, 0, es));
  }
  // Opus: dOps from the OpusHead WebCodecs gives us (little-endian), written big-endian
  const head = toU8(a.description);
  let preSkip = 312;
  if (head.length >= 12 && String.fromCharCode(...head.slice(0, 8)) === 'OpusHead') preSkip = head[10] | (head[11] << 8);
  const dops = new W().u8(0).u8(a.channels).u16(preSkip).u32(a.sampleRate).i16(0).u8(0).out();
  return box('Opus', base, box('dOps', dops));
}

/** Build a complete MP4 file in memory. */
export function muxMp4(video: MuxVideo | null, audio: MuxAudio | null): Blob {
  const MOVIE_TS = 1000;
  const tracks: Track[] = [];
  const payloads: Uint8Array[][] = [];

  if (video && video.samples.length) {
    const ts = 90000;
    const t0 = video.samples[0].ts;
    const s = video.samples;
    const durations = s.map((x, i) => {
      const next = i + 1 < s.length ? s[i + 1].ts : x.ts + (x.dur || 33333);
      return Math.max(1, Math.round(((next - x.ts) * ts) / 1e6));
    });
    void t0;
    const entry = video.codec.startsWith('avc')
      ? visualEntry('avc1', video.width, video.height, box('avcC', toU8(video.description)))
      : visualEntry('vp09', video.width, video.height, vpcC(video.codec));
    tracks.push({
      kind: 'vide',
      id: tracks.length + 1,
      timescale: ts,
      durations,
      sizes: s.map((x) => x.data.length),
      keys: s.map((x) => x.key),
      offsets: [],
      entry,
      width: video.width,
      height: video.height,
    });
    payloads.push(s.map((x) => x.data));
  }

  if (audio && audio.samples.length) {
    const ts = audio.codec === 'opus' ? 48000 : audio.sampleRate;
    const s = audio.samples;
    const durations = s.map((x) => Math.max(1, Math.round((x.dur * ts) / 1e6)));
    tracks.push({
      kind: 'soun',
      id: tracks.length + 1,
      timescale: ts,
      durations,
      sizes: s.map((x) => x.data.length),
      keys: s.map(() => true),
      offsets: [],
      entry: audioEntry(audio),
      width: 0,
      height: 0,
    });
    payloads.push(s.map((x) => x.data));
  }

  const movieDur = Math.max(
    0,
    ...tracks.map((t) => Math.round((t.durations.reduce((a, b) => a + b, 0) / t.timescale) * MOVIE_TS)),
  );

  const ftyp = box('ftyp', new W().str('isom').u32(0x200).str('isomiso2avc1mp41').out());

  const buildMoov = () => {
    const mvhd = new W()
      .u32(0)
      .u32(0)
      .u32(MOVIE_TS)
      .u32(movieDur)
      .u32(0x00010000)
      .u16(0x0100)
      .zeros(10)
      .bytes(matrix())
      .zeros(24)
      .u32(tracks.length + 1)
      .out();
    return box('moov', full('mvhd', 0, 0, mvhd), ...tracks.map((t) => trak(t, movieDur)));
  };

  // pass 1: size the moov with placeholder offsets, pass 2: real offsets
  tracks.forEach((t) => (t.offsets = t.sizes.map(() => 0)));
  const moovSize = buildMoov().length;
  let pos = ftyp.length + moovSize + 8;
  tracks.forEach((t) => {
    t.offsets = t.sizes.map((sz) => {
      const o = pos;
      pos += sz;
      return o;
    });
  });
  const moov = buildMoov();
  const mdatLen = 8 + payloads.flat().reduce((a, b) => a + b.length, 0);
  const mdatHead = new W().u32(mdatLen).str('mdat').out();
  return new Blob([ftyp, moov, mdatHead, ...payloads.flat()] as BlobPart[], { type: 'video/mp4' });
}
