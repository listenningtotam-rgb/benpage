/* ── 黑胶档案 (Vinyl Archive) ─────────────────────────────────────────
 * Browse the local archive (= the 收藏库, records saved into the DB), or
 * search Discogs by text (artist / album / label / catalog).  The result
 * card shows the album metadata (date, label, catalog, tracklist) and can
 * generate a nostalgic share page at /vinyl/:slug.  Live Discogs details
 * can be favorited (♥ 收藏) into the local archive: the server downloads
 * the cover and stores a vinyl_records row.
 * --------------------------------------------------------------------- */
(function () {
  "use strict";

  var statusEl, resultEl;

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

  /* CSP 'script-src self' 禁止 inline onerror 属性（哈希对事件属性无效），
   * 统一改用 addEventListener 监听图片加载失败：
   *   mode === "display"    → display:none     （首页静态缩略图）
   *   其它（默认 visibility）→ visibility:hidden（Discogs 结果卡片） */
  function hideImgOnError(img, mode) {
    if (!img) return;
    var apply = function () {
      if (mode === "display") img.style.display = "none";
      else img.style.visibility = "hidden";
    };
    img.addEventListener("error", apply);
    // 图片若已加载完成且失败（缓存/瞬时失败），error 事件可能已错过，兜底检查。
    if (img.complete && img.naturalWidth === 0) apply();
  }

  /* 首页黑胶缩略图（static HTML 中的 img）：加载失败时隐藏。
   * 脚本位于 <body> 末尾执行，DOM 已就绪。 */
  hideImgOnError(document.querySelector(".thumb-vinyl-art img"), "display");

  /* ── Setup (idempotent — called every time the panel opens) ──────── */
  function initVinyl() {
    if (!statusEl) {
      statusEl = $("vinyl-status");
      resultEl = $("vinyl-result");

      $("vinyl-browse-btn").addEventListener("click", browseArchive);
      $("vinyl-text-search-btn").addEventListener("click", runTextSearch);
      $("vinyl-text-query").addEventListener("keydown", function (e) {
        if (e.key === "Enter") runTextSearch();
      });
    }
    setStatus("");
    resetView();
  }

  function resetView() {
    if (resultEl) {
      resultEl.hidden = true;
      resultEl.innerHTML = "";
    }
  }

  /* ── Browse the local archive (收藏库) ────────────────────────────────
   * The search box doubles as an optional keyword filter over the saved
   * archive; leaving it empty lists every 收藏 record in the DB. */
  function browseArchive() {
    var q = ($("vinyl-text-query").value || "").trim();
    resultEl.innerHTML = "";
    setStatus("正在读取本地档案库…");
    fetch("/api/vinyl" + (q ? "?q=" + encodeURIComponent(q) : ""))
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
      })
      .then(function (data) {
        var records = data.records || [];
        if (!records.length) {
          setStatus(
            q
              ? "本地档案库里没有匹配「" + q + "」的唱片。"
              : "本地档案库还是空的 — 先用「🔍 搜索」在 Discogs 找到唱片，进入详情后点「♥ 收藏」即可存入。"
          );
          return;
        }
        setStatus(
          "本地档案库共 " +
            records.length +
            " 张唱片" +
            (q ? "（关键字「" + q + "」）" : "") +
            " — 点击任意一张查看详情，或生成分享页。"
        );
        resultEl.innerHTML =
          '<div class="vinyl-search-list">' +
          records
            .map(function (r) {
              return searchCard(r, false, "查看档案");
            })
            .join("") +
          "</div>";
        resultEl.hidden = false;
        records.forEach(function (r) {
          var btn = $("vinyl-detail-local-" + r.slug);
          if (btn) btn.addEventListener("click", function () { showLocalDetail(r.slug); });
        });
      })
      .catch(function (e) {
        setStatus("读取档案失败：" + (e.message || "网络错误"));
      });
  }

  /* ── Text search (Discogs) ───────────────────────────────────────── */
  function runTextSearch() {
    var q = ($("vinyl-text-query").value || "").trim();
    if (!q) {
      // 不输入关键字 → 输出全部收藏（与「浏览档案」一致）
      browseArchive();
      return;
    }
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
        ? '<p class="vinyl-card-note">数据来源：Discogs 数据库 — 点击条目查看详情（发行年份、艺术家、厂牌、曲目等）；需要保存时，进入详情后点「♥ 收藏」即可存入本地档案库</p>'
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
    else if (r.release_date) facts.push(String(r.release_date).slice(0, 4));
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
        renderResult(data.record);
        setStatus("已显示档案中的唱片信息。");
      })
      .catch(function (e) {
        setStatus("读取失败：" + (e.message || "网络错误"));
      });
  }

  /* Fetch a Discogs release's full detail live and render it.  A lookup on
   * its own stores nothing on the server (and the /vinyl/discogs/:id share
   * page re-fetches the same live data); pressing 「♥ 收藏到本地档案库」 is the
   * explicit opt-in that saves the release into the local archive. */
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
      ' cover" /></div>' +
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
      '<div class="vinyl-card-actions">' +
      '<button type="button" class="vinyl-share-btn" id="vinyl-share-btn">生成分享页</button>' +
      '<button type="button" class="vinyl-fav-btn" id="vinyl-fav-btn">♥ 收藏到本地档案库</button>' +
      "</div>" +
      "</div>" +
      (tracks.length ? '<ol class="vinyl-card-tracks">' + tracks.join("") + "</ol>" : "") +
      "</div>";

    resultEl.hidden = false;
    // Discogs 结果卡片封面加载失败时隐藏（替代模板里的 inline onerror，被 CSP 拦截）。
    hideImgOnError(resultEl.querySelector(".vinyl-card-art img"), "visibility");
    $("vinyl-share-btn").addEventListener("click", function () {
      var sharePath = "/vinyl/discogs/" + d.discogs_id;
      if (window.openShareDialog) {
        window.openShareDialog({ title: d.title + " — " + d.artist, path: sharePath });
      } else {
        window.location.href = sharePath;
      }
    });
    var favBtn = $("vinyl-fav-btn");
    if (favBtn) favBtn.addEventListener("click", function () { favoriteDiscogsRelease(d); });
  }

  /* Save a live Discogs release into the local archive DB (收藏): the server
   * downloads the cover locally and upserts a vinyl_records row, so the album
   * shows up under 浏览档案 / local search / /vinyl/:slug from then on. */
  function favoriteDiscogsRelease(d) {
    var btn = $("vinyl-fav-btn");
    if (!btn || btn.disabled) return;
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "收藏中…";
    fetch("/api/vinyl/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discogs_id: d.discogs_id }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
      })
      .then(function (data) {
        btn.textContent = "✓ 已收藏到本地档案库";
        btn.classList.add("is-faved");
        setStatus(
          data && data.already
            ? "这张唱片已在本地档案库中 — 点「📚 浏览档案」即可看到。"
            : "已收藏到本地档案库 — 点「📚 浏览档案」即可看到这张唱片。"
        );
      })
      .catch(function (e) {
        btn.disabled = false;
        btn.textContent = original;
        setStatus("收藏失败：" + (e.message || "网络错误"));
      });
  }

  function fmtLen(ms) {
    ms = Number(ms) || 0;
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }

  /* ── Archive album detail card ───────────────────────────────────── */
  function renderResult(match) {
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
      '<div class="vinyl-card-actions">' +
      '<button type="button" class="vinyl-share-btn" id="vinyl-share-btn">生成分享页</button>' +
      '<button type="button" class="vinyl-fav-btn is-faved" id="vinyl-fav-btn" disabled title="已收藏在本地档案库中">✓ 已在档案库</button>' +
      "</div>" +
      "</div>" +
      '<ol class="vinyl-card-tracks">' +
      tracks.join("") +
      "</ol>" +
      "</div>";

    resultEl.hidden = false;
    // 档案卡片封面加载失败时隐藏（本地封面缺失时不留破图）。
    hideImgOnError(resultEl.querySelector(".vinyl-card-art img"), "visibility");
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
    // Photo capture was removed; stop() stays a no-op so apps.js's panel
    // close handler keeps working unchanged.
    stop: function () {},
  };
})();
