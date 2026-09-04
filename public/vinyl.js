/* ── 黑胶档案 (Vinyl Archive) ─────────────────────────────────────────
 * Browse the local archive (= the 收藏库, records saved into the DB), or
 * search Discogs / MusicBrainz by text (artist / album / label / catalog).
 * Every result card shows the album metadata (date, label, catalog,
 * tracklist) and can be opened for details; the local archive generates a
 * nostalgic share page at /vinyl/:slug.  Live Discogs / MusicBrainz details
 * can be favorited (♥ 收藏) into the local archive: the server downloads
 * the cover and stores a vinyl_records row.
 *
 * Remote cover art always loads through the same-origin /api/vinyl/img proxy
 * (the server resolves the CURRENT cover by release id and caches it on
 * disk).  Search cards used to hotlink Discogs' CDN cover_image directly —
 * those URLs can go stale, so the cards came back blank while favorites
 * (whose cover is copied to /vinyl-art/) always rendered.
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

  var SOURCE_LABELS = { discogs: "Discogs", musicbrainz: "MusicBrainz" };
  function sourceName(s) {
    return SOURCE_LABELS[s] || (s ? s : "本地档案");
  }

  /* All live remote covers load through the same-origin proxy (never a direct
     hotlink to Discogs'/Cover Art Archive's CDN — stale links = blank cards).
     The server resolves the current cover by release id and disk-caches it. */
  function proxyArtUrl(source, id, size) {
    return (
      "/api/vinyl/img?source=" +
      encodeURIComponent(source) +
      "&id=" +
      encodeURIComponent(id) +
      (size === "full" ? "&size=full" : "")
    );
  }

  /* Art <div> for a card / detail.  `extLive` = true for a live search/detail
     item (cover must go through the proxy); false for archive rows whose
     cover is already stored locally under cover_path. */
  function vinylArtBox(item, extLive, size) {
    var src = "";
    if (!extLive) {
      src = item.cover_path || "";
    } else if (item.source === "discogs") {
      src = proxyArtUrl("discogs", item.discogs_id, size);
    } else if (item.has_cover !== false) {
      src = proxyArtUrl("musicbrainz", item.mbid, size);
    }
    if (!src) {
      return '<div class="vinyl-card-art vinyl-noart" aria-hidden="true">♫</div>';
    }
    return (
      '<div class="vinyl-card-art"><img src="' +
      escHtml(src) +
      '" alt="" loading="lazy" /></div>'
    );
  }

  /* Small colored chip naming the source of a card / detail. */
  function sourceChip(s) {
    var name = sourceName(s);
    return name ? ' <span class="vinyl-src-chip">' + escHtml(name) + "</span>" : "";
  }

  /* Hide any cover <img> that fails to load across the whole freshly-rendered
     result block (cards + details) — no broken-image glyphs under CSP. */
  function bindVinylImages(root) {
    if (!root) return;
    var imgs = root.querySelectorAll(".vinyl-card-art img");
    for (var i = 0; i < imgs.length; i++) hideImgOnError(imgs[i], "visibility");
  }

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
              ? "本地档案库里没有匹配「" + q + "」的唱片 — 试试「🔍 搜索」查 Discogs / MusicBrainz。"
              : "本地档案库还是空的 — 先用「🔍 搜索」在 Discogs / MusicBrainz 找到唱片，进入详情后点「♥ 收藏」即可存入。"
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
        bindVinylImages(resultEl);
        records.forEach(function (r) {
          var btn = $("vinyl-detail-local-" + r.slug);
          if (btn) btn.addEventListener("click", function () { showLocalDetail(r.slug); });
        });
      })
      .catch(function (e) {
        setStatus("读取档案失败：" + (e.message || "网络错误"));
      });
  }

  /* ── Text search (Discogs → MusicBrainz fallback) ─────────────────── */
  function runTextSearch() {
    var q = ($("vinyl-text-query").value || "").trim();
    if (!q) {
      // 不输入关键字 → 输出全部收藏（与「浏览档案」一致）
      browseArchive();
      return;
    }
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    setStatus("正在搜索 Discogs / MusicBrainz 唱片库…");
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
    var errors = data.externalErrors || {};
    var notes = [];
    function errFor(src) {
      return external.some(function (r) { return r.source === src; }) ? "" : errors[src];
    }
    var discogsErr = errFor("discogs");
    var mbErr = errFor("musicbrainz");
    if (discogsErr) notes.push("Discogs：" + discogsErr);
    if (mbErr) notes.push("MusicBrainz：" + mbErr);

    if (!local.length && !external.length) {
      setStatus(
        "没有找到匹配的唱片。" +
          (notes.length
            ? "（" + notes.join("；") + "）"
            : "试试更准确的艺人 + 专辑名，或加上厂牌 / 编号。")
      );
      return;
    }
    setStatus(notes.length ? notes.join("  ") : "");

    var discogsItems = external.filter(function (r) { return r.source === "discogs"; });
    var mbItems = external.filter(function (r) { return r.source === "musicbrainz"; });
    var parts = [];
    if (local.length) {
      parts.push('<p class="vinyl-src-head">📚 本地档案库 · ' + local.length + " 张</p>");
      local.forEach(function (r) {
        parts.push(searchCard(r, false, "查看档案"));
      });
    }
    if (discogsItems.length) {
      parts.push(
        '<p class="vinyl-src-head">💿 Discogs 数据库 · ' + discogsItems.length + " 条</p>"
      );
      discogsItems.forEach(function (r) {
        parts.push(searchCard(r, true, "查看详情"));
      });
    }
    if (mbItems.length) {
      parts.push(
        '<p class="vinyl-src-head">🎵 MusicBrainz 数据库 · ' + mbItems.length + " 条</p>"
      );
      mbItems.forEach(function (r) {
        parts.push(searchCard(r, true, "查看详情"));
      });
    }
    resultEl.innerHTML = '<div class="vinyl-search-list">' + parts.join("") + "</div>";
    resultEl.hidden = false;
    bindVinylImages(resultEl);
    local.forEach(function (r) {
      var btn = $("vinyl-detail-local-" + r.slug);
      if (btn) btn.addEventListener("click", function () { showLocalDetail(r.slug); });
    });
    discogsItems.forEach(function (r) {
      var btn = $("vinyl-detail-" + r.discogs_id);
      if (btn) btn.addEventListener("click", function () { showLiveDetail("discogs", r.discogs_id); });
    });
    mbItems.forEach(function (r) {
      var btn = $("vinyl-detail-" + r.mbid);
      if (btn) btn.addEventListener("click", function () { showLiveDetail("musicbrainz", r.mbid); });
    });
  }

  function searchCard(r, external, actionText) {
    var facts = [];
    if (r.year) facts.push(r.year);
    else if (r.release_date) facts.push(String(r.release_date).slice(0, 4));
    if (r.country) facts.push(r.country);
    if (r.label) facts.push(r.label);
    if (r.catalog_number) facts.push(r.catalog_number);
    var btnId = external
      ? "vinyl-detail-" + (r.source === "musicbrainz" ? r.mbid : r.discogs_id)
      : "vinyl-detail-local-" + r.slug;
    var chip = sourceChip(r.source);
    return (
      '<div class="vinyl-card vinyl-search-item">' +
      vinylArtBox(r, external, "card") +
      '<div class="vinyl-card-info">' +
      '<p class="vinyl-card-title">' +
      escHtml(r.title) +
      chip +
      "</p>" +
      '<p class="vinyl-card-artist">' +
      escHtml(r.artist) +
      "</p>" +
      '<p class="vinyl-card-facts">' +
      escHtml(facts.join(" · ")) +
      "</p>" +
      '<button type="button" class="app-open" id="' +
      btnId +
      '">📄 ' +
      actionText +
      "</button>" +
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

  /* Fetch a live Discogs / MusicBrainz release's full detail and render it.
   * A lookup on its own stores nothing on the server; pressing
   * 「♥ 收藏到本地档案库」 is the explicit opt-in that saves the release into
   * the local archive (Discogs records additionally get a live share page at
   * /vinyl/discogs/:id). */
  function showLiveDetail(source, id) {
    resultEl.innerHTML = "";
    setStatus("正在从 " + sourceName(source) + " 获取条目详情…");
    fetch(
      "/api/vinyl/lookup?source=" + encodeURIComponent(source) + "&id=" + encodeURIComponent(id)
    )
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
      })
      .then(function (data) {
        renderLiveDetail(data.detail);
        setStatus("");
      })
      .catch(function (e) {
        setStatus("获取详情失败：" + (e.message || "网络错误"));
      });
  }

  /* Live detail card — the same layout renders Discogs and MusicBrainz
   * records (their normalized detail shapes share these keys).  The cover
   * <img> always goes through the proxy; for MusicBrainz it may even fall
   * back to the release-group art a search row doesn't know about. */
  function renderLiveDetail(d) {
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
    var source = d.source === "musicbrainz" ? "musicbrainz" : "discogs";
    // MusicBrainz has no server-rendered live share page → deep-link to the
    // MusicBrainz record instead of a 生成分享页 button.
    var shareOrLink =
      source === "discogs"
        ? '<button type="button" class="vinyl-share-btn" id="vinyl-share-btn">生成分享页</button>'
        : d.musicbrainz_url
        ? '<a class="vinyl-ext-link" href="' +
          escHtml(d.musicbrainz_url) +
          '" target="_blank" rel="noopener noreferrer">在 MusicBrainz 查看 ↗</a>'
        : "";

    resultEl.innerHTML =
      '<div class="vinyl-card">' +
      vinylArtBox(
        { source: source, discogs_id: d.discogs_id, mbid: d.mbid, cover_path: "", has_cover: true },
        true,
        "full"
      ) +
      '<div class="vinyl-card-info">' +
      '<p class="vinyl-card-title">' +
      escHtml(d.title) +
      sourceChip(source) +
      "</p>" +
      '<p class="vinyl-card-artist">' +
      escHtml(d.artist) +
      "</p>" +
      '<p class="vinyl-card-facts">' +
      escHtml(facts.join(" · ")) +
      "</p>" +
      (styles.length ? '<p class="vinyl-card-facts">' + escHtml(styles.join(" · ")) + "</p>" : "") +
      '<p class="vinyl-card-note">数据来源：' +
      sourceName(source) +
      (source === "discogs" ? " · Release #" + escHtml(d.discogs_id) : " · Cover Art Archive") +
      "</p>" +
      '<div class="vinyl-card-actions">' +
      shareOrLink +
      '<button type="button" class="vinyl-fav-btn" id="vinyl-fav-btn">♥ 收藏到本地档案库</button>' +
      "</div>" +
      "</div>" +
      (tracks.length ? '<ol class="vinyl-card-tracks">' + tracks.join("") + "</ol>" : "") +
      "</div>";

    resultEl.hidden = false;
    // Live 条目封面加载失败时隐藏（替代模板里的 inline onerror，被 CSP 拦截）。
    bindVinylImages(resultEl);
    if (source === "discogs") {
      var shareBtn = $("vinyl-share-btn");
      if (shareBtn) {
        shareBtn.addEventListener("click", function () {
          var sharePath = "/vinyl/discogs/" + d.discogs_id;
          if (window.openShareDialog) {
            window.openShareDialog({ title: d.title + " — " + d.artist, path: sharePath });
          } else {
            window.location.href = sharePath;
          }
        });
      }
    }
    var favBtn = $("vinyl-fav-btn");
    if (favBtn) favBtn.addEventListener("click", function () { favoriteLiveRelease(d); });
  }

  /* Save a live Discogs / MusicBrainz release into the local archive DB (收藏):
   * the server downloads the cover locally and upserts a vinyl_records row, so
   * the album shows up under 浏览档案 / local search / /vinyl/:slug from then on. */
  function favoriteLiveRelease(d) {
    var btn = $("vinyl-fav-btn");
    if (!btn || btn.disabled) return;
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "收藏中…";
    var source = d.source === "musicbrainz" ? "musicbrainz" : "discogs";
    var id =
      source === "musicbrainz" ? d.mbid : d.discogs_id != null ? d.discogs_id : d.id;
    fetch("/api/vinyl/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: source, id: id }),
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
    var srcNote =
      match.source === "discogs" || match.source === "musicbrainz"
        ? '<p class="vinyl-card-note">来源：' +
          sourceName(match.source) +
          (match.source === "discogs" && match.discogs_id ? " · Release #" + escHtml(match.discogs_id) : "") +
          "</p>"
        : "";

    resultEl.innerHTML =
      '<div class="vinyl-card">' +
      vinylArtBox(match, false, "full") +
      '<div class="vinyl-card-info">' +
      '<p class="vinyl-card-title">' +
      escHtml(match.title) +
      sourceChip(match.source) +
      "</p>" +
      '<p class="vinyl-card-artist">' +
      escHtml(match.artist) +
      "</p>" +
      '<p class="vinyl-card-facts">' +
      escHtml(facts.join(" · ")) +
      "</p>" +
      srcNote +
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
    bindVinylImages(resultEl);
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
