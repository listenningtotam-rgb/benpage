/* ── 黑胶档案 (Vinyl Archive) ─────────────────────────────────────────
 * Photograph a vinyl cover → compute a 64-bit perceptual hash (aHash +
 * dHash) right here in the browser, POST it to /api/vinyl/recognize, and
 * the server matches it against the seeded MusicBrainz albums.  The result
 * card shows the album metadata (date, label, catalog, tracklist) and can
 * generate a nostalgic share page at /vinyl/:slug.
 *
 * The hashing math mirrors seed-vinyl.js exactly, so a photo of a seeded
 * cover lands within a few Hamming bits of its seed entry.
 * --------------------------------------------------------------------- */
(function () {
  "use strict";

  var stage, video, statusEl, previewEl, resultEl, fileInput;
  var demoSelect = null;
  var stream = null;
  var capturing = false;

  function $(id) {
    return document.getElementById(id);
  }

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  /* ── Setup (idempotent — called every time the panel opens) ──────── */
  function initVinyl() {
    if (!stage) {
      stage = $("vinyl-stage");
      video = $("vinyl-video");
      statusEl = $("vinyl-status");
      previewEl = $("vinyl-preview");
      resultEl = $("vinyl-result");
      fileInput = $("vinyl-file-input");
      demoSelect = $("vinyl-demo");

      $("vinyl-camera").addEventListener("click", onCameraClick);
      $("vinyl-file").addEventListener("click", function () {
        fileInput.click();
      });
      fileInput.addEventListener("change", function () {
        if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
        fileInput.value = "";
      });
      $("vinyl-demo-run").addEventListener("click", runDemo);

      // Load the seed album list into the demo picker (also proves the
      // /api/vinyl endpoint works).
      fetch("/api/vinyl")
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.records) return;
          data.records.forEach(function (r) {
            var opt = document.createElement("option");
            opt.value = r.cover_path;
            opt.textContent = r.title + " — " + r.artist;
            demoSelect.appendChild(opt);
          });
        })
        .catch(function () {});
    }
    setStatus("");
    resetView();
  }

  function stopVinyl() {
    if (stream) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
      stream = null;
      if (video) video.srcObject = null;
      capturing = false;
      var btn = $("vinyl-camera");
      if (btn) btn.textContent = "📷 拍照识别";
    }
  }

  function resetView() {
    stopVinyl();
    if (video) video.hidden = true;
    if (previewEl) {
      previewEl.hidden = true;
      previewEl.innerHTML = "";
    }
    if (resultEl) {
      resultEl.hidden = true;
      resultEl.innerHTML = "";
    }
  }

  /* ── Camera ──────────────────────────────────────────────────────── */
  function onCameraClick() {
    if (capturing) {
      capturePhoto();
      return;
    }
    setStatus("正在启动摄像头…");
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .then(function () {
        video.hidden = false;
        capturing = true;
        $("vinyl-camera").textContent = "📷 点击拍照";
        setStatus("");
      })
      .catch(function (e) {
        setStatus(
          "无法打开摄像头（" +
            (e && e.name ? e.name : "权限被拒绝") +
            "）— 请改用“从相册选择”。"
        );
      });
  }

  function capturePhoto() {
    var c = document.createElement("canvas");
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 720;
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    stopVinyl();
    recognize(c);
  }

  /* ── File upload (相册 / WeChat) ─────────────────────────────────── */
  function loadFile(file) {
    if (!/^image\//.test(file.type)) {
      setStatus("请选择图片文件。");
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      recognize(img); // <img> decodes EXIF orientation automatically
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setStatus("图片加载失败，请换一张试试。");
    };
    img.src = url;
  }

  /* ── Demo: test with one of the seeded covers ────────────────────── */
  function runDemo() {
    if (!demoSelect || !demoSelect.value) return;
    var img = new Image();
    img.onload = function () {
      recognize(img);
    };
    img.src = demoSelect.value;
  }


  /* ── Perceptual hashing (mirrors seed-vinyl.js exactly) ───────────── */
  /* Box-averaged downscale to a grayscale luma grid — identical math to
   * seed-vinyl.js's boxGray(), done by hand on the full-res canvas pixels
   * (canvas drawImage's bilinear smoothing would drift from the seed). */
  function boxGray(rgba, sw, sh, ow, oh) {
    var out = new Float64Array(ow * oh);
    for (var oy = 0; oy < oh; oy++) {
      var ys = Math.floor((oy * sh) / oh);
      var ye = Math.max(ys + 1, Math.floor(((oy + 1) * sh) / oh));
      for (var ox = 0; ox < ow; ox++) {
        var xs = Math.floor((ox * sw) / ow);
        var xe = Math.max(xs + 1, Math.floor(((ox + 1) * sw) / ow));
        var sum = 0;
        var n = 0;
        for (var y = ys; y < ye; y++) {
          for (var x = xs; x < xe; x++) {
            var i = (y * sw + x) * 4;
            sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
            n++;
          }
        }
        out[oy * ow + ox] = sum / n;
      }
    }
    return out;
  }

  function grayGridsFromSource(src) {
    var c = document.createElement("canvas");
    c.width = src.naturalWidth || src.videoWidth || src.width;
    c.height = src.naturalHeight || src.videoHeight || src.height;
    var ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0);
    var rgba = ctx.getImageData(0, 0, c.width, c.height).data;
    return {
      gray8: boxGray(rgba, c.width, c.height, 8, 8),
      gray9: boxGray(rgba, c.width, c.height, 9, 8),
    };
  }

  function hexFromBits(bits) {
    var hex = "";
    for (var i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  }

  function aHashHex(src) {
    var g = grayGridsFromSource(src).gray8;
    var avg = 0;
    for (var i = 0; i < g.length; i++) avg += g[i];
    avg /= g.length;
    var bits = "";
    for (var i = 0; i < 64; i++) bits += g[i] >= avg ? "1" : "0";
    return hexFromBits(bits);
  }

  function dHashHex(src) {
    var g = grayGridsFromSource(src).gray9;
    var bits = "";
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        bits += g[y * 9 + x] >= g[y * 9 + x + 1] ? "1" : "0";
      }
    }
    return hexFromBits(bits);
  }

  /* ── Recognition ─────────────────────────────────────────────────── */
  function recognize(source) {
    var ahash = aHashHex(source);
    var dhash = dHashHex(source);
    showCaptured(source);
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    setStatus("正在识别这张封面…");
    fetch("/api/vinyl/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ahash: ahash, dhash: dhash }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
      })
      .then(function (data) {
        if (!data.match) {
          setStatus("没有认出这张封面 — 请对准封面、保持光线均匀后再试一次。");
          return;
        }
        setStatus("");
        renderResult(data.match, data.dhash_dist || 0);
      })
      .catch(function (e) {
        setStatus("识别失败：" + (e.message || "网络错误"));
      });
  }

  function showCaptured(source) {
    var c = document.createElement("canvas");
    c.width = source.naturalWidth || source.videoWidth || source.width || 320;
    c.height = source.naturalHeight || source.videoHeight || source.height || 320;
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    var img = document.createElement("img");
    img.src = c.toDataURL("image/jpeg", 0.85);
    img.alt = "captured cover";
    previewEl.innerHTML = "";
    previewEl.appendChild(img);
    previewEl.hidden = false;
  }

  function fmtLen(ms) {
    ms = Number(ms) || 0;
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }

  function renderResult(match, dhashDist) {
    var conf = Math.max(0, Math.round((1 - dhashDist / 64) * 100));
    var tracks = (match.tracks || []).map(function (t) {
      return (
        '<li class="vinyl-card-track"><span class="vinyl-track-num">' +
        String(t.position).padStart(2, "0") +
        "</span><span>" +
        escHtml(t.title) +
        '</span><span class="vinyl-track-len">' +
        fmtLen(t.length_ms) +
        "</span></li>"
      );
    });

    var facts = [];
    if (match.release_date) facts.push(String(match.release_date).slice(0, 4));
    if (match.country) facts.push(match.country);
    if (match.label) facts.push(match.label);
    if (match.catalog_number) facts.push(match.catalog_number);

    resultEl.innerHTML =
      '<div class="vinyl-card">' +
      '<div class="vinyl-card-art"><img src="' +
      escHtml(match.cover_path) +
      '" alt="' +
      escHtml(match.title) +
      ' cover" /></div>' +
      '<div class="vinyl-card-info">' +
      '<p class="vinyl-card-title">' +
      escHtml(match.title) +
      "</p>" +
      '<p class="vinyl-card-artist">' +
      escHtml(match.artist) +
      "</p>" +
      '<p class="vinyl-card-facts">' +
      escHtml(facts.join(" · ")) +
      "</p>" +
      '<p class="vinyl-card-note">匹配度 ' +
      conf +
      "%</p>" +
      '<button type="button" class="vinyl-share-btn" id="vinyl-share-btn">生成分享页</button>' +
      "</div>" +
      '<ol class="vinyl-card-tracks">' +
      tracks.join("") +
      "</ol>" +
      "</div>";

    resultEl.hidden = false;
    $("vinyl-share-btn").addEventListener("click", function () {
      if (window.openShareDialog) {
        window.openShareDialog({
          title: match.title + " — " + match.artist,
          path: "/vinyl/" + match.slug,
        });
      } else {
        window.location.href = "/vinyl/" + match.slug;
      }
    });
  }

  /* ── Public API for apps.js ──────────────────────────────────────── */
  window.VinylArchive = {
    init: initVinyl,
    stop: stopVinyl,
  };
})();
