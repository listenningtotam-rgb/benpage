/* ── 编曲工坊 Arranger — browser app ──────────────────────────────
 * Fully client-side: decode → analyzePcm → parseDescription →
 * buildArrangement → synthArrange → encodeWavStereo → play/download.
 * The demo never leaves the device. Mirror of vinyl.js conventions.
 */
(function () {
  "use strict";
  const AL = window.ArrangeLib;
  if (!AL) { console.error("编曲工坊: arrange-lib.js not loaded"); return; }
  const $ = (id) => document.getElementById(id);

  const fileBtn = $("arrange-file-btn"), fileInput = $("arrange-file"), fileNameEl = $("arrange-file-name");
  const demoSelect = $("arrange-demo"), demoRun = $("arrange-demo-run");
  const descEl = $("arrange-desc"), goBtn = $("arrange-go"), statusEl = $("arrange-status");
  const resultEl = $("arrange-result"), analysisEl = $("arrange-analysis"), chartEl = $("arrange-chart");
  const bpmVal = $("arrange-bpm"), bpmUp = $("arrange-bpm-up"), bpmDown = $("arrange-bpm-down");
  const keySelect = $("arrange-key"), rearrangeBtn = $("arrange-rearrange");
  const audioEl = $("arrange-audio"), downloadBtn = $("arrange-download");
  const thumbEl = $("thumb-arrange");

  const DEMOS = [
    { name: "demo-folk-90-A.wav", label: "民谣 · 90 BPM · A 大调", hint: "民谣风格，温暖，简约，加一点笛子" },
    { name: "demo-ballad-70-F.wav", label: "抒情 · 70 BPM · F 大调", hint: "抒情流行歌，安静，弦乐铺底" },
    { name: "demo-pop-120-C.wav", label: "流行 · 120 BPM · C 大调", hint: "流行，饱满的鼓和贝斯，大气" },
  ];
  const MOOD_ZH = {
    sad: "悲伤", upbeat: "欢快", epic: "大气", warm: "温暖", laidback: "慵懒",
    quiet: "安静", romantic: "浪漫", nostalgic: "怀旧", dreamy: "梦幻",
  };
  const DENSITY_ZH = { minimal: "简约", full: "饱满" };
  const INST_ZH = {
    piano: "钢琴", guitar: "木吉他", "electric-guitar": "电吉他", strings: "弦乐", bass: "贝斯",
    drums: "鼓", erhu: "二胡", guzheng: "古筝", flute: "笛子", organ: "风琴", brass: "管乐", choir: "人声和声",
  };

  let state = {
    buffer: null,        // decoded AudioBuffer (the demo)
    features: null,      // analyzePcm result
    directives: null,    // parseDescription result
    spec: null,          // buildArrangement result
    wavUrl: null,        // object URL of the rendered WAV
    wavBlob: null,
    bpm: 0,
    keyPc: 0,
    keyMode: "major",
    busy: false,
  };

  function setStatus(msg, cls) {
    statusEl.className = "arrange-status" + (cls ? " " + cls : "");
    statusEl.textContent = msg || "";
  }
  function fmtTime(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
  }
  function chordName(c) {
    const q = c.quality === "m" ? "m" : c.quality === "dim" ? "°" : "";
    return AL.NOTE_NAMES[c.rootPc] + q;
  }
  function decodeAudio(ab) {
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 44100);
    return ctx.decodeAudioData(ab);
  }
  async function loadDemoAudio(name) {
    const res = await fetch("demo-tracks/" + name);
    if (!res.ok) throw new Error("示例加载失败 HTTP " + res.status);
    return decodeAudio(await res.arrayBuffer());
  }
  function downmix(buf) {
    const len = buf.length, ch = buf.numberOfChannels;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / ch;
    }
    return mono;
  }
  function storeBuffer(buf, name) {
    state.buffer = buf;
    state.features = null;
    state.spec = null;
    goBtn.disabled = false;
    fileNameEl.textContent = name;
    if (state.wavUrl) { URL.revokeObjectURL(state.wavUrl); state.wavUrl = null; }
    resultEl.hidden = true;
    audioEl.hidden = true;
    setStatus("已载入 " + name + "，写一句风格描述后点「开始编曲」。", "ok");
  }

  async function runPipeline() {
    if (state.busy || !state.buffer) return;
    state.busy = true;
    goBtn.disabled = true;
    resultEl.hidden = true;
    audioEl.hidden = true;
    try {
      setStatus("⏳ 分析 demo：测速、定调、分段…", "loading");
      await new Promise((r) => setTimeout(r, 30)); // let the status paint
      const buf = state.buffer;
      if (buf.duration < 3) {
        setStatus("demo 太短（< 3 秒），无法可靠分析速度与调性，请换一段更长的音频。", "err");
        goBtn.disabled = false;
        return;
      }
      const rate = buf.sampleRate;
      const mono = downmix(buf);
      const features = AL.analyzePcm(mono, rate);
      const directives = AL.parseDescription(descEl.value);

      setStatus("🎼 生成编曲方案…", "loading");
      await new Promise((r) => setTimeout(r, 20));
      const spec = AL.buildArrangement(features, directives);

      setStatus("🎛 合成伴奏（纯本地渲染）…", "loading");
      await new Promise((r) => setTimeout(r, 20));
      const left = buf.numberOfChannels > 1 ? buf.getChannelData(0) : mono;
      const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : mono;
      const mix = AL.synthArrange(left, right, rate, spec);

      setStatus("💾 编码 WAV…", "loading");
      const wav = AL.encodeWavStereo(mix.left, mix.right, rate);

      state.features = features;
      state.directives = directives;
      state.spec = spec;
      state.bpm = spec.bpm;
      state.keyPc = AL.NOTE_NAMES.indexOf(spec.keyName);
      state.keyMode = spec.keyMode;

      renderAnalysis();
      renderChart();
      renderControls();
      const blob = new Blob([wav], { type: "audio/wav" });
      if (state.wavUrl) URL.revokeObjectURL(state.wavUrl);
      state.wavBlob = blob;
      state.wavUrl = URL.createObjectURL(blob);
      audioEl.src = state.wavUrl;
      audioEl.hidden = false;
      downloadBtn.disabled = false;
      resultEl.hidden = false;
      setStatus(
        `完成：${spec.keyName}${spec.keyMode === "minor" ? "小调" : "大调"} · ${Math.round(spec.bpm)} BPM · ${spec.sections.length} 个段落 · ${spec.instruments.length} 种乐器`,
        "ok"
      );
    } catch (e) {
      console.error(e);
      setStatus("出错了：" + e.message, "err");
      goBtn.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  function resynthesize() {
    if (state.busy || !state.features) return;
    state.busy = true;
    goBtn.disabled = true;
    try {
      const features = Object.assign({}, state.features, {
        bpm: state.bpm,
        keyPitchClass: state.keyPc,
        keyMode: state.keyMode,
      });
      const spec = AL.buildArrangement(features, state.directives);
      const buf = state.buffer;
      const rate = buf.sampleRate;
      const mono = downmix(buf);
      const left = buf.numberOfChannels > 1 ? buf.getChannelData(0) : mono;
      const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : mono;
      const mix = AL.synthArrange(left, right, rate, spec);
      const wav = AL.encodeWavStereo(mix.left, mix.right, rate);
      state.spec = spec;
      renderAnalysis();
      renderChart();
      renderControls();
      const blob = new Blob([wav], { type: "audio/wav" });
      if (state.wavUrl) URL.revokeObjectURL(state.wavUrl);
      state.wavBlob = blob;
      state.wavUrl = URL.createObjectURL(blob);
      audioEl.src = state.wavUrl;
      audioEl.hidden = false;
      resultEl.hidden = false;
      setStatus(`已按新参数重新合成：${spec.keyName}${spec.keyMode === "minor" ? "小调" : "大调"} · ${Math.round(spec.bpm)} BPM`, "ok");
    } catch (e) {
      console.error(e);
      setStatus("重新合成出错：" + e.message, "err");
    } finally {
      state.busy = false;
      goBtn.disabled = false;
    }
  }

  function confBar(v) {
    const pct = Math.round(Math.min(100, Math.max(0, v * 100)));
    return `<span class="arrange-conf"><i style="width:${pct}%"></i></span>`;
  }

  function renderAnalysis() {
    const f = state.features, d = state.directives, s = state.spec;
    if (!f || !d || !s) return;
    const moods = (d.moods || []).map((m) => MOOD_ZH[m] || m).filter(Boolean);
    const insts = (d.instruments || []).map((i) => INST_ZH[i] || i).filter(Boolean);
    const unknown = d.unknown && d.unknown.length ? `<p class="arrange-unknown">未识别的描述词（已忽略）：${d.unknown.join("、")}</p>` : "";
    const prog = s.progression.map(chordName).join(" – ");
    analysisEl.innerHTML = `
      <div class="arrange-metrics">
        <div class="arrange-metric"><span class="arrange-metric-v">${s.keyName}${s.keyMode === "minor" ? "m" : ""}</span><span class="arrange-metric-k">调性 Key</span><span class="arrange-metric-c">${confBar(f.keyConfidence)}${Math.round(f.keyConfidence * 100)}%</span></div>
        <div class="arrange-metric"><span class="arrange-metric-v">${Math.round(s.bpm)}</span><span class="arrange-metric-k">速度 BPM</span><span class="arrange-metric-c">${confBar(f.bpmConfidence)}${Math.round(f.bpmConfidence * 100)}%</span></div>
        <div class="arrange-metric"><span class="arrange-metric-v">${fmtTime(f.duration)}</span><span class="arrange-metric-k">时长</span></div>
        <div class="arrange-metric"><span class="arrange-metric-v">${s.sections.length}</span><span class="arrange-metric-k">段落</span></div>
      </div>
      <p class="arrange-prog">和弦进行（每小节循环）：<b>${prog}</b></p>
      <p class="arrange-tags">风格 <b>${s.genreLabel}</b>${moods.length ? " · 情绪 " + moods.join("、") : ""}${insts.length ? " · 乐器 " + insts.join("、") : ""}${d.density ? " · 密度 " + DENSITY_ZH[d.density] : ""}</p>
      ${unknown}
      <p class="arrange-hint">若调性/速度判断不准，用下方 BPM 与调性微调后点「重新合成」。</p>`;
  }

  function renderControls() {
    bpmVal.textContent = Math.round(state.bpm);
    const cur = state.keyPc * 2 + (state.keyMode === "minor" ? 1 : 0);
    keySelect.value = String(cur);
  }

  function renderChart() {
    const s = state.spec;
    const rows = s.sections
      .map((sec) => {
        const chips = sec.layers
          .map((l) => `<span class="arrange-chip">${l.role}<em>${l.density === "light" ? "轻" : l.density === "medium" ? "中" : "满"}</em></span>`)
          .join("");
        return `<tr>
        <td class="arrange-sec-label">≈ ${sec.label}</td>
        <td class="arrange-sec-time">${fmtTime(sec.start)} – ${fmtTime(sec.end)}</td>
        <td class="arrange-sec-bars">${sec.bars} 小节</td>
        <td class="arrange-sec-layers">${chips}</td>
      </tr>`;
      })
      .join("");
    chartEl.innerHTML = `
      <table class="arrange-table">
        <thead><tr><th>段落</th><th>时间</th><th>小节</th><th>编曲层次</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /* ── thumbnail: tiny beat-grid animation ────────────────────── */
  let thumbTimer = null;
  let thumbCol = 0;
  function buildThumb() {
    if (!thumbEl) return;
    if (!thumbEl.children.length) {
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        const d = document.createElement("i");
        d.className = "thumb-arrange-dot";
        thumbEl.appendChild(d);
      }
    }
    clearInterval(thumbTimer);
    thumbTimer = setInterval(() => {
      thumbCol = (thumbCol + 1) % 4;
      const dots = thumbEl.children;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        const lit = c === thumbCol && (r === 1 || r === 2);
        dots[r * 4 + c].classList.toggle("lit", lit);
      }
    }, 220);
  }

  /* ── wiring ─────────────────────────────────────────────────── */
  function populateDemos() {
    demoSelect.innerHTML = DEMOS.map((d) => `<option value="${d.name}">${d.label}</option>`).join("");
  }
  function populateKeys() {
    const opts = [];
    for (let i = 0; i < 12; i++) {
      const n = AL.NOTE_NAMES[i];
      opts.push(`<option value="${i * 2}">${n} 大调</option>`);
      opts.push(`<option value="${i * 2 + 1}">${n} 小调</option>`);
    }
    keySelect.innerHTML = opts.join("");
  }
  function downloadWav() {
    if (!state.wavBlob) return;
    const a = document.createElement("a");
    const n = (fileNameEl.textContent || "demo").replace(/\.[a-z0-9]+$/i, "");
    a.href = URL.createObjectURL(state.wavBlob);
    a.download = `${n}-编曲-${state.spec.keyName}${state.keyMode === "minor" ? "m" : ""}-${Math.round(state.bpm)}bpm.wav`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function init() {
    if (init.done) { setStatus(state.buffer ? "已就绪，可以开始编曲。" : "选择一段 demo 音频开始。", "ok"); return; }
    init.done = true;
    populateDemos();
    populateKeys();

    fileBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        setStatus("正在解码 " + f.name + "…", "loading");
        const buf = await decodeAudio(await f.arrayBuffer());
        storeBuffer(buf, f.name);
      } catch (e) {
        console.error(e);
        setStatus("无法解码该音频：" + e.message, "err");
      }
    });
    demoRun.addEventListener("click", async () => {
      const name = demoSelect.value;
      try {
        setStatus("正在载入示例 " + name + "…", "loading");
        const buf = await loadDemoAudio(name);
        const demo = DEMOS.find((d) => d.name === name);
        descEl.value = demo ? demo.hint : descEl.value;
        storeBuffer(buf, name);
      } catch (e) {
        console.error(e);
        setStatus("载入示例失败：" + e.message, "err");
      }
    });
    descEl.addEventListener("input", () => {
      if (state.buffer) goBtn.disabled = false;
    });
    goBtn.addEventListener("click", runPipeline);
    rearrangeBtn.addEventListener("click", resynthesize);
    bpmUp.addEventListener("click", () => { state.bpm = Math.min(240, state.bpm + 1); renderControls(); });
    bpmDown.addEventListener("click", () => { state.bpm = Math.max(40, state.bpm - 1); renderControls(); });
    keySelect.addEventListener("change", () => {
      const v = parseInt(keySelect.value, 10);
      state.keyPc = Math.floor(v / 2);
      state.keyMode = v % 2 === 1 ? "minor" : "major";
    });
    downloadBtn.addEventListener("click", downloadWav);
  }
  init.done = false;

  function stop() {
    audioEl.pause();
  }

  // animate the gallery thumbnail on page load (like the FX thumb)
  buildThumb();

  window.ArrangeStudio = { init, stop };
})();
