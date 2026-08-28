/* ── 编曲工坊 Arranger — pure DSP + arrangement logic ─────────────
 * Shared browser/Node module:
 *   browser → window.ArrangeLib   (loaded before arrange.js)
 *   node    → require("./public/arrange-lib.js")
 *
 * Everything here is pure sample / string math (no DOM, no AudioContext),
 * so the whole pipeline — analyzePcm → parseDescription → buildArrangement
 * → synthArrange → encodeWavStereo — runs identically in Node and in the
 * browser, which is exactly what the seeded-demo tests rely on.
 *   - analyzePcm        : tempo (flux autocorrelation), key (chroma +
 *                         Krumhansl–Schmuckler), section segmentation.
 *   - parseDescription  : CN/EN genre · mood · density · instrument maps.
 *   - buildArrangement  : genre template → per-section layer spec + chords.
 *   - synthArrange      : pure-JS software synth → stereo Float32 buffers.
 *   - encodeWavStereo   : 16-bit PCM stereo WAV bytes.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ArrangeLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ── Tuning helpers ─────────────────────────────────────────── */
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const noteFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  /* Radix-2 iterative FFT in place (re/im are Float64Array, length 2^k). */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }
  /* ── analyzePcm(mono:Float32Array, sampleRate) ──────────────── */
  function analyzePcm(mono, sampleRate) {
    const n = mono.length;
    if (!n || !sampleRate) throw new Error("analyzePcm: need samples + sampleRate");
    const duration = n / sampleRate;

    /* RMS energy envelope — 1024-sample frames, 512 hop (≈86 fps @44.1k) */
    const FRAME = 1024, HOP = 512;
    const nFrames = Math.max(1, Math.floor((n - FRAME) / HOP) + 1);
    if (nFrames < 20) {
      // Too short to analyze reliably — return sane defaults rather than NaN.
      return {
        sampleRate, duration,
        bpm: 100, bpmConfidence: 0,
        keyName: "C", keyMode: "major", keyPitchClass: 0, keyConfidence: 0,
        sections: [{ label: "整曲 Full", start: 0, end: duration, level: 1, bars: 1 }],
        loudness: 0, brightness: 0.5,
      };
    }
    const rms = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      const off = f * HOP;
      let e = 0;
      for (let i = 0; i < FRAME; i++) {
        const s = mono[off + i] || 0;
        e += s * s;
      }
      rms[f] = Math.sqrt(e / FRAME);
    }
    let rmsMeanSq = 0;
    const env = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let s = 0, c = 0;
      for (let w = Math.max(0, f - 5); w <= Math.min(nFrames - 1, f + 5); w++) { s += rms[w]; c++; }
      env[f] = s / c;
      rmsMeanSq += rms[f] * rms[f];
    }
    const frameRate = sampleRate / HOP;

    /* ── Tempo: autocorrelation of positive energy flux ────────── */
    const flux = new Float32Array(nFrames);
    let fmax = 1e-9;
    for (let f = 1; f < nFrames; f++) {
      flux[f] = Math.max(0, env[f] - env[f - 1]);
      if (flux[f] > fmax) fmax = flux[f];
    }
    for (let f = 0; f < nFrames; f++) flux[f] /= fmax;
    const corrAt = (lag) => {
      let num = 0, da = 0, db = 0;
      for (let f = 0; f + lag < nFrames; f++) {
        const a = flux[f], b = flux[f + lag];
        num += a * b; da += a * a; db += b * b;
      }
      return num / (Math.sqrt(da * db) + 1e-9);
    };
    let bestLag = 0, bestCorr = -1;
    for (let lag = Math.max(3, Math.floor((frameRate * 60) / 190));
         lag <= Math.min(nFrames - 3, Math.ceil((frameRate * 60) / 50)); lag++) {
      const c = corrAt(lag);
      if (c > bestCorr) { bestCorr = c; bestLag = lag; }
    }
    // Disambiguate octave/subdivision: prefer the candidate inside the
    // musical 62–178 BPM window with the strongest autocorrelation.
    let tempo = { bpm: (60 * frameRate) / bestLag, corr: bestCorr };
    const cands = [];
    for (const m of [1, 2, 0.5, 1.5, 2 / 3, 3]) {
      const lag = Math.max(3, Math.round(bestLag * m));
      const b = (60 * frameRate) / lag;
      if (b >= 50 && b <= 190 && lag < nFrames - 2) cands.push({ bpm: b, corr: corrAt(lag) });
    }
    cands.sort((a, b) => b.corr - a.corr);
    for (const c of cands) if (c.bpm >= 62 && c.bpm <= 178) { tempo = c; break; }
    const bpm = Math.round(tempo.bpm * 10) / 10;
    const bpmConfidence = clamp01((tempo.corr - 0.05) / 0.45);

    /* ── Key: chroma frames + Krumhansl–Schmuckler ─────────────── */
    const FFT_SIZE = 8192, HOP2 = 2048;
    const nF = Math.max(1, Math.floor((n - FFT_SIZE) / HOP2) + 1);
    const chromaFrames = [];
    let frameMax = 0;
    let centNum = 0, centDen = 0;
    const nyq = sampleRate / 2;
    for (let f = 0; f < nF; f++) {
      const off = f * HOP2;
      const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
      for (let i = 0; i < FFT_SIZE; i++) {
        const s = mono[off + i] || 0;
        re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
      }
      fft(re, im);
      const c = new Float64Array(12);
      let magSum = 0;
      for (let k = 1; k < FFT_SIZE / 2; k++) {
        const freq = (k * sampleRate) / FFT_SIZE;
        if (freq < 60 || freq > 4200) continue;
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const pc = Math.round(12 * Math.log2(freq / 440) + 9);
        c[((pc % 12) + 12) % 12] += mag;
        magSum += mag;
        centNum += (freq / nyq) * mag;
      }
      centDen += magSum;
      if (magSum > frameMax) frameMax = magSum;
      chromaFrames.push({ c, magSum });
    }
    const chromaTotal = new Float64Array(12);
    for (const fr of chromaFrames) {
      if (fr.magSum < frameMax * 0.02) continue; // drop silence / noise floor
      for (let p = 0; p < 12; p++) chromaTotal[p] += fr.c[p] / fr.magSum;
    }
    const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const correlate = (a, b) => {
      let ma = 0, mb = 0;
      for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
      ma /= 12; mb /= 12;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < 12; i++) {
        const x = a[i] - ma, y = b[i] - mb;
        num += x * y; da += x * x; db += y * y;
      }
      return num / (Math.sqrt(da * db) + 1e-9);
    };
    let keyBest = { corr: -2, pc: 0, mode: "major" };
    let bestMajor = { corr: -2, pc: 0 };
    for (let t = 0; t < 12; t++) {
      for (const mode of ["major", "minor"]) {
        const profile = mode === "major" ? MAJOR : MINOR;
        const shifted = new Array(12);
        for (let p = 0; p < 12; p++) shifted[p] = profile[((p - t) % 12 + 12) % 12];
        const corr = correlate(chromaTotal, shifted);
        if (mode === "major" && corr > bestMajor.corr) bestMajor = { corr, pc: t };
        if (corr > keyBest.corr) keyBest = { corr, pc: t, mode };
      }
    }
    // Relative major/minor ambiguity: pentatonic melodies share the same
    // pitch set, so the K–S gap is marginal. Prefer the major reading when
    // the minor lead is tiny — most commercial music is major.
    if (keyBest.mode === "minor" && keyBest.corr - bestMajor.corr < 0.02) {
      keyBest = { corr: bestMajor.corr, pc: bestMajor.pc, mode: "major" };
    }
    const keyConfidence = clamp01((keyBest.corr - 0.25) / 0.55);


    /* ── Sections: 0.5s-window energy levels, merged into runs ── */
    const winLen = Math.floor(sampleRate * 0.5);
    const winSec = winLen / sampleRate;
    const nWin = Math.max(1, Math.floor(n / winLen));
    const winE = new Float64Array(nWin);
    for (let w = 0; w < nWin; w++) {
      const off = w * winLen;
      const cnt = Math.min(winLen, n - off);
      let e = 0;
      for (let i = 0; i < cnt; i++) { const s = mono[off + i]; e += s * s; }
      winE[w] = Math.sqrt(e / cnt);
    }
    const sorted = Array.from(winE).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 0;
    const loTh = med * 0.6, hiTh = med * 1.7;
    const levels = Array.from(winE, (e) => (e < loTh ? 0 : e > hiTh ? 2 : 1));
    const runs = [];
    for (let w = 0; w < nWin; w++) {
      const last = runs[runs.length - 1];
      if (last && last.level === levels[w]) last.end = w + 1;
      else runs.push({ level: levels[w], start: w, end: w + 1 });
    }
    const merged = [];
    for (const r of runs) {
      const prev = merged[merged.length - 1];
      if (prev && r.end - r.start < 6) { prev.level = Math.max(prev.level, r.level); prev.end = r.end; }
      else merged.push({ level: r.level, start: r.start, end: r.end });
    }
    const sections = [];
    const mkSection = (label, start, end, level) =>
      sections.push({ label, start, end, level, bars: Math.max(1, Math.round(((end - start) / 60) * bpm / 4)) });
    if (merged.length <= 1) {
      mkSection("整曲 Full", 0, duration, merged[0] ? merged[0].level : 1);
    } else {
      const maxLevel = Math.max(...merged.map((r) => r.level));
      let verseCount = 0;
      merged.forEach((r, i) => {
        const start = r.start * winSec, end = r.end * winSec;
        let label;
        if (i === 0) label = r.level === 0 ? "前奏 Intro" : "主歌 Verse";
        else if (i === merged.length - 1) label = r.level === 0 ? "尾奏 Outro" : "尾声 Outro";
        else if (r.level === maxLevel && r.level >= 2) label = "副歌 Chorus";
        else if (r.level === 0) label = "间奏 Interlude";
        else label = "主歌 Verse" + (++verseCount > 1 ? verseCount : "");
        mkSection(label, start, end, r.level);
      });
    }

    return {
      sampleRate,
      duration,
      bpm,
      bpmConfidence,
      keyName: NOTE_NAMES[keyBest.pc],
      keyMode: keyBest.mode,
      keyPitchClass: keyBest.pc,
      keyConfidence,
      sections,
      loudness: 20 * Math.log10(Math.sqrt(rmsMeanSq / nFrames) + 1e-9),
      brightness: centDen > 0 ? clamp01(centNum / centDen) : 0.5,
    };
  }



  /* ── parseDescription(text) → directives ────────────────────── */
  const GENRE_KEYS = [
    { genre: "folk", label: "民谣", keys: ["民谣", "folk", "acoustic", "木吉他"] },
    { genre: "pop", label: "流行", keys: ["流行", "pop"] },
    { genre: "rock", label: "摇滚", keys: ["摇滚", "rock"] },
    { genre: "jazz", label: "爵士", keys: ["爵士", "jazz"] },
    { genre: "edm", label: "电子", keys: ["电子", "电音", "edm", "techno", "trance"] },
    { genre: "classical", label: "古典", keys: ["古典", "classical", "交响", "管弦"] },
    { genre: "hiphop", label: "嘻哈", keys: ["嘻哈", "说唱", "rap", "hip"] },
    { genre: "blues", label: "布鲁斯", keys: ["布鲁斯", "蓝调", "blues"] },
    { genre: "ambient", label: "氛围", keys: ["轻音乐", "氛围", "ambient", "new age"] },
    { genre: "reggae", label: "雷鬼", keys: ["雷鬼", "reggae"] },
    { genre: "guofeng", label: "古风", keys: ["古风", "国风", "中国风"] },
    { genre: "rnb", label: "R&B", keys: ["r&b", "rnb", "节奏布鲁斯"] },
  ];
  const MOOD_KEYS = [
    { mood: "sad", label: "悲伤", keys: ["悲伤", "忧郁", "难过", "伤", "sad", "melancholy"] },
    { mood: "upbeat", label: "欢快", keys: ["欢快", "活泼", "轻快", "跳跃", "upbeat", "lively", "happy"] },
    { mood: "epic", label: "大气", keys: ["大气", "史诗", "燃", "激昂", "epic", "grand", "heroic"] },
    { mood: "warm", label: "温暖", keys: ["温暖", "温馨", "暖", "warm", "cozy"] },
    { mood: "laidback", label: "慵懒", keys: ["慵懒", "松弛", "放松", "chill", "laid", "relaxed"] },
    { mood: "quiet", label: "安静", keys: ["安静", "宁静", "静谧", "quiet", "peaceful"] },
    { mood: "romantic", label: "浪漫", keys: ["浪漫", "romantic"] },
    { mood: "nostalgic", label: "怀旧", keys: ["怀旧", "复古", "nostalgic", "retro"] },
    { mood: "dreamy", label: "梦幻", keys: ["梦幻", "缥缈", "dreamy", "ethereal"] },
  ];
  const DENSITY_KEYS = [
    { density: "minimal", keys: ["简约", "极简", "简单", "留白", "minimal", "sparse"] },
    { density: "full", keys: ["饱满", "丰富", "华丽", "厚重", "full", "rich", "lush", "big"] },
  ];


  const INST_KEYS = [
    { inst: "piano", label: "钢琴", keys: ["钢琴", "piano"] },
    { inst: "guitar", label: "木吉他", keys: ["木吉他", "原声吉他", "acoustic guitar"] },
    { inst: "electric-guitar", label: "电吉他", keys: ["电吉他", "electric guitar", "distortion"] },
    { inst: "strings", label: "弦乐", keys: ["弦乐", "小提琴", "大提琴", "violin", "cello", "strings"] },
    { inst: "bass", label: "贝斯", keys: ["贝斯", "bass"] },
    { inst: "drums", label: "鼓", keys: ["鼓", "打击乐", "drums", "percussion"] },
    { inst: "erhu", label: "二胡", keys: ["二胡", "erhu"] },
    { inst: "guzheng", label: "古筝", keys: ["古筝", "guzheng"] },
    { inst: "flute", label: "笛子", keys: ["笛子", "长笛", "竹笛", "flute"] },
    { inst: "organ", label: "风琴", keys: ["风琴", "管风琴", "organ"] },
    { inst: "brass", label: "管乐", keys: ["管乐", "铜管", "小号", "萨克斯", "trumpet", "sax", "brass"] },
    { inst: "choir", label: "人声和声", keys: ["人声", "和声", "合唱", "choir"] },
  ];
  const STOPWORDS = new Set([
    "的", "了", "和", "与", "及", "在", "是", "要", "想", "希望", "风格", "编曲", "伴奏", "一些", "加入", "加上",
    "有", "用", "来", "点", "比较", "很", "最", "都", "就", "让", "会", "可以", "请", "一点", "适当", "不要", "别",
    "a", "an", "the", "with", "and", "for", "make", "it", "on", "in", "some", "very", "please", "want", "of", "to", "my",
  ]);
  function parseDescription(text) {
    const raw = String(text || "");
    const lower = raw.toLowerCase();
    const en = lower.replace(/[^a-z0-9#&]+/g, " ").split(/\s+/).filter(Boolean);
    const has = (k) => (/[\u4e00-\u9fff]/.test(k) ? lower.includes(k) : en.includes(k));
    const genre = GENRE_KEYS.find((g) => g.keys.some(has)) || null;
    const moods = MOOD_KEYS.filter((m) => m.keys.some(has)).map((m) => m.mood);
    const density = (DENSITY_KEYS.find((d) => d.keys.some(has)) || {}).density || null;
    const instruments = INST_KEYS.filter((i) => i.keys.some(has)).map((i) => i.inst);
    let tempoHint = null;
    if (/(慢|抒情|舒缓|轻柔|slow|ballad|gentle)/.test(lower)) tempoHint = "slow";
    else if (/(快|动感|燃|加速|fast|upbeat|drive)/.test(lower)) tempoHint = "fast";
    // unknown words (passthrough): EN words + CN phrases not matched anywhere
    const known = new Set([
      ...GENRE_KEYS.flatMap((g) => g.keys), ...MOOD_KEYS.flatMap((m) => m.keys),
      ...DENSITY_KEYS.flatMap((d) => d.keys), ...INST_KEYS.flatMap((i) => i.keys),
    ]);
    const unknown = [];
    for (const w of en) if (!STOPWORDS.has(w) && !known.has(w) && w.length >= 2) unknown.push(w);
    const cnKnown = [...known].filter((k) => /[\u4e00-\u9fff]/.test(k));
    for (const token of raw.split(/[，。！？、；：\s]+/)) {
      if (!token) continue;
      if (!/[\u4e00-\u9fff]/.test(token)) continue;
      if (known.has(token) || STOPWORDS.has(token)) continue;
      if (cnKnown.some((k) => token.includes(k))) continue; // phrase already parsed via a keyword
      if (token.length >= 2) unknown.push(token);
    }
    return {
      genre: genre ? genre.genre : null,
      genreLabel: genre ? genre.label : null,
      moods, density, instruments, tempoHint,
      unknown: Array.from(new Set(unknown)).slice(0, 8),
    };
  }

  /* ── buildArrangement(features, directives) ─────────────────── */
  // Chord vocabulary: numerals → scale-degree offset (both cases per mode).
  const DEG_MAJOR = {
    I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11,
    i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11,
  };
  const DEG_MINOR = {
    i: 0, ii: 2, III: 3, iv: 5, v: 7, VI: 8, VII: 10,
    I: 0, II: 2, III: 3, IV: 5, V: 7, VI: 8, VII: 10,
    iii: 3, vi: 8, vii: 10,
  };
  function numeralQuality(num, mode) {
    if (mode === "minor") {
      const l = num.toLowerCase();
      if (l === "ii") return "dim";
      if (l === "i" || l === "iv" || l === "v") return "m";
      return "M";
    }
    const l = num.toLowerCase();
    if (l === "vii") return "dim";
    if (l === "ii" || l === "iii" || l === "vi") return "m";
    return "M";
  }
  const GENRES = {
    folk: { label: "民谣", progression: ["I", "vi", "IV", "V"], swing: false,
      instruments: { drums: true, bass: true, keys: true, pad: false, solo: "pluck" },
      keysRole: "木吉他", soloRole: "拨弦吉他" },
    pop: { label: "流行", progression: ["I", "V", "vi", "IV"], swing: false,
      instruments: { drums: true, bass: true, keys: true, pad: true, solo: null },
      keysRole: "钢琴", soloRole: null },
    rock: { label: "摇滚", progression: ["i", "VI", "III", "VII"], swing: false,
      instruments: { drums: true, bass: true, keys: true, pad: false, solo: null },
      keysRole: "电钢", soloRole: null },
    jazz: { label: "爵士", progression: ["ii", "V", "I", "vi"], swing: true,
      instruments: { drums: true, bass: true, keys: true, pad: false, solo: null },
      keysRole: "钢琴", soloRole: null },
    ballad: { label: "抒情", progression: ["I", "vi", "IV", "V"], swing: false,
      instruments: { drums: true, bass: true, keys: true, pad: true, solo: null },
      keysRole: "钢琴", soloRole: null },
    edm: { label: "电子", progression: ["i", "VI", "III", "VII"], swing: false,
      instruments: { drums: true, bass: true, keys: true, pad: true, solo: null },
      keysRole: "合成器", soloRole: null },
    classical: { label: "古典", progression: ["I", "IV", "V", "I"], swing: false,
      instruments: { drums: false, bass: true, keys: true, pad: true, solo: "flute" },
      keysRole: "钢琴", soloRole: "长笛" },
    hiphop: { label: "嘻哈", progression: ["i", "VI", "III", "VII"], swing: false,
      instruments: { drums: true, bass: true, keys: true, pad: false, solo: null },
      keysRole: "钢琴", soloRole: null },
    blues: { label: "布鲁斯", progression: ["I", "IV", "V", "IV"], swing: true,
      instruments: { drums: true, bass: true, keys: true, pad: false, solo: "pluck" },
      keysRole: "电钢", soloRole: "电吉他" },
    ambient: { label: "氛围", progression: ["i", "VI", "III", "VII"], swing: false,
      instruments: { drums: false, bass: true, keys: false, pad: true, solo: "flute" },
      keysRole: "", soloRole: "长笛" },
    reggae: { label: "雷鬼", progression: ["i", "VII", "i", "VII"], swing: false,
      instruments: { drums: true, bass: true, keys: true, pad: false, solo: null },
      keysRole: "风琴", soloRole: null },
    guofeng: { label: "古风", progression: ["i", "VI", "III", "VII"], swing: false,
      instruments: { drums: true, bass: false, keys: true, pad: true, solo: "erhu" },
      keysRole: "古筝", soloRole: "二胡" },
    rnb: { label: "R&B", progression: ["i", "iv", "VI", "V"], swing: false,
      instruments: { drums: true, bass: true, keys: true, pad: true, solo: null },
      keysRole: "钢琴", soloRole: null },
  };

  const ROLE_ZH = {
    drums: "打击乐", kick: "底鼓", snare: "军鼓", hat: "踩镲", bass: "贝斯",
    keys: "键盘", pad: "弦乐铺底", pluck: "拨弦", flute: "长笛", erhu: "二胡", organ: "风琴",
  };
  const DENSITY_ZH = { light: "轻", medium: "中", full: "满" };
  // User-requested instruments → synth layer (+ role label).
  const EXTRA_LAYERS = {
    piano: { instrument: "keys", role: "钢琴" },
    guitar: { instrument: "pluck", role: "木吉他" },
    "electric-guitar": { instrument: "pluck", role: "电吉他" },
    strings: { instrument: "pad", role: "弦乐" },
    violin: { instrument: "pad", role: "小提琴" },
    cello: { instrument: "pad", role: "大提琴" },
    bass: { instrument: "bass", role: "贝斯" },
    drums: { instrument: "drums", role: "鼓" },
    erhu: { instrument: "erhu", role: "二胡" },
    guzheng: { instrument: "pluck", role: "古筝" },
    flute: { instrument: "flute", role: "笛子" },
    organ: { instrument: "organ", role: "风琴" },
    brass: { instrument: "organ", role: "管乐" },
    choir: { instrument: "pad", role: "人声和声" },
  };
  const chordFor = (numeral, mode, tonicPc) => {
    const table = mode === "minor" ? DEG_MINOR : DEG_MAJOR;
    const offset = table[numeral];
    if (offset === undefined) return { rootPc: tonicPc, quality: "M", numeral };
    return { rootPc: (tonicPc + offset) % 12, quality: numeralQuality(numeral, mode), numeral };
  };
  function layersForSection(sec, tpl, directives, singleSection) {
    const inst = tpl.instruments;
    const layers = [];
    const add = (instrument, role, density) => layers.push({ instrument, role, density });
    // tempoHint "slow" caps density so slow tracks breathe.
    const cap = (d) => (directives.tempoHint === "slow" && d === "full" ? "medium" : d);
    if (singleSection) {
      if (inst.drums) add("drums", ROLE_ZH.drums, cap("medium"));
      if (inst.bass) add("bass", ROLE_ZH.bass, cap("medium"));
      if (inst.keys) add("keys", tpl.keysRole || ROLE_ZH.keys, cap("medium"));
      if (inst.pad) add("pad", ROLE_ZH.pad, cap("full"));
      if (inst.solo) add(inst.solo, tpl.soloRole, cap("medium"));
    } else {
      const level = sec.level;
      if (level <= 0) {
        if (inst.keys) add("keys", tpl.keysRole || ROLE_ZH.keys, "light");
        if (inst.pad) add("pad", ROLE_ZH.pad, "light");
      } else if (level === 1) {
        if (inst.drums) add("drums", ROLE_ZH.drums, cap("medium"));
        if (inst.bass) add("bass", ROLE_ZH.bass, cap("medium"));
        if (inst.keys) add("keys", tpl.keysRole || ROLE_ZH.keys, cap("medium"));
        if (inst.pad) add("pad", ROLE_ZH.pad, "light");
        if (inst.solo) add(inst.solo, tpl.soloRole, "light");
      } else {
        if (inst.drums) add("drums", ROLE_ZH.drums, cap("full"));
        if (inst.bass) add("bass", ROLE_ZH.bass, cap("full"));
        if (inst.keys) add("keys", tpl.keysRole || ROLE_ZH.keys, cap("full"));
        if (inst.pad) add("pad", ROLE_ZH.pad, cap("medium"));
        if (inst.solo) add(inst.solo, tpl.soloRole, cap("medium"));
      }
    }
    // merge user-requested instruments
    for (const req of directives.instruments || []) {
      const layer = EXTRA_LAYERS[req];
      if (!layer) continue;
      if (!layers.some((l) => l.instrument === layer.instrument)) {
        layers.push({ instrument: layer.instrument, role: layer.role, density: "medium" });
      }
    }
    if (directives.density === "minimal") {
      layers.forEach((l) => { if (l.instrument !== "keys" && l.instrument !== "pad") l.density = "light"; });
    }
    return layers;
  }
  function buildArrangement(features, directives) {
    const d = directives || {};
    const mode = features.keyMode === "minor" ? "minor" : "major";
    const tonicPc = clamp(Math.round(features.keyPitchClass || 0), 0, 11);
    const bpm = clamp(features.bpm || 100, 40, 240);
    const genreId = d.genre && GENRES[d.genre] ? d.genre : "pop";
    const tpl = GENRES[genreId];
    // If the detected mode is minor but the template was written in major
    // numerals (and vice versa), translate the numerals so chords land on
    // the same scale degrees.
    const M2m = { I: "i", II: "ii", III: "III", IV: "iv", V: "v", VI: "VI", VII: "VII" };
    const m2M = { i: "I", ii: "ii", III: "III", iv: "iv", v: "v", VI: "VI", VII: "VII" };
    const numerals = tpl.progression.map((num) => (mode === "minor" ? M2m[num] || num : m2M[num] || num));
    const progression = numerals.map((num) => chordFor(num, mode, tonicPc));
    const singleSection = features.sections.length <= 1;
    const sections = features.sections.map((sec) => ({
      label: sec.label, start: sec.start, end: sec.end, level: sec.level, bars: sec.bars,
      layers: layersForSection(sec, tpl, d, singleSection),
    }));
    return {
      keyName: NOTE_NAMES[tonicPc],
      keyMode: mode,
      bpm,
      genre: genreId,
      genreLabel: tpl.label,
      density: d.density || (singleSection ? "medium" : "auto"),
      moods: d.moods || [],
      tempoHint: d.tempoHint || null,
      unknown: d.unknown || [],
      progression,
      sections,
      // flat list of all instruments used (for the legend)
      instruments: Array.from(new Set(sections.flatMap((s) => s.layers.map((l) => l.instrument)))),
    };
  }


  /* ── synthArrange: pure-JS software synth ───────────────────── */
  // 16-step (per-bar) drum patterns, keyed by genre.
  const DRUM_PAT = {
    pop: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
    rock: { kick: [0, 4, 8, 10, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
    ballad: { kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14] },
    folk: { kick: [0, 8], snare: [4], hat: [0, 4, 8, 12] },
    edm: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
    jazz: { kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14] },
    hiphop: { kick: [0, 6, 10], snare: [4, 12], hat: [2, 6, 10, 14] },
    blues: { kick: [0, 6, 8, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
    reggae: { kick: [0, 8], snare: [6, 14], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
    guofeng: { kick: [0, 8], snare: [], hat: [0, 4, 8, 12] },
    rnb: { kick: [0, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14] },
  };
  // 8-step bass lines: semitone offset above root, null = rest.
  const BASS_PAT = {
    folk: [0, 0, 0, 0, 0, 0, 0, 0],
    pop: [0, 0, 0, 12, 0, 0, 0, 12],
    rock: [0, 0, 0, 0, 12, 0, 12, 0],
    ballad: [0, 0, 0, 0, 0, 0, 0, 0],
    edm: [0, 0, 0, 12, 0, 0, 0, 12],
    jazz: [0, 7, 0, 7, 0, 7, 0, 7],
    hiphop: [0, null, 0, 0, 12, null, 0, 0],
    blues: [0, 0, 0, 7, 0, 0, 0, 7],
    reggae: [0, 0, 0, 0, 0, 0, 0, 12],
    classical: [0, 0, 0, 0, 0, 0, 0, 0],
    ambient: [0, 0, 0, 0, 0, 0, 0, 0],
    guofeng: [0, 0, 0, 0, 0, 0, 0, 0],
    rnb: [0, 0, 12, 0, 0, 0, 12, 0],
  };
  const CHORD_TONES = { M: [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6] };
  const drumPatFor = (genre) => DRUM_PAT[genre] || DRUM_PAT.pop;
  const bassPatFor = (genre) => BASS_PAT[genre] || BASS_PAT.pop;
  const panGains = (pan) => {
    const a = ((pan + 1) / 2) * (Math.PI / 2);
    return [Math.cos(a), Math.sin(a)];
  };
  const densityDrums = (pat, density) => {
    if (density === "light") {
      return { kick: pat.kick.filter((s) => s % 8 === 0), snare: [], hat: pat.hat.filter((s) => s % 4 === 0) };
    }
    if (density === "medium") {
      return { kick: pat.kick, snare: pat.snare, hat: pat.hat.filter((s) => s % 2 === 0) };
    }
    return pat;
  };
  function makeNoise(rate) {
    const n = Math.floor(rate * 0.25);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.random() * 2 - 1;
    return buf;
  }

  function renderKick(L, R, start, dur, rate, gain, pan) {
    const s0 = Math.floor(start * rate);
    const n = Math.min(Math.floor(dur * rate), L.length - s0);
    if (n <= 0) return;
    const [gl, gr] = panGains(pan);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const freq = 45 + 115 * Math.exp(-t * 26);
      const s = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 11);
      L[s0 + i] += s * gain * gl;
      R[s0 + i] += s * gain * gr;
    }
  }
  function renderSnare(L, R, start, dur, rate, gain, pan, noise) {
    const s0 = Math.floor(start * rate);
    const n = Math.min(Math.floor(dur * rate), L.length - s0);
    if (n <= 0) return;
    const [gl, gr] = panGains(pan);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const env = Math.exp(-t * 24);
      const body = Math.sin(2 * Math.PI * 190 * t) * 0.5 * Math.exp(-t * 30);
      const nz = noise[(s0 + i) % noise.length] * env;
      const s = body + nz;
      L[s0 + i] += s * gain * gl;
      R[s0 + i] += s * gain * gr;
    }
  }
  function renderHat(L, R, start, dur, rate, gain, pan, noise, open) {
    const s0 = Math.floor(start * rate);
    const n = Math.min(Math.floor(dur * rate), L.length - s0);
    if (n <= 0) return;
    const [gl, gr] = panGains(pan);
    let lp = 0, hp = 0;
    const a = 1 - Math.exp((-2 * Math.PI * 7000) / rate); // highpass coeff
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const x = noise[(s0 + i) % noise.length] * Math.exp(-t * (open ? 16 : 70));
      lp += a * (x - lp);          // simple lowpass
      const s = x - lp;            // highpass ≈ x - lowpassed(x)
      L[s0 + i] += s * gain * gl;
      R[s0 + i] += s * gain * gr;
    }
  }
  // Generic tonal voice: wave + ADSR-ish envelope + optional lowpass + vibrato.
  function renderTone(L, R, start, freq, dur, rate, gain, pan, opts, noise) {
    const s0 = Math.floor(start * rate);
    const n = Math.min(Math.ceil(dur * rate), L.length - s0);
    if (n <= 0) return;
    const o = opts || {};
    const wave = o.wave || "tri";
    const attack = o.attack != null ? o.attack : 0.01;
    const decay = o.decay != null ? o.decay : 4;      // 1/s
    const sustain = o.sustain != null ? o.sustain : 0.6;
    const release = o.release != null ? o.release : 0.08;
    const cutoff = o.cutoff || 0;
    const vibRate = o.vibRate || 0, vibDepth = o.vibDepth || 0;
    const g = o.gainScale != null ? o.gainScale : 1;
    const [gl, gr] = panGains(pan);
    let lp = 0;
    const lpA = cutoff > 0 ? 1 - Math.exp((-2 * Math.PI * cutoff) / rate) : 0;
    const relStart = dur - release;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let env;
      if (t < attack) env = t / attack;
      else env = sustain + (1 - sustain) * Math.exp(-(t - attack) * decay);
      if (t > relStart) env *= Math.max(0, (dur - t) / release);
      const f = freq * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t));
      const ph = t * f % 1;
      let s;
      if (wave === "sine") s = Math.sin(2 * Math.PI * f * t);
      else if (wave === "saw") s = 2 * ph - 1;
      else if (wave === "square") s = ph < 0.5 ? 1 : -1;
      else s = 2 * Math.abs(2 * ph - 1) - 1;
      if (lpA > 0) { lp += lpA * (s - lp); s = lp; }
      const v = s * env * gain * g;
      L[s0 + i] += v * gl;
      R[s0 + i] += v * gr;
    }
  }
  // Sustained detuned-saw pad chord.
  function renderPad(L, R, start, freqs, dur, rate, gain, pan) {
    const s0 = Math.floor(start * rate);
    const n = Math.min(Math.ceil(dur * rate), L.length - s0);
    if (n <= 0) return;
    const [gl, gr] = panGains(pan);
    const attack = Math.min(0.7, dur * 0.3);
    let lp = 0;
    const lpA = 1 - Math.exp((-2 * Math.PI * 1300) / rate);
    const relStart = Math.max(0, dur - 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let env = t < attack ? t / attack : 1;
      if (t > relStart) env *= Math.max(0, (dur - t) / 0.7);
      let s = 0;
      for (const f of freqs) {
        s += 2 * ((t * f * 1.004) % 1) - 1;
        s += 2 * ((t * f * 0.996) % 1) - 1;
      }
      s *= 0.5 / Math.max(1, freqs.length * 2);
      lp += lpA * (s - lp);
      const v = lp * env * gain;
      L[s0 + i] += v * gl;
      R[s0 + i] += v * gr;
    }
  }

  function renderInstrument(instrument, density, barStart, barLen, lvl, ctx) {
    const { L, R, rate, noise, step, swing } = ctx;
    switch (instrument) {
      case "drums": {
        const pat = densityDrums(drumPatFor(ctx.genre), density);
        const off = (s) => (swing && s % 2 === 1 ? step * 0.4 : 0);
        for (const s of pat.kick) renderKick(L, R, barStart + s * step + off(s), 0.18, rate, 0.5 * lvl, 0.05);
        for (const s of pat.snare) renderSnare(L, R, barStart + s * step + off(s), 0.14, rate, 0.34 * lvl, 0.0, noise);
        for (const s of pat.hat) renderHat(L, R, barStart + s * step + off(s), 0.06, rate, 0.22 * lvl, 0.25, noise, false);
        break;
      }
      case "bass": {
        const pat = bassPatFor(ctx.genre);
        if (density === "light") {
          const f = noteFreq(ctx.bassMidi);
          renderTone(L, R, barStart, f, barLen * 0.92, rate, 0.4 * lvl, 0.0,
            { wave: "saw", attack: 0.02, decay: 1.2, sustain: 0.55, release: 0.06, cutoff: 480 }, noise);
        } else {
          const steps = density === "medium" ? [0, 2, 4, 6] : [0, 1, 2, 3, 4, 5, 6, 7];
          for (const s of steps) {
            const off = pat[s];
            if (off == null) continue;
            const f = noteFreq(ctx.bassMidi + off);
            renderTone(L, R, barStart + s * step, f, step * (density === "full" ? 1.7 : 3.6), rate, 0.36 * lvl, 0.0,
              { wave: "saw", attack: 0.015, decay: 1.5, sustain: 0.5, release: 0.05, cutoff: 460 }, noise);
          }
        }
        break;
      }
      case "keys": {
        const tones = ctx.chordTones;
        if (density === "full") {
          const arpIdx = [0, 1, 2, 3, 2, 1, 3, 0];
          for (let s = 0; s < 8; s++) {
            const idx = arpIdx[s % 8];
            const oct = s === 4 ? 12 : 0;
            const f = noteFreq(ctx.keysMidi + tones[idx % tones.length] + oct);
            renderTone(L, R, barStart + s * step, f, step * 2.6, rate, 0.16 * lvl, 0.12,
              { wave: "tri", attack: 0.004, decay: 7, sustain: 0.04, release: 0.06, cutoff: 3200 }, noise);
          }
        } else {
          const chSteps = density === "light" ? [0] : [0, 8];
          const chDur = density === "light" ? barLen * 0.9 : step * 3.4;
          for (const s of chSteps) {
            for (const t of tones) {
              const f = noteFreq(ctx.keysMidi + t);
              renderTone(L, R, barStart + s * step, f, chDur, rate, 0.1 * lvl, 0.12,
                { wave: "tri", attack: 0.005, decay: 2.5, sustain: 0.15, release: 0.1, cutoff: 3200 }, noise);
            }
          }
        }
        break;
      }
      case "pad": {
        const tones = ctx.chordTones;
        const freqs = [];
        for (const t of tones) { freqs.push(noteFreq(ctx.keysMidi + t)); freqs.push(noteFreq(ctx.keysMidi + 12 + t)); }
        renderPad(L, R, barStart, freqs, barLen * 1.05, rate, 0.14 * lvl, 0.0);
        break;
      }
      default: { // pluck / flute / erhu / organ — melodic layers
        const soloBase = instrument === "pluck" ? ctx.keysMidi : ctx.keysMidi + 12;
        const tones = ctx.chordTones;
        const soloSteps = density === "light" ? [0] : density === "medium" ? [0, 8] : [0, 4, 8, 12];
        const idxPat = [0, 2, 1, 3];
        const opts = {
          pluck: { wave: "tri", attack: 0.002, decay: 9, sustain: 0.02, release: 0.05, cutoff: 2600 },
          flute: { wave: "sine", attack: 0.09, decay: 0.6, sustain: 0.9, release: 0.12, cutoff: 4200, vibRate: 5, vibDepth: 0.008 },
          erhu: { wave: "saw", attack: 0.05, decay: 1.2, sustain: 0.85, release: 0.1, cutoff: 2400, vibRate: 5.5, vibDepth: 0.014 },
          organ: { wave: "square", attack: 0.03, decay: 0.5, sustain: 0.85, release: 0.08, cutoff: 900 },
        }[instrument] || { wave: "tri", attack: 0.02, decay: 3, sustain: 0.5, release: 0.08, cutoff: 3000 };
        const gain = { pluck: 0.4, flute: 0.46, erhu: 0.42, organ: 0.32 }[instrument] || 0.4;
        for (let i = 0; i < soloSteps.length; i++) {
          const s = soloSteps[i];
          const f = noteFreq(soloBase + tones[idxPat[i % 4] % tones.length]);
          const dur = density === "light" ? barLen * 0.9 : density === "medium" ? step * 3.4 : step * 2.8;
          renderTone(L, R, barStart + s * step, f, dur, rate, gain * lvl, instrument === "erhu" ? 0.1 : 0.18, opts, noise);
        }
        break;
      }
    }
  }


  function synthArrange(demoL, demoR, rate, spec) {
    const bpm = clamp(spec.bpm || 100, 40, 240);
    const beat = 60 / bpm;
    const barLen = 4 * beat;
    const step = beat / 4;
    const genre = spec.genre && GENRES[spec.genre] ? spec.genre : "pop";
    const tpl = GENRES[genre];
    const swing = !!tpl.swing;
    const demoN = Math.max(demoL.length, demoR.length);
    const total = demoN + Math.floor(rate * 1.2);
    const L = new Float32Array(total), R = new Float32Array(total);
    const noise = makeNoise(rate);
    const prog = spec.progression && spec.progression.length ? spec.progression : [{ rootPc: 0, quality: "M" }];
    const demoDur = demoN / rate;
    const ctx = { L, R, rate, noise, step, swing, genre, bassMidi: 36, keysMidi: 48, chordTones: [0, 4, 7] };
    for (const sec of spec.sections) {
      const startSec = clamp(sec.start, 0, demoDur);
      const endSec = clamp(sec.end, startSec + 0.5, demoDur + 0.2);
      const dur = endSec - startSec;
      const nBars = Math.max(1, Math.round(dur / barLen));
      const lvl = sec.level >= 2 ? 1 : sec.level === 1 ? 0.85 : 0.6;
      for (let b = 0; b < nBars; b++) {
        const barStart = startSec + b * barLen;
        const chord = prog[b % prog.length];
        const bassMidi = 36 + ((chord.rootPc + 12) % 12);
        const keysMidi = bassMidi + 12;
        ctx.bassMidi = bassMidi;
        ctx.keysMidi = keysMidi;
        ctx.chordTones = CHORD_TONES[chord.quality] || CHORD_TONES.M;
        for (const layer of sec.layers) {
          renderInstrument(layer.instrument, layer.density, barStart, barLen, lvl, ctx);
        }
      }
    }
    // mix the demo (lead) in, centered
    for (let i = 0; i < demoN; i++) {
      L[i] += (demoL[i] || 0) * 0.85;
      R[i] += (demoR[i] || 0) * 0.85;
    }
    // master: fade in/out, normalize, soft-clip
    const fadeIn = Math.min(total, Math.floor(rate * 0.08));
    const fadeOut = Math.floor(rate * 0.6);
    for (let i = 0; i < fadeIn; i++) { const g = i / fadeIn; L[i] *= g; R[i] *= g; }
    for (let i = Math.max(0, total - fadeOut); i < total; i++) { const g = (total - i) / fadeOut; L[i] *= g; R[i] *= g; }
    let peak = 1e-6;
    for (let i = 0; i < total; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    const norm = 0.92 / peak;
    const k = 1 / Math.tanh(1.15);
    for (let i = 0; i < total; i++) {
      L[i] = Math.tanh(L[i] * norm * 1.15) * k;
      R[i] = Math.tanh(R[i] * norm * 1.15) * k;
    }
    return { left: L, right: R, duration: total / rate };
  }

  /* ── encodeWavStereo(left, right, rate) → Uint8Array ───────── */
  function encodeWavStereo(left, right, rate) {
    const n = Math.min(left.length, right.length);
    const dataBytes = n * 4;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);
    const ascii = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    ascii(0, "RIFF");
    dv.setUint32(4, 36 + dataBytes, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);        // PCM
    dv.setUint16(22, 2, true);        // 2 channels
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 4, true); // byte rate
    dv.setUint16(32, 4, true);        // block align
    dv.setUint16(34, 16, true);       // bits per sample
    ascii(36, "data");
    dv.setUint32(40, dataBytes, true);
    for (let i = 0; i < n; i++) {
      const l = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)));
      const r = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)));
      dv.setInt16(44 + i * 4, l, true);
      dv.setInt16(46 + i * 4, r, true);
    }
    return new Uint8Array(buf);
  }

  /* ── exports ───────────────────────────────────────────────── */
  return {
    NOTE_NAMES,
    GENRES,
    analyzePcm,
    parseDescription,
    buildArrangement,
    synthArrange,
    encodeWavStereo,
  };
});

