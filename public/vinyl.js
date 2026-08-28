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
      $("vinyl-text-search-btn").addEventListener("click", runTextSearch);
      $("vinyl-text-query").addEventListener("keydown", function (e) {
        if (e.key === "Enter") runTextSearch();
      });

      // Load the archive album list into the demo picker (also proves the
      // /api/vinyl endpoint works).  When the archive is empty there is
      // nothing to demo, so hide the whole "识别示例" row.
      fetch("/api/vinyl")
        .then(function (res) {
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.records) return;
          if (!data.records.length) {
            var demoRow = demoSelect && demoSelect.closest(".vinyl-demo");
            if (demoRow) demoRow.hidden = true;
            return;
          }
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
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(
        "无法访问摄像头 — 浏览器需要 HTTPS 或 localhost 才会开放摄像头权限。请改用“从相册选择”或“识别示例”。"
      );
      return;
    }
    setStatus("正在启动摄像头…");
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        // Arm the capture button + show the live preview immediately, even
        // before play() settles, so a slow/blocked play() can never leave
        // the UI stuck with no feedback.
        video.hidden = false;
        capturing = true;
        $("vinyl-camera").textContent = "📷 点击拍照";
        setStatus("摄像头已开启 — 对准封面后点击“点击拍照”。");
        var readyTimer = setTimeout(function () {
          setStatus("摄像头画面暂未就绪，仍可点击拍照（将按默认画幅截取）。");
        }, 2500);
        var playP = video.play();
        if (playP && typeof playP.then === "function") {
          return playP
            .catch(function () {
              // Autoplay blocked — the tag is muted+playsinline, but some
              // WebViews still reject play(); capture via drawImage still
              // works once a frame is available, so keep the camera armed.
              setStatus("摄像头已开启 — 对准封面后点击“点击拍照”。");
              return null;
            })
            .then(function () {
              clearTimeout(readyTimer);
              if (!video.videoWidth || !video.videoHeight) {
                setStatus("摄像头画面暂未就绪，仍可点击拍照（将按默认画幅截取）。");
              } else {
                setStatus("");
              }
            });
        }
        clearTimeout(readyTimer);
        setStatus("摄像头已开启 — 对准封面后点击“点击拍照”。");
        return null;
      })
      .catch(function (e) {
        setStatus(
          "无法打开摄像头（" +
            (e && e.name ? e.name : "权限被拒绝") +
            "）— 请改用“从相册选择”或“识别示例”。"
        );
      });
  }

  function capturePhoto() {
    if (!video.videoWidth || !video.videoHeight) {
      setStatus("画面还没就绪，请稍等片刻再点击拍照。");
      return;
    }
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

  /* ── Text search (Discogs) + import ──────────────────────────────── */
  function runTextSearch() {
    var q = ($("vinyl-text-query").value || "").trim();
    if (!q) {
      setStatus("请输入文字描述（艺人 / 专辑 / 厂牌 / 编号）。");
      return;
    }
    stopVinyl();
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    setStatus("正在搜索 Discogs 唱片库…");
    fetch("/api/vinyl/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: q }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
      })
      .then(renderSearchResults)
      .catch(function (e) {
        setStatus("搜索失败：" + (e.message || "网络错误"));
      });
  }

  function renderSearchResults(data) {
    var local = data.local || [];
    var external = data.external || [];
    var notes = [];
    if (data.externalError) notes.push("Discogs：" + data.externalError);
    if (!data.externalEnabled && !local.length) {
      setStatus("没有找到匹配的唱片。" + (notes.length ? " " + notes[0] : ""));
      return;
    }
    if (!data.externalEnabled) {
      setStatus(
        "仅搜到本地档案 " + local.length + " 条 — 未配置 Discogs token，全网搜索未开启。"
      );
    } else {
      setStatus(notes.join(" "));
    }
    if (!local.length && !external.length) {
      setStatus("没有找到匹配的唱片。试试更准确的艺人 + 专辑名，或加上厂牌 / 编号。");
      return;
    }
    var cards = [];
    local.forEach(function (r) {
      cards.push(searchCard(r, false, "查看档案"));
    });
    external.forEach(function (r) {
      cards.push(searchCard(r, true, "查看详情"));
    });
    resultEl.innerHTML =
      '<div class="vinyl-search-list">' +
      (data.externalEnabled
        ? '<p class="vinyl-card-note">数据来源：Discogs 数据库 — 点击条目查看详情（发行年份、艺术家、厂牌、曲目等），只做浏览，不会保存到服务器</p>'
        : "") +
      cards.join("") +
      "</div>";
    resultEl.hidden = false;
    local.forEach(function (r) {
      var btn = $("vinyl-detail-local-" + r.slug);
      if (btn) btn.addEventListener("click", function () { showLocalDetail(r.slug); });
    });
    external.forEach(function (r) {
      var btn = $("vinyl-detail-" + r.discogs_id);
      if (btn) btn.addEventListener("click", function () { showDiscogsDetail(r.discogs_id); });
    });
  }

  function searchCard(r, external, actionText) {
    var facts = [];
    if (r.year) facts.push(r.year);
    if (r.country) facts.push(r.country);
    if (r.label) facts.push(r.label);
    if (r.catalog_number) facts.push(r.catalog_number);
    var art = r.cover_image || r.thumb || r.cover_path || "";
    var btnId = external ? "vinyl-detail-" + r.discogs_id : "vinyl-detail-local-" + r.slug;
    return (
      '<div class="vinyl-card vinyl-search-item">' +
      '<div class="vinyl-card-art"><img src="' + escHtml(art) + '" alt="' + escHtml(r.title) + ' cover" /></div>' +
      '<div class="vinyl-card-info">' +
      '<p class="vinyl-card-title">' + escHtml(r.title) + "</p>" +
      '<p class="vinyl-card-artist">' + escHtml(r.artist) + "</p>" +
      '<p class="vinyl-card-facts">' + escHtml(facts.join(" · ")) + "</p>" +
      '<button type="button" class="app-open" id="' + btnId + '">📄 ' + actionText + "</button>" +
      "</div>" +
      "</div>"
    );
  }

  function showLocalDetail(slug) {
    resultEl.innerHTML = "";
    setStatus("正在读取档案条目…");
    fetch("/api/vinyl/" + slug)
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
      })
      .then(function (data) {
        renderResult(data.record, 0);
        setStatus("已显示档案中的唱片信息。");
      })
      .catch(function (e) {
        setStatus("读取失败：" + (e.message || "网络错误"));
      });
  }

  /* Fetch a Discogs release's full detail live and render it — no import,
   * nothing is stored on the server, the share page (/vinyl/discogs/:id)
   * re-fetches the same live data so it can never go stale. */
  function showDiscogsDetail(discogsId) {
    resultEl.innerHTML = "";
    setStatus("正在从 Discogs 获取条目 #" + discogsId + " 的详情…");
    fetch("/api/vinyl/lookup?discogs_id=" + discogsId)
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
      })
      .then(function (data) {
        renderDiscogsDetail(data.detail);
        setStatus("");
      })
      .catch(function (e) {
        setStatus("获取详情失败：" + (e.message || "网络错误"));
      });
  }

  function renderDiscogsDetail(d) {
    var tracks = (d.tracks || []).map(function (t, i) {
      return (
        '<li class="vinyl-card-track"><span class="vinyl-track-num">' +
        (t.position != null ? String(t.position).padStart(2, "0") : String(i + 1).padStart(2, "0")) +
        "</span><span>" +
        escHtml(t.title) +
        '</span><span class="vinyl-track-len">' +
        (t.length_ms ? fmtLen(t.length_ms) : "") +
        "</span></li>"
      );
    });
    var facts = [];
    if (d.year) facts.push(d.year);
    if (d.country) facts.push(d.country);
    if (d.label) facts.push(d.label);
    if (d.catalog_number) facts.push(d.catalog_number);
    if (d.formats) facts.push(d.formats);
    var styles = (d.genres || []).concat(d.styles || []).slice(0, 6);
    var art = d.cover_image || "";

    resultEl.innerHTML =
      '<div class="vinyl-card">' +
      '<div class="vinyl-card-art"><img src="' +
      escHtml(art) +
      '" alt="' +
      escHtml(d.title) +
      ' cover" onerror="this.style.visibility=\'hidden\';" /></div>' +
      '<div class="vinyl-card-info">' +
      '<p class="vinyl-card-title">' +
      escHtml(d.title) +
      "</p>" +
      '<p class="vinyl-card-artist">' +
      escHtml(d.artist) +
      "</p>" +
      '<p class="vinyl-card-facts">' +
      escHtml(facts.join(" · ")) +
      "</p>" +
      (styles.length ? '<p class="vinyl-card-facts">' + escHtml(styles.join(" · ")) + "</p>" : "") +
      '<p class="vinyl-card-note">数据来源：Discogs · Release #' +
      escHtml(d.discogs_id) +
      "</p>" +
      '<button type="button" class="vinyl-share-btn" id="vinyl-share-btn">生成分享页</button>' +
      "</div>" +
      (tracks.length ? '<ol class="vinyl-card-tracks">' + tracks.join("") + "</ol>" : "") +
      "</div>";

    resultEl.hidden = false;
    $("vinyl-share-btn").addEventListener("click", function () {
      var sharePath = "/vinyl/discogs/" + d.discogs_id;
      if (window.openShareDialog) {
        window.openShareDialog({ title: d.title + " — " + d.artist, path: sharePath });
      } else {
        window.location.href = sharePath;
      }
    });
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
          setStatus(
            "没有认出这张封面 — 档案里目前没有匹配的唱片（服务器不保存黑胶数据）。请改用上面的“文字搜索”直接从 Discogs 查询这张唱片，或对准封面、避开反光后重试。"
          );
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
