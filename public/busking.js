/* ── 路演 (Apps → 路演) ─────────────────────────────────────────────
 * A street-gig board.  The admin publishes an activity (主题 / 风格 / 人数 /
 * 时间段 / 地点); from then on the board is public:
 *   · anyone may browse published activities and tap ♥ 喜欢 — likes are
 *     anonymous and deduped per visitor (an id kept in localStorage)
 *   · 我要加入 needs a member account created from a 路演 invite code
 *     (邀请码登录 → 名字 / 邮箱 / 擅长的乐器) and stops at the capacity with a
 *     polite apology instead of a bare error (婉约拒绝)
 *   · the participant list (name + the instrument each one is responsible
 *     for) and the highlight photos of a finished activity are public
 *   · the admin can create / publish / finish / delete an activity and add
 *     精彩回顾 photos of a finished one straight from the detail view
 *   · every activity entry (board card + detail) can be shared on its own:
 *     分享 ↗ opens the site share dialog (QR / link / short link, share.js)
 *     for the server-rendered page /busking/:id — see shareEvent() below and
 *     renderBuskingSharePage() in server.js; that page links back here as
 *     /busking?e=<id>, which opens the activity straight away
 *
 * Server:  server.js → /api/busking/* (+ /api/admin/busking/invites…)
 * Panel:   index.html → #app-busking, opened by apps.js at /busking
 * Admin:   admin.html → 路演 tab (activities + invite codes)
 * ------------------------------------------------------------------- */
