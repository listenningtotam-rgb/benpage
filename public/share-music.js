/* ── Share-page overlay-mix renderer ──────────────────────────────────────
 * A recording whose latest VERSION is an overlay take (layered on its
 * backing chain) is shared as a rendered mix, not just the raw take file.
 *
 * The server embeds the chain as JSON (#share-mix-chain) and the <audio>
 * element carries data-render="overlay".  On load we decode every layer and
 * render the mix OFFLINE (OfflineAudioContext does pure DSP with no output,
 * so iOS can't drop it — the same path the hub page uses in playIOSMix), then
 * point the native <audio> control at the rendered WAV blob.  Because the
 * render finishes BEFORE the visitor taps play, the iOS gesture / autoplay
 * restrictions never come into play.
 *
 * Failures are non-fatal: the <audio> src stays on the version's own file
 * (the no-JS / fallback path), so a share page ALWAYS has something audible.
 * ------------------------------------------------------------------------ */
(function () {
  "use strict";

  var audio = document.getElementById("share-audio");
  var chainEl = document.getElementById("share-mix-chain");
  var statusEl = document.getElementById("share-mix-status");
  if (!audio || audio.getAttribute("data-render") !== "overlay" || !chainEl) return;

  var layers = null;
  try {
    layers = JSON.parse(chainEl.textContent || chainEl.text);
  } catch (_) {
    return;
  }
  if (!Array.isArray(layers) || !layers.length) return;

  var RATE = 44100;
  var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (typeof OAC !== "function") return;

  var status = function (text) {
    if (!statusEl) return;
    if (text) {
      statusEl.textContent = text;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  };

  /* decodeAudioData has promise and callback flavors; wrap both so we always
     settle with an AudioBuffer or an error (see public/music.js). */
  function decodeAudioCompat(ctx, ab) {
    return new Promise(function (resolve, reject) {
      if (!ctx || typeof ctx.decodeAudioData !== "function") {
        reject(new Error("decodeAudioData is not supported in this browser"));
        return;
      }
      var settled = false;
      var ok = function (b) {
        if (settled) return;
        settled = true;
        if (b && typeof b.duration === "number") resolve(b);
        else reject(new Error("decodeAudioData returned no audio"));
      };
      var bad = function (err) {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String((err && err.message) || err || "decodeAudioData failed")));
      };
      try {
        var p = ctx.decodeAudioData(ab, ok, bad);
        if (p && typeof p.then === "function") p.then(ok, bad);
      } catch (err) {
        bad(err);
      }
    });
  }

  /* Promise-style startRendering with the callback fallback (old iOS). */
  function renderOffline(mix) {
    return new Promise(function (resolve, reject) {
      try {
        var p = mix.startRendering();
        if (p && typeof p.then === "function") p.then(resolve, reject);
        else mix.oncomplete = function (e) { resolve(e.renderedBuffer); };
      } catch (err) {
        reject(err);
      }
    });
  }

  /* Stereo 16-bit PCM WAV encoder — identical output shape to the hub page's
     encodeWavStereo so every browser can play the rendered mix. */
  function encodeWavStereo(ch0, ch1, rate) {
    var n = Math.min(ch0.length, ch1.length);
    if (!n) return null;
    var dataBytes = n * 4;
    var buf = new ArrayBuffer(44 + dataBytes);
    var dv = new DataView(buf);
    var ascii = function (off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    var pcm = function (v) { return (v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0); };
    ascii(0, "RIFF");
    dv.setUint32(4, 36 + dataBytes, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true);
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 16, true);
    ascii(36, "data");
    dv.setUint32(40, dataBytes, true);
    var o = 44;
    for (var i = 0; i < n; i++) {
      dv.setInt16(o, pcm(ch0[i] * 32767), true); o += 2;
      dv.setInt16(o, pcm(ch1[i] * 32767), true); o += 2;
    }
    return new Blob([buf], { type: "audio/wav" });
  }


  async function renderMix() {
    status("⏳ rendering the layered mix…");
    // Decoder-only context (its length is irrelevant) reuses decodeAudioData.
    // iOS caps live AudioContexts at ~4 per page — we keep exactly one and
    // never close it mid-render.
    var dec = new OAC(2, 1, RATE);
    var decoded = [];
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      var res = await fetch(l.url, { cache: "no-cache" });
      if (!res.ok) throw new Error("Could not load audio: " + l.url);
      var ab = await res.arrayBuffer();
      var buffer = await decodeAudioCompat(dec, ab);
      if (!buffer) throw new Error("decodeAudioData returned no audio");
      decoded.push({ layer: l, buffer: buffer });
    }

    // Total length = the latest end across all sources (the root plays to its
    // own end), with the same ≤ 10 min safety cap as the hub page.
    var total = 1;
    for (var j = 0; j < decoded.length; j++) {
      var dl = decoded[j];
      var bufDur = dl.buffer.duration || 0;
      var ro = Math.min(dl.layer.readOff || 0, Math.max(0, bufDur - 0.001));
      var rd = dl.layer.dur != null ? dl.layer.dur : Math.max(0.05, bufDur - ro);
      total = Math.max(total, (dl.layer.offset || 0) + rd);
    }
    var len = Math.min(600, Math.max(1, total)) * RATE;

    var mix = new OAC(2, Math.ceil(len), RATE);
    for (var k = 0; k < decoded.length; k++) {
      var item = decoded[k];
      var bufDur2 = item.buffer.duration || 0;
      var readOff = item.layer.readOff != null && item.layer.readOff < bufDur2
        ? Math.max(0, item.layer.readOff)
        : Math.max(0, bufDur2 - 0.001);
      var readDur = item.layer.dur != null ? item.layer.dur : Math.max(0.05, bufDur2 - readOff);
      var src = mix.createBufferSource();
      src.buffer = item.buffer;
      var g = mix.createGain();
      g.gain.value = isFinite(item.layer.gain) && item.layer.gain >= 0 ? Math.min(3, item.layer.gain) : 1;
      src.connect(g);
      g.connect(mix.destination);
      src.start(item.layer.offset || 0, readOff, readDur);
    }

    var rendered = await renderOffline(mix);
    var ch0 = rendered.getChannelData(0);
    var ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;
    var blob = encodeWavStereo(ch0, ch1, RATE);
    if (!blob) throw new Error("mix encode produced nothing");
    return URL.createObjectURL(blob);
  }

  renderMix()
    .then(function (mixUrl) {
      // The visitor may have already hit play on the raw take while we were
      // rendering — pause it so the swap doesn't yank the sound away mid-take.
      var wasPlaying = !audio.paused && !audio.ended;
      if (wasPlaying) {
        try { audio.pause(); } catch (_) {}
      }
      audio.removeAttribute("data-render");
      audio.src = mixUrl;
      if (wasPlaying) {
        status("▶ mix ready — press play for the layered version");
      } else {
        status("");
      }
    })
    .catch(function () {
      // Non-fatal: keep the version's own file as the fallback.
      audio.removeAttribute("data-render");
      status("");
    });
})();

