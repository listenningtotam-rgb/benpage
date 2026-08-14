/* ── Share dialog ────────────────────────────────────────────────────────
 * Opens a modal to share the current blog post / music track as a web page:
 *   - QR code  (scan with WeChat -> open in WeChat -> forward / Moments)
 *   - copy the full link
 *   - generate a short link  (same-site, /s/<code>, see server.js)
 *   - native share sheet when the browser supports navigator.share
 *
 * Usage: window.openShareDialog({ title, path })
 * --------------------------------------------------------------------- */
(function () {
  "use strict";

  var modal = null;
  var urlInput = null;
  var shortInput = null;
  var shortRow = null;
  var qrCanvas = null;
  var statusEl = null;
  var shortBtn = null;
  var nativeBtn = null;
  var currentUrl = "";
  var currentTitle = "";

  function build() {
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "share-modal";
    modal.hidden = true;
    modal.innerHTML =
      '<div class="share-modal-inner" role="dialog" aria-modal="true" aria-label="Share">' +
        '<button type="button" class="share-modal-close" aria-label="Close">&times;</button>' +
        '<h3 class="share-title">分享</h3>' +
        '<p class="share-subtitle">Share as a web page &middot; WeChat friends &amp; Moments</p>' +
        '<div class="share-body">' +
          '<div class="share-qr-wrap">' +
            '<canvas class="share-qr" width="220" height="220"></canvas>' +
            '<p class="share-qr-hint">微信扫一扫打开，点右上角 &ldquo;&middot;&middot;&middot;&rdquo; 可转发给朋友或分享到朋友圈</p>' +
          "</div>" +
          '<div class="share-actions">' +
            '<div class="share-row">' +
              '<input class="share-input" readonly aria-label="Share link" />' +
              '<button type="button" class="share-btn copy-link">复制链接</button>' +
            "</div>" +
            '<div class="share-row share-short-row" hidden>' +
              '<input class="share-input short" readonly aria-label="Short link" />' +
              '<button type="button" class="share-btn copy-short">复制短链</button>' +
            "</div>" +
            '<div class="share-btn-row">' +
              '<button type="button" class="share-btn gen-short">生成短链接</button>' +
              '<button type="button" class="share-btn native" hidden>系统分享&hellip;</button>' +
            "</div>" +
            '<p class="share-status" aria-live="polite"></p>' +
          "</div>" +
        "</div>" +
      "</div>";
    document.body.appendChild(modal);

    qrCanvas = modal.querySelector(".share-qr");
    urlInput = modal.querySelector(".share-input");
    shortInput = modal.querySelector(".share-input.short");
    shortRow = modal.querySelector(".share-short-row");
    shortBtn = modal.querySelector(".gen-short");
    nativeBtn = modal.querySelector(".native");
    statusEl = modal.querySelector(".share-status");

    modal.querySelector(".share-modal-close").addEventListener("click", close);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) close();
    });
    modal.querySelector(".copy-link").addEventListener("click", function () {
      copyText(urlInput.value, "链接已复制 ✓");
    });
    modal.querySelector(".copy-short").addEventListener("click", function () {
      copyText(shortInput.value, "短链接已复制 ✓");
    });
    shortBtn.addEventListener("click", makeShortLink);
    nativeBtn.addEventListener("click", function () {
      if (typeof navigator.share !== "function") return;
      navigator.share({ title: currentTitle, url: currentUrl }).catch(function () {});
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal && !modal.hidden) close();
    });
  }


  function openShareDialog(opts) {
    opts = opts || {};
    currentTitle = String(opts.title || "");
    var path = String(opts.path || "");
    if (!/^\//.test(path)) return;
    currentUrl = window.location.origin + path;

    if (!modal) build();
    modal.hidden = false;
    document.body.style.overflow = "hidden";

    urlInput.value = currentUrl;
    shortInput.value = "";
    shortRow.hidden = true;
    setStatus("");
    drawQr(currentUrl);
    nativeBtn.hidden = typeof navigator.share !== "function";
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
  }

  function drawQr(url) {
    try {
      QRCode.drawToCanvas(qrCanvas, url, { size: 220, margin: 4, ecc: "M" });
    } catch (e) {
      var ctx = qrCanvas.getContext("2d");
      ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
      setStatus("链接过长，无法生成二维码 — 可直接复制链接。");
    }
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function copyText(text, okMsg) {
    var done = function () {
      setStatus(okMsg);
    };
    var fail = function () {
      setStatus("复制失败 — 请长按手动复制");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) done();
        else fail();
      } catch (e) {
        fail();
      }
    }
  }

  function makeShortLink() {
    shortBtn.disabled = true;
    setStatus("生成中…");
    fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
      })
      .then(function (data) {
        shortInput.value = data.short_url;
        shortRow.hidden = false;
        setStatus("短链接已生成 ✓");
      })
      .catch(function (e) {
        setStatus("生成失败：" + (e.message || "网络错误"));
      })
      .finally(function () {
        shortBtn.disabled = false;
      });
  }

  window.openShareDialog = openShareDialog;
})();
