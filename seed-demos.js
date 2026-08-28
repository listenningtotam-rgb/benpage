#!/usr/bin/env node
"use strict";
/* ── seed-demos.js ─────────────────────────────────────────────────
 * Generates deterministic demo tracks for 编曲工坊 into public/demo-tracks/.
 * Each track has a KNOWN tempo & key so the arrange-lib tests can assert
 * analyzePcm(BPM, key) within tolerance:
 *   demo-folk-90-A.wav     90 BPM · A major · quiet intro / main / outro
 *   demo-ballad-70-F.wav   70 BPM · F major · quiet intro / main / outro
 *   demo-pop-120-C.wav    120 BPM · C major · intro / full / breakdown / outro
 * Content: soft metronome clicks (beat + downbeat) + a vibrato sine melody
 * from the key's major pentatonic. All mono, 22050 Hz, 16-bit PCM.
 */
const fs = require("node:fs");
const path = require("node:path");

const RATE = 22050;
const OUT_DIR = path.join(__dirname, "public", "demo-tracks");

const PENT = { A: [0, 2, 4, 7, 9], F: [0, 2, 4, 7, 9], C: [0, 2, 4, 7, 9] }; // degree → semitones above tonic
const BASE_MIDI = { A: 69, F: 65, C: 60 }; // A4, F4, C4

function encodeMonoWav(samples) {
  const n = samples.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    buf.writeInt16LE(s, 44 + i * 2);
  }
  return buf;
}

/* Bounce a melodic idea onto the sample buffer.
 * melody: array of [bar, step16th, degree (index into pentatonic), dur16ths] */
function renderDemo(opts) {
  const { bpm, tonic, bars, sections, melody } = opts;
  const beat = 60 / bpm;
  const step = beat / 4;
  const barLen = beat * 4;
  const n = Math.ceil(bars * barLen * RATE);
  const out = new Float32Array(n);
  const scale = PENT[tonic];
  const base = BASE_MIDI[tonic];
  const addNote = (startSec, degree, durSec, gain) => {
    const midi = base + scale[degree % scale.length] + (degree >= scale.length ? 12 : 0);
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const s0 = Math.floor(startSec * RATE);
    const len = Math.floor(durSec * RATE);
    const atk = Math.floor(0.02 * RATE);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const t = i / RATE;
      const env = i < atk ? i / atk : Math.exp(-(t - 0.02) * 1.1);
      const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 5.2 * t);
      out[s0 + i] += Math.sin(2 * Math.PI * freq * vib * t) * env * gain;
    }
  };
  const addClick = (startSec, downbeat, gain) => {
    const freq = downbeat ? 700 : 1200;
    const s0 = Math.floor(startSec * RATE);
    const len = Math.floor(0.045 * RATE);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const t = i / RATE;
      out[s0 + i] += Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 90) * gain;
    }
  };
  // bounce clicks + melody into the sample buffer
  const barGain = new Array(bars).fill({ mel: 0.5, click: 0.12 });
  for (const s of sections) for (let b = s.from; b < s.to; b++) barGain[b] = s.gain;
  for (let b = 0; b < bars; b++) {
    const g = barGain[b];
    const barStart = b * barLen;
    for (let beatN = 0; beatN < 4; beatN++) addClick(barStart + beatN * beat, beatN === 0, g.click);
    for (const ev of melody) {
      if (ev[0] !== b) continue;
      const start = barStart + ev[1] * step;
      // accent beats (step % 4 === 0) so the beat period dominates the flux
      addNote(start, ev[2], ev[3] * step * 0.95, g.mel * (ev[1] % 4 === 0 ? 1 : 0.62));
    }
  }
  const fade = Math.floor(0.4 * RATE);
  for (let i = Math.max(0, n - fade); i < n; i++) out[i] *= (n - i) / fade;
  return out;
}

/* repeat(pat, startBar, count): expand a 2-bar pattern into explicit bars.
 * pat entries are [step, degree, dur16ths]; repeated bars get startBar + 2r. */
function repeat(pat, startBar, count) {
  const out = [];
  for (let r = 0; r < count; r++) for (const e of pat) out.push([startBar + r * 2, e[0], e[1], e[2]]);
  return out;
}


const DEMOS = [
  {
    name: "demo-folk-90-A.wav", bpm: 90, tonic: "A", bars: 12,
    sections: [
      { from: 0, to: 2, gain: { mel: 0.3, click: 0.05 } },
      { from: 2, to: 10, gain: { mel: 0.5, click: 0.12 } },
      { from: 10, to: 12, gain: { mel: 0.3, click: 0.05 } },
    ],
    melody: repeat([
      // A: A C# E A'  →   E C# A(hold)
      [0, 0, 2], [4, 2, 2], [8, 3, 2], [12, 5, 2],
      [0, 3, 2], [4, 2, 2], [8, 0, 4],
    ], 0, 6),
  },
  {
    name: "demo-ballad-70-F.wav", bpm: 70, tonic: "F", bars: 10,
    sections: [
      { from: 0, to: 2, gain: { mel: 0.3, click: 0.04 } },
      { from: 2, to: 8, gain: { mel: 0.5, click: 0.1 } },
      { from: 8, to: 10, gain: { mel: 0.3, click: 0.04 } },
    ],
    melody: repeat([
      // F(hold) C A  →  A C F(hold) — tonic F dominates the line
      [0, 0, 5], [8, 3, 3], [12, 2, 3],
      [0, 2, 3], [4, 3, 3], [8, 0, 5],
    ], 0, 5),
  },
  {
    name: "demo-pop-120-C.wav", bpm: 120, tonic: "C", bars: 12,
    sections: [
      { from: 0, to: 2, gain: { mel: 0.32, click: 0.06 } },
      { from: 2, to: 8, gain: { mel: 0.5, click: 0.14 } },
      { from: 8, to: 10, gain: { mel: 0.32, click: 0.06 } }, // breakdown
      { from: 10, to: 12, gain: { mel: 0.5, click: 0.14 } },
    ],
    melody: repeat([
      // 8ths: C E G A  G E D C  →  E G C' G  A E C' A
      [0, 0, 1], [2, 2, 1], [4, 3, 1], [6, 4, 1], [8, 3, 1], [10, 2, 1], [12, 1, 1], [14, 0, 1],
      [0, 2, 1], [2, 3, 1], [4, 5, 1], [6, 3, 1], [8, 4, 1], [10, 2, 1], [12, 5, 1], [14, 4, 1],
    ], 0, 6),
  },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const spec of DEMOS) {
  const samples = renderDemo(spec);
  const wav = encodeMonoWav(samples);
  const file = path.join(OUT_DIR, spec.name);
  fs.writeFileSync(file, wav);
  const dur = samples.length / RATE;
  console.log(`${spec.name}  ${dur.toFixed(1)}s  ${(wav.length / 1024).toFixed(0)}KB  (${spec.bpm} BPM · ${spec.tonic})`);
}
console.log("done");