(function () {
  "use strict";

  var root = document.getElementById("busking-root");
  if (!root) return;

  var TOKEN_KEY = "benpage_busking_token";
  var VISITOR_KEY = "benpage_busking_visitor";
  var ADMIN_TOKEN_KEY = "benpage_admin_token";

  var state = {
    user: null,
    isMember: false,
    isAdmin: false,
    events: [],
    openId: null,   // activity shown in the detail view (null = the board)
    detail: null,
    showForm: false, // admin: the "new activity" form
    formDraft: null, // what was typed there, kept across a re-render
    busy: false,
    loading: false,
    notice: null,    // { text, kind } — polite replies, incl. the 满员婉拒
    formError: "",
    profileError: "",
    loadError: "",
    photoError: "",
    loaded: false,
  };

  /* ── Small helpers ─────────────────────────────────────── */

  function $(sel, scope) {
    return (scope || root).querySelector(sel);
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // The app's own member token wins; an admin signed in to the console (same
  // origin) can work as the admin without logging in twice.
  function buskToken() {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(ADMIN_TOKEN_KEY) || "";
  }

  function buskVisitor() {
    var v = localStorage.getItem(VISITOR_KEY);
    if (!v) {
      v = "v" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(VISITOR_KEY, v);
    }
    return v;
  }

  /* A request that never got an answer (server stopped or restarted, the page
     opened as a file:// URL, wifi dropped) rejects with a bare "Failed to
     fetch" TypeError that hides what to do about it. Keep the raw error in the
     console and hand the notice a sentence a musician can act on. */
  function networkError(err, method, path) {
    console.error("[busking] " + method + " " + path + " got no response:", err);
    if (!(err instanceof TypeError)) return err;
    var why =
      location.protocol === "file:"
        ? "本页是直接打开的本地文件，请改用 http://localhost:3000/busking 打开"
        : typeof navigator !== "undefined" && navigator.onLine === false
          ? "网络似乎断开了，恢复后再试一次"
          : "后台没有响应 —— 确认 server 正在运行（npm start，改过代码要重启）后重试一次";
    var e = new Error("连不上服务器（Failed to fetch）：" + why + " · " + method + " " + path);
    e.status = 0;
    e.code = "network";
    e.cause = err;
    return e;
  }

  async function buskApi(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {});
    var token = buskToken();
    if (token) headers.Authorization = "Bearer " + token;
    if (opts.body && typeof opts.body === "string") headers["Content-Type"] = "application/json";
    var res;
    try {
      res = await fetch(path, Object.assign({}, opts, { headers: headers }));
    } catch (err) {
      throw networkError(err, opts.method || "GET", path);
    }
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      var err = new Error(data.error || "请求失败（HTTP " + res.status + "）");
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  function setNotice(text, kind) {
    state.notice = text ? { text: text, kind: kind || "info" } : null;
  }

  function statusLabel(s) {
    if (s === "published") return "报名中";
    if (s === "finished") return "已收官";
    return "草稿";
  }

  function fmtWhen(v) {
    return String(v || "").replace("T", " ").slice(0, 16);
  }

  /* ── Identity + data loading ───────────────────────────── */

  async function refreshIdentity() {
    state.user = null;
    state.isMember = false;
    state.isAdmin = false;
    if (!buskToken()) return;
    try {
      var data = await buskApi("/api/busking/me");
      state.user = data.user;
      state.isMember = !!data.is_member;
      state.isAdmin = !!data.is_admin;
    } catch (err) {
      // Expired / removed account → fall back to guest. Only the app's own
      // token is dropped here, never the admin console's session: this is the
      // automatic path, and a valid console session still works. An explicit
      // 退出 does sign the console out too — see logout().
      if (err.status === 401) localStorage.removeItem(TOKEN_KEY);
    }
  }

  async function loadBoard() {
    state.loadError = "";
    try {
      var data = await buskApi("/api/busking/events?visitor=" + encodeURIComponent(buskVisitor()));
      state.events = data.events || [];
      state.isAdmin = !!data.is_admin || state.isAdmin;
      state.isMember = !!data.is_member || state.isMember;
    } catch (err) {
      state.loadError = err.message;
      state.events = [];
    }
  }

  async function openDetail(id) {
    state.openId = id;
    state.detail = null;
    state.photoError = "";
    render();
    try {
      var data = await buskApi(
        "/api/busking/events/" + id + "?visitor=" + encodeURIComponent(buskVisitor())
      );
      state.detail = data;
      state.isAdmin = !!data.is_admin || state.isAdmin;
      state.isMember = !!data.is_member || state.isMember;
    } catch (err) {
      state.openId = null;
      setNotice(err.message, "error");
    }
    render();
  }

  async function refreshDetail() {
    if (!state.openId) return;
    try {
      state.detail = await buskApi(
        "/api/busking/events/" + state.openId + "?visitor=" + encodeURIComponent(buskVisitor())
      );
    } catch (err) {
      setNotice(err.message, "error");
    }
    await loadBoard();
    render();
  }

  /* ── Render: toolbar ───────────────────────────────────── */

  function render() {
    if (!state.loaded) {
      root.innerHTML = '<div class="busk-empty">正在载入路演活动…</div>';
      return;
    }
    var html = renderToolbar();
    html += state.openId && state.detail ? renderDetail() : renderBoard();
    root.innerHTML = html;
  }

  function renderToolbar() {
    var who = "";
    if (state.user) {
      var name = state.user.nickname || state.user.username;
      var role = state.isAdmin ? "管理员" : state.isMember ? "路演成员" : "已登录";
      who =
        '<span class="busk-chip' + (state.isMember || state.isAdmin ? " is-member" : "") + '">' +
        esc(role) + " · " + esc(name) + "</span>" +
        '<button type="button" class="rc-btn rc-btn-ghost" data-busk-act="logout">退出</button>';
    } else {
      who =
        '<form class="busk-login" data-busk-form="login">' +
        '<input type="text" name="code" class="busk-input" placeholder="路演邀请码 / invite code" maxlength="64" autocomplete="off" />' +
        '<button type="submit" class="rc-btn rc-btn-primary">成员登录</button>' +
        "</form>";
    }

    var html =
      '<div class="busk-toolbar">' +
      '<div class="busk-bar">' +
      '<span class="busk-bar-title">路演</span>' +
      (state.isAdmin
        ? '<button type="button" class="rc-btn rc-btn-primary" data-busk-act="new">＋ 发布活动</button>'
        : "") +
      who +
      "</div>";

    if (state.user && state.isMember && !state.user.profile_complete) html += renderProfileCard();

    if (!state.user) {
      html +=
        '<p class="busk-hint">想听演出？直接浏览下面的活动、点 ♥ 喜欢就行。' +
        "想上台演出？用管理员给你的 <b>路演邀请码</b> 登录，登记名字 / 邮箱 / 擅长的乐器，之后就能「我要加入」。</p>";
    }
    if (state.notice) {
      html +=
        '<div class="busk-notice busk-notice-' + esc(state.notice.kind) + '">' +
        esc(state.notice.text) +
        '<button type="button" class="busk-notice-close" data-busk-act="notice-clear" aria-label="关闭">&times;</button>' +
        "</div>";
    }
    html += "</div>";
    return html;
  }

  /* Invite login is followed by this: 名字 / 邮箱 / 擅长的乐器. */
  function renderProfileCard() {
    var u = state.user || {};
    return (
      '<div class="busk-card busk-profile-card">' +
      "<h4>完善成员资料 · Finish your profile</h4>" +
      '<p class="busk-hint">邀请码已验证 ✓ 留下名字、邮箱和你擅长的乐器 ——「我要加入」时会自动带上，名单上也会公开显示你的乐器。</p>' +
      (state.profileError ? '<p class="busk-error">' + esc(state.profileError) + "</p>" : "") +
      '<form class="busk-form" data-busk-form="profile">' +
      '<label class="busk-field">名字 Name<input type="text" name="nickname" class="busk-input" maxlength="60" value="' +
      esc(u.nickname || "") + '" placeholder="你希望大家怎么叫你" /></label>' +
      '<label class="busk-field">邮箱 Email<input type="email" name="email" class="busk-input" maxlength="200" value="' +
      esc(u.email || "") + '" placeholder="you@example.com" /></label>' +
      '<label class="busk-field">擅长的乐器 Instrument<input type="text" name="instrument" class="busk-input" maxlength="60" value="' +
      esc(u.instrument || "") + '" placeholder="吉他 / 鼓 / 贝斯 / 主唱 / 键盘…" /></label>' +
      '<button type="submit" class="rc-btn rc-btn-primary">保存资料</button>' +
      "</form>" +
      "</div>"
    );
  }


  /* ── Render: the board ─────────────────────────────────── */

  function renderBoard() {
    if (state.showForm) return renderNewForm();

    var html = "";
    if (state.loadError) {
      html += '<div class="busk-error">' + esc(state.loadError) + "</div>";
    }
    if (!state.events.length) {
      html +=
        '<div class="busk-empty">还没有活动哦 —— ' +
        (state.isAdmin ? "点上面的「＋ 发布活动」开一场 🎶" : "等管理员发布第一场路演 🎶") +
        "</div>";
      return html;
    }

    html += '<div class="busk-grid">';
    state.events.forEach(function (e) {
      html += renderCard(e);
    });
    html += "</div>";
    return html;
  }

  function renderCard(e) {
    var seats = e.capacity > 0 ? e.join_count + " / " + e.capacity + " 人" : "不限人数";
    var cover = e.cover_url
      ? '<img class="busk-cover" src="' + esc(e.cover_url) + '" alt="" loading="lazy" />'
      : '<div class="busk-cover busk-cover-empty">' + (e.status === "finished" ? "精彩回顾" : "♪") + "</div>";

    var badge =
      '<span class="busk-badge busk-badge-' + esc(e.status) + '">' + statusLabel(e.status) + "</span>";
    var full = e.is_full
      ? '<span class="busk-badge busk-badge-full">已满员</span>'
      : "";

    return (
      '<article class="busk-card" data-busk-act="open" data-id="' + e.id + '" tabindex="0" role="button">' +
      cover +
      '<div class="busk-card-body">' +
      '<div class="busk-card-head"><h4 class="busk-card-title">' + esc(e.title) + "</h4>" + badge + full + "</div>" +
      (e.style ? '<p class="busk-card-style">风格 · ' + esc(e.style) + "</p>" : "") +
      '<ul class="busk-meta">' +
      (e.time_slot ? "<li>🕒 " + esc(e.time_slot) + "</li>" : "") +
      (e.location ? "<li>📍 " + esc(e.location) + "</li>" : "") +
      "<li>🎻 " + esc(seats) + (e.join_count ? " · 已报名" : "") + "</li>" +
      "</ul>" +
      '<div class="busk-card-foot">' +
      '<button type="button" class="busk-like' + (e.liked ? " is-liked" : "") + '" data-busk-act="like" data-id="' + e.id + '" title="喜欢">' +
      (e.liked ? "♥" : "♡") + " " + (e.like_count || 0) +
      "</button>" +
      shareButton(e) +
      (e.joined ? '<span class="busk-joined">已在名单</span>' : "") +
      "</div>" +
      "</div>" +
      "</article>"
    );
  }

  /* Admin: create an activity — 主题 / 风格 / 人数 / 时间段 / 地点, then either
     publish it right away or keep it as a draft. */
  function renderNewForm() {
    var d = state.formDraft || {};
    return (
      '<div class="busk-card busk-new-card">' +
      "<h4>发布一场路演</h4>" +
      (state.formError ? '<p class="busk-error">' + esc(state.formError) + "</p>" : "") +
      '<form class="busk-form" data-busk-form="new">' +
      '<label class="busk-field">主题 Title<input type="text" name="title" class="busk-input" maxlength="80" placeholder="例：黄昏天台不插电" value="' + esc(d.title || "") + '" /></label>' +
      '<label class="busk-field">风格 Style<input type="text" name="style" class="busk-input" maxlength="60" placeholder="民谣 / City Pop / Funk…" value="' + esc(d.style || "") + '" /></label>' +
      '<label class="busk-field">人数 Capacity<input type="number" name="capacity" class="busk-input" min="1" max="200" value="' + esc(d.capacity || 6) + '" /></label>' +
      '<label class="busk-field">时间段 Time slot<input type="text" name="time_slot" class="busk-input" maxlength="120" placeholder="9/20（周六）19:00–21:00" value="' + esc(d.time_slot || "") + '" /></label>' +
      '<label class="busk-field">地点 Location<input type="text" name="location" class="busk-input" maxlength="120" placeholder="江边绿道 · 桥下" value="' + esc(d.location || "") + '" /></label>' +
      '<div class="busk-form-actions">' +
      '<button type="submit" class="rc-btn rc-btn-primary" data-busk-mode="published">立即发布</button>' +
      '<button type="submit" class="rc-btn" data-busk-mode="draft">存为草稿</button>' +
      '<button type="button" class="rc-btn rc-btn-ghost" data-busk-act="cancel-form">取消</button>' +
      "</div>" +
      "</form>" +
      "</div>"
    );
  }


  /* ── Render: one activity (public board detail) ────────── */

  function renderDetail() {
    var d = state.detail;
    if (!d) return '<div class="busk-empty">正在载入活动…</div>';

    var e = d.event;
    var html = '<div class="busk-detail">';
    html += '<button type="button" class="busk-back" data-busk-act="back">‹ 返回活动列表</button>';

    html +=
      '<div class="busk-detail-head">' +
      "<h4>" + esc(e.title) + "</h4>" +
      '<div class="busk-badges">' +
      '<span class="busk-badge busk-badge-' + esc(e.status) + '">' + statusLabel(e.status) + "</span>" +
      (e.is_full ? '<span class="busk-badge busk-badge-full">已满员</span>' : "") +
      (e.published_at ? '<span class="busk-when">发布 ' + esc(fmtWhen(e.published_at)) + "</span>" : "") +
      "</div>" +
      "</div>";

    html +=
      '<ul class="busk-meta busk-meta-lg">' +
      "<li><b>主题</b> · " + esc(e.title) + "</li>" +
      "<li><b>风格</b> · " + (e.style ? esc(e.style) : "未定（自由发挥）") + "</li>" +
      "<li><b>人数</b> · " + e.join_count + " / " + e.capacity + " 人" + (e.is_full ? "（已满）" : "") + "</li>" +
      "<li><b>时间段</b> · " + (e.time_slot ? esc(e.time_slot) : "待定") + "</li>" +
      "<li><b>地点</b> · " + (e.location ? esc(e.location) : "待定") + "</li>" +
      "</ul>";

    if (e.status === "draft") {
      html += '<p class="busk-hint">这是草稿 —— 只有管理员能看到。发布后所有人都会在招募板上看到它。</p>';
    }

    html += renderDetailActions(d, e);
    html += renderParticipants(d);
    if (e.status === "finished" || d.photos.length) html += renderPhotos(d);
    if (state.isAdmin) html += renderPhotoForm();
    html += "</div>";
    return html;
  }


  function renderDetailActions(d, e) {
    var html = '<div class="busk-actions">';

    // 喜欢 — anyone, no login, deduped per visitor.
    html +=
      '<button type="button" class="busk-like busk-like-lg' + (d.liked ? " is-liked" : "") + '" data-busk-act="like" data-id="' + e.id + '">' +
      (d.liked ? "♥ 喜欢过" : "♡ 喜欢") + " " + (d.like_count || 0) +
      "</button>";

    // 分享 ↗ — the same per-activity share as on the card (分享页 /busking/:id).
    html += shareButton(e, "busk-share-lg");

    var canJoin = state.isAdmin || state.isMember;
    if (!state.user) {
      html += '<span class="busk-hint-inline">想上台？先用邀请码登录（上面输入框）—— 名字 / 邮箱 / 擅长的乐器登记一次就好。</span>';
    } else if (!canJoin) {
      html += '<span class="busk-hint-inline">这个账号还没有路演成员身份 —— 找管理员要一个邀请码，用它登录后就能加入 🎶</span>';
    } else if (e.joined) {
      html += '<span class="busk-joined">✓ 你已在名单里</span>';
      html += '<button type="button" class="rc-btn" data-busk-act="leave" data-id="' + e.id + '">退出名单</button>';
    } else if (e.status === "published") {
      var mine = state.user.instrument || "";
      html +=
        '<span class="busk-join-inline">' +
        '<input type="text" name="join-instrument" class="busk-input" maxlength="60" value="' + esc(mine) + '" placeholder="你负责的乐器（吉他 / 鼓 / 主唱…）" />' +
        '<button type="button" class="rc-btn rc-btn-primary" data-busk-act="join" data-id="' + e.id + '">我要加入</button>' +
        "</span>";
    } else if (e.status === "finished") {
      html += '<span class="busk-hint-inline">这一场已经收官啦，看看下面的精彩回顾 🎶</span>';
    } else {
      html += '<span class="busk-hint-inline">还没开始报名，先喜欢一下吧 🎶</span>';
    }

    if (state.isAdmin) {
      html += '<span class="busk-admin-acts">';
      if (e.status !== "published") {
        html += '<button type="button" class="rc-btn rc-btn-primary" data-busk-act="set-status" data-id="' + e.id + '" data-status="published">' + (e.status === "draft" ? "发布" : "重新开放") + "</button>";
      }
      if (e.status === "published") {
        html += '<button type="button" class="rc-btn" data-busk-act="set-status" data-id="' + e.id + '" data-status="finished">收官</button>';
        html += '<button type="button" class="rc-btn rc-btn-ghost" data-busk-act="set-status" data-id="' + e.id + '" data-status="draft">收回草稿</button>';
      }
      html += '<button type="button" class="rc-btn rc-btn-danger" data-busk-act="delete-event" data-id="' + e.id + '">删除活动</button>';
      html += "</span>";
    }

    if (state.busy) html += '<span class="busk-hint-inline">处理中…</span>';
    return html + "</div>";
  }


  /* 名单 — who is on stage and which instrument each of them brings. */
  function renderParticipants(d) {
    var html = '<h5 class="busk-subtitle">演出名单 · Participants（' + d.participants.length + "）</h5>";
    if (!d.participants.length) {
      return (
        html +
        '<p class="busk-hint">还没有人报名 —— ' +
        (state.isAdmin || state.isMember ? "要不要当第一个？" : "等成员们来认领声部。") +
        "</p>"
      );
    }
    html += '<ul class="busk-people">';
    d.participants.forEach(function (p, i) {
      html +=
        "<li>" +
        '<span class="busk-people-idx">' + (i + 1) + "</span>" +
        '<span class="busk-people-name">' + esc(p.name) + "</span>" +
        '<span class="busk-people-inst">' + (p.instrument ? esc(p.instrument) : "乐器待定") + "</span>" +
        "</li>";
    });
    return html + "</ul>";
  }

  /* 精彩回顾 — public, and how the gig is remembered afterwards. */
  function renderPhotos(d) {
    var html = '<h5 class="busk-subtitle">精彩回顾 · Highlights（' + d.photos.length + "）</h5>";
    if (!d.photos.length) return html + '<p class="busk-hint">照片还在路上 —— 演完就来 🎶</p>';
    html += '<div class="busk-gallery">';
    d.photos.forEach(function (p) {
      html +=
        '<figure class="busk-photo">' +
        '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
        '<img src="' + esc(p.url) + '" alt="' + esc(p.caption || "busking highlight") + '" loading="lazy" />' +
        "</a>" +
        (p.caption ? "<figcaption>" + esc(p.caption) + "</figcaption>" : "") +
        (state.isAdmin
          ? '<button type="button" class="busk-photo-del" data-busk-act="delete-photo" data-id="' + p.id + '" title="删除这张">&times;</button>'
          : "") +
        "</figure>";
    });
    return html + "</div>";
  }

  function renderPhotoForm() {
    return (
      '<div class="busk-photo-form">' +
      '<h5 class="busk-subtitle">添加精彩回顾照片（管理员）</h5>' +
      (state.photoError ? '<p class="busk-error">' + esc(state.photoError) + "</p>" : "") +
      '<div class="busk-photo-row">' +
      '<input type="file" id="busk-photo-file" accept="image/*" />' +
      '<input type="text" id="busk-photo-caption" class="busk-input" maxlength="120" placeholder="照片说明（可选）" />' +
      '<button type="button" class="rc-btn rc-btn-primary" data-busk-act="add-photo">' +
      (state.busy ? "上传中…" : "上传并添加") +
      "</button>" +
      "</div>" +
      '<p class="busk-hint">图片会压缩上传到本站 /photo/，只接受本站图片地址。</p>' +
      "</div>"
    );
  }


  /* ── State patching + the busy wrapper ─────────────────── */

  function applyLikeResult(id, payload) {
    var row = state.events.filter(function (e) { return e.id === id; })[0];
    if (row) { row.liked = !!payload.liked; row.like_count = payload.like_count; }
    if (state.detail && state.detail.event.id === id) {
      state.detail.liked = !!payload.liked;
      state.detail.like_count = payload.like_count;
      state.detail.event.like_count = payload.like_count;
    }
  }

  // A join/leave reply is the full detail payload — use it as-is (counts,
  // participant list, photos) so the view needs no extra round-trip.
  function applyDetailPayload(payload) {
    if (!payload || !payload.event) return;
    state.detail = payload;
    var row = state.events.filter(function (e) { return e.id === payload.event.id; })[0];
    if (row) {
      Object.assign(row, payload.event);
      row.liked = !!payload.liked;
      row.like_count = payload.like_count;
    }
  }

  async function run(action) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await action();
    } catch (err) {
      // 409 = the polite rejections (满员 / 已收官 / 未开放 …) — show them as
      // a warm notice, not as a hard error.
      setNotice(err.message, err.status === 409 ? "warn" : "error");
    }
    state.busy = false;
    render();
  }

  /* ── Images: 精彩回顾 uploads (same pipeline as the admin console) ── */

  function describeImageReadError(file) {
    var name = (file && file.name) || "";
    var type = (file && file.type) || "";
    var hint = "转成 JPG 或 PNG 再试一次。";
    if (/heic|heif/i.test(type + name)) return '"' + name + '" 是 HEIC/HEIF（iPhone 照片格式），这个浏览器读不了。' + hint;
    if (/^image\/(avif|tiff|tif|svg\+xml)/i.test(type) || /\.(avif|tif|tiff|psd|svg)$/i.test(name)) {
      return '"' + name + '" 不是受支持的图片格式。' + hint;
    }
    return '读不出 "' + name + '"（' + (type || "未知格式") + "）。" + hint;
  }

  function resizeImage(file, maxDim, quality) {
    maxDim = maxDim || 1920;
    quality = quality || 0.85;
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error("没有拿到图片文件，请重新选择。")); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          function (blob) { blob ? resolve(blob) : reject(new Error("图片压缩失败")); },
          "image/jpeg",
          quality
        );
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(describeImageReadError(file))); };
      img.src = url;
    });
  }

  async function uploadImage(file) {
    var blob = await resizeImage(file);
    var token = buskToken();
    var headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    var res;
    try {
      res = await fetch("/api/upload", { method: "POST", headers: headers, body: blob });
    } catch (err) {
      throw networkError(err, "POST", "/api/upload");
    }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "上传失败（HTTP " + res.status + "）");
    return data.url;
  }


  /* ── 分享：one share button per activity entry ─────────── */

  /* The entry a share/detail action points at: the open detail first (it is
     the freshest copy), then the board row. */
  function findEvent(id) {
    if (state.detail && state.detail.event && state.detail.event.id === id) return state.detail.event;
    return state.events.filter(function (e) { return e.id === id; })[0] || null;
  }

  /* 分享 ↗ — board card + detail view. Drafts get no button: /busking/:id only
     exists once the activity is published (the server 404s draft pages). */
  function shareButton(e, extraClass) {
    if (!e || e.status === "draft") return "";
    return (
      '<button type="button" class="busk-share' + (extraClass ? " " + extraClass : "") +
      '" data-busk-act="share" data-id="' + e.id + '" title="分享这条活动">分享 ↗</button>'
    );
  }

  /* Hands the activity's own page (/busking/:id — server-rendered with the
     og: tags WeChat reads) to the site-wide share dialog: QR code, copy link
     or short link. Without the dialog script the page itself is the fallback,
     it renders fine on its own. */
  function shareEvent(id) {
    var e = findEvent(id);
    if (!e) return;
    var path = "/busking/" + e.id;
    if (typeof window.openShareDialog === "function") {
      window.openShareDialog({ title: "路演 · " + e.title, path: path });
      return;
    }
    if (typeof location !== "undefined") location.href = path;
  }


  /* ── Interactions ──────────────────────────────────────── */

  function onClick(ev) {
    var el = ev.target.closest ? ev.target.closest("[data-busk-act]") : null;
    if (!el || !root.contains(el)) return;
    var act = el.getAttribute("data-busk-act");
    var id = el.getAttribute("data-id") ? Number(el.getAttribute("data-id")) : null;

    if (act === "open") return openDetail(id);
    if (act === "back") {
      state.openId = null;
      state.detail = null;
      setNotice(null);
      return render();
    }
    if (act === "notice-clear") {
      setNotice(null);
      return render();
    }
    if (act === "new") {
      state.showForm = true;
      state.formError = "";
      return render();
    }
    if (act === "cancel-form") {
      state.showForm = false;
      state.formError = "";
      return render();
    }
    if (act === "logout") return logout();
    if (act === "like") return likeEvent(id);
    if (act === "share") return shareEvent(id);
    if (act === "join") return toggleJoin(id, true);
    if (act === "leave") return toggleJoin(id, false);
    if (act === "set-status") return setStatus(id, el.getAttribute("data-status"));
    if (act === "delete-event") return deleteEvent(id);
    if (act === "delete-photo") return deletePhoto(id);
    if (act === "add-photo") return addPhoto();
  }

  // 喜欢 — no login needed (one per visitor); toggles on a second tap.
  function likeEvent(id) {
    run(async function () {
      var data = await buskApi("/api/busking/events/" + id + "/like", {
        method: "POST",
        body: JSON.stringify({ visitor: buskVisitor() }),
      });
      applyLikeResult(id, data);
    });
  }


  // 我要加入 / 退出名单 — the instrument is what the public list publishes, so
  // a member writes it here (or it comes from their saved profile).
  function toggleJoin(id, joining) {
    var instrument = "";
    if (joining) {
      var input = $('input[name="join-instrument"]');
      instrument = input ? input.value.trim() : "";
      if (!instrument) {
        setNotice("先写下你负责的乐器吧（吉他 / 鼓 / 贝斯 / 主唱…），这样大家才知道谁带哪个声部 🎶", "warn");
        return render();
      }
    }
    run(async function () {
      var data = await buskApi("/api/busking/events/" + id + (joining ? "/join" : "/leave"), {
        method: "POST",
        body: JSON.stringify({ instrument: instrument, visitor: buskVisitor() }),
      });
      applyDetailPayload(data);
      setNotice(joining ? data.joined_message : data.left_message, "ok");
    });
  }

  // 发布 / 收官 / 收回草稿.
  function setStatus(id, status) {
    run(async function () {
      await buskApi("/api/busking/events/" + id + "/status", {
        method: "POST",
        body: JSON.stringify({ status: status }),
      });
      await refreshDetail();
      setNotice(
        status === "published"
          ? "已发布 —— 招募板上所有人都能看到这一场啦 🎶"
          : status === "finished"
          ? "已收官，可以把精彩回顾照片传上来了 🎶"
          : "已收回草稿（只有管理员能看到）",
        "ok"
      );
    });
  }

  function deleteEvent(id) {
    var name = state.detail && state.detail.event ? "「" + state.detail.event.title + "」" : "这个活动";
    if (!window.confirm("删除" + name + "？名单、喜欢和照片都会一起删掉，无法恢复。")) return;
    run(async function () {
      await buskApi("/api/busking/events/" + id, { method: "DELETE" });
      state.openId = null;
      state.detail = null;
      await loadBoard();
      setNotice("已删除，这一场就当作没发生过 🎶", "info");
    });
  }

  function deletePhoto(id) {
    if (!window.confirm("删除这张精彩回顾照片？")) return;
    run(async function () {
      await buskApi("/api/busking/photos/" + id, { method: "DELETE" });
      await refreshDetail();
      setNotice("照片已删除", "info");
    });
  }

  function addPhoto() {
    var fileEl = $("#busk-photo-file");
    var capEl = $("#busk-photo-caption");
    var file = fileEl && fileEl.files ? fileEl.files[0] : null;
    var caption = capEl ? capEl.value.trim() : "";
    var eventId = state.openId;
    if (!file) {
      state.photoError = "先选一张照片吧 🎶";
      return render();
    }
    state.photoError = "";
    run(async function () {
      var url = await uploadImage(file);
      await buskApi("/api/busking/events/" + eventId + "/photos", {
        method: "POST",
        body: JSON.stringify({ url: url, caption: caption }),
      });
      await refreshDetail();
      setNotice("照片已加入精彩回顾 🎶", "ok");
    });
  }

  /* 退出 — stop being logged in here. The toolbar chip may be showing the admin
     console's session (buskToken() falls back to benpage_admin_token on this
     same origin), so clearing only the app's own token used to leave the
     console's JWT behind: refreshIdentity() read it straight back and 退出
     looked like a no-op that "kept you as 管理员". Signing out has to end
     whichever session the chip is showing. */
  async function logout() {
    var hadConsoleSession = !!localStorage.getItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    if (hadConsoleSession) localStorage.removeItem(ADMIN_TOKEN_KEY);
    setNotice(
      hadConsoleSession
        ? "已退出 —— 管理后台的登录也一起退出了 🎶"
        : "已退出 —— 想再上台，就再用邀请码登录 🎶",
      "info"
    );
    await refreshIdentity();
    await loadBoard();
    render();
  }


  /* ── Forms: 邀请码登录 / 成员资料 / 发布活动 ───────────── */

  function onSubmit(ev) {
    var form = ev.target.closest ? ev.target.closest("form[data-busk-form]") : null;
    if (!form || !root.contains(form)) return;
    ev.preventDefault();
    var kind = form.getAttribute("data-busk-form");
    var data = new FormData(form);
    if (kind === "login") return submitLogin(String(data.get("code") || "").trim());
    if (kind === "profile") return submitProfile(data);
    if (kind === "new") return submitNew(data, ev.submitter || null);
  }

  function submitLogin(code) {
    if (!code) {
      setNotice("先输入邀请码哦 🎶", "warn");
      return render();
    }
    run(async function () {
      var data = await buskApi("/api/busking/invite-login", {
        method: "POST",
        body: JSON.stringify({ code: code }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      state.user = data.user;
      state.isMember = true;
      state.isAdmin = !!data.user.is_admin;
      await loadBoard();
      setNotice(
        data.first_login
          ? "邀请码通过 ✓ 欢迎加入路演 —— 先留下名字 / 邮箱 / 擅长的乐器 🎶"
          : "欢迎回来，" + (data.user.nickname || data.user.username) + " 🎶",
        "ok"
      );
    });
  }

  function submitProfile(formData) {
    run(async function () {
      var data = await buskApi("/api/busking/profile", {
        method: "POST",
        body: JSON.stringify({
          nickname: String(formData.get("nickname") || "").trim(),
          email: String(formData.get("email") || "").trim(),
          instrument: String(formData.get("instrument") || "").trim(),
        }),
      });
      state.user = data.user;
      await loadBoard();
      setNotice("资料已保存 —— 名单上会显示你的乐器：" + (data.user.instrument || "（未填）") + " 🎶", "ok");
      // A member who just finished the profile is ready to 我要加入.
      state.profileError = "";
    });
  }

  function submitNew(formData, submitter) {
    var mode = (submitter && submitter.getAttribute("data-busk-mode")) || "published";
    var draft = {
      title: String(formData.get("title") || "").trim(),
      style: String(formData.get("style") || "").trim(),
      capacity: formData.get("capacity"),
      time_slot: String(formData.get("time_slot") || "").trim(),
      location: String(formData.get("location") || "").trim(),
    };
    // Keep what was typed so a rejection does not wipe the form.
    state.formDraft = draft;
    if (!draft.title) {
      state.formError = "主题（Title）不能为空";
      return render();
    }
    state.formError = "";
    run(async function () {
      var data = await buskApi("/api/busking/events", {
        method: "POST",
        body: JSON.stringify(Object.assign({}, draft, { status: mode })),
      });
      state.showForm = false;
      state.formDraft = null;
      await loadBoard();
      setNotice(
        mode === "published" ? "已发布「" + data.event.title + "」 🎶" : "已存为草稿（只有管理员能看到）",
        "ok"
      );
      await openDetail(data.event.id);
    });
  }

  /* ── Boot ──────────────────────────────────────────────── */

  /* The share page (/busking/:id) and its 打开路演 CTA link here as
     /busking?e=<id>, and people copy those links around, so honour the param
     once on boot: open that activity, then drop it from the URL so a later
     re-open of the app (or a 返回活动列表) shows the board instead of jumping
     back into the detail. */
  function takeDeepLinkId() {
    if (typeof location === "undefined" || !location.search) return 0;
    var m = /[?&]e=(\d+)/.exec(location.search);
    if (!m) return 0;
    if (typeof history !== "undefined" && history.replaceState) {
      history.replaceState(null, "", location.pathname);
    }
    return Number(m[1]);
  }

  function onKeydown(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var card = ev.target.closest ? ev.target.closest('.busk-card[data-busk-act="open"]') : null;
    if (!card) return;
    // A button inside the card (♡ 喜欢 / 分享 ↗) answers Enter/Space itself —
    // don't let the card's shortcut open the activity on top of it.
    var inner = ev.target.closest ? ev.target.closest("button") : null;
    if (inner && inner !== card) return;
    ev.preventDefault();
    openDetail(Number(card.getAttribute("data-id")));
  }

  async function init() {
    if (state.loading) return;
    state.loading = true;
    render();
    await refreshIdentity();
    await loadBoard();
    state.loaded = true;
    state.loading = false;
    render();
    // Deep link from a share page / copied link: /busking?e=<id>.
    var deep = takeDeepLinkId();
    if (!deep) return;
    if (state.events.some(function (e) { return e.id === deep; })) {
      await openDetail(deep);
      return;
    }
    // The activity is gone (deleted, or still a draft this visitor may not
    // see) — say so warmly instead of leaving a silent jump to the board.
    setNotice("这条链接指向的活动已经不在了 —— 看看其他活动吧 🎶", "warn");
    render();
  }

  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("keydown", onKeydown);

  /* ── Public API for apps.js ────────────────────────────── */
  window.BuskingApp = { init: init };
})();

