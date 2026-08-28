"use strict";
/* ── Perceptual hashing shared by the vinyl archive ─────────────────────
 * Box-averaged downscale to a grayscale luma grid (canvas-smoothing
 * approximation), luma = 0.299R + 0.587G + 0.114B, producing the exact same
 * 64-bit aHash + dHash hex as:
 *   - public/vinyl.js (browser, photographs the cover)   — same math by hand
 *   - seed-vinyl.js    (MusicBrainz seed pipeline)
 * so every imported record — MusicBrainz seed OR Discogs text-search import —
 * is recognized by the same /api/vinyl/recognize matcher.
 * ---------------------------------------------------------------------- */

const jpeg = require("jpeg-js");

/* ow×oh grayscale luma grid from an RGBA pixel buffer. */
function boxGray(rgba, sw, sh, ow, oh) {
  const out = new Float64Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const ys = Math.floor((oy * sh) / oh);
    const ye = Math.max(ys + 1, Math.floor(((oy + 1) * sh) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const xs = Math.floor((ox * sw) / ow);
      const xe = Math.max(xs + 1, Math.floor(((ox + 1) * sw) / ow));
      let sum = 0;
      let n = 0;
      for (let y = ys; y < ye; y++) {
        for (let x = xs; x < xe; x++) {
          const i = (y * sw + x) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          n++;
        }
      }
      out[oy * ow + ox] = sum / n;
    }
  }
  return out;
}

/* 64-bit bit-string → 16 hex chars (matches the client exactly). */
function hexFromBits(bits) {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function aHashHex(gray8) {
  let avg = 0;
  for (const v of gray8) avg += v;
  avg /= gray8.length;
  let bits = "";
  for (let i = 0; i < 64; i++) bits += gray8[i] >= avg ? "1" : "0";
  return hexFromBits(bits);
}

function dHashHex(gray9) {
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += gray9[y * 9 + x] >= gray9[y * 9 + x + 1] ? "1" : "0";
    }
  }
  return hexFromBits(bits);
}

/* Decode a JPEG buffer → { ahash, dhash }. */
function computeHashesFromBuffer(buf) {
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const gray8 = boxGray(img.data, img.width, img.height, 8, 8);
  const gray9 = boxGray(img.data, img.width, img.height, 9, 8);
  return { ahash: aHashHex(gray8), dhash: dHashHex(gray9) };
}

module.exports = { boxGray, hexFromBits, aHashHex, dHashHex, computeHashesFromBuffer };
