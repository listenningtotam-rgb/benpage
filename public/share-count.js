/* ── Share-page counters ────────────────────────────────────────────────
 * The standalone share pages (/post/:id, /music/:id) are real web pages,
 * so opens and plays there count just like on the main site:
 *   - blog:  POST /api/blog/<id>/read     once per page open
 *   - music: POST /api/music/<id>/play    once per page on first play
 * Best-effort — a network failure never blocks the page.
 * --------------------------------------------------------------------- */
(function () {
  "use strict";

  var kind = document.body.getAttribute("data-kind");
  var id = document.body.getAttribute("data-id");
  if ((kind !== "blog" && kind !== "music") || !/^\d+$/.test(id || "")) return;

  function post(path) {
    fetch(path, { method: "POST" }).catch(function () {});
  }

  if (kind === "blog") {
    post("/api/blog/" + id + "/read");
  } else {
    var audio = document.querySelector("audio");
    if (!audio) return;
    var counted = false;
    audio.addEventListener("play", function () {
      if (counted) return;
      counted = true;
      post("/api/music/" + id + "/play");
    });
  }
})();
