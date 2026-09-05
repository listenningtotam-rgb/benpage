"use strict";
/* ── Server-side QR → PNG (dynamic app QR codes) ─────────────────────
 * Builds on the dependency-free QR matrix encoder in public/qrcode.js
 * (the same implementation the client share dialog uses) and renders its
 * boolean matrix into a standard grayscale PNG using only Node built-ins
 * (zlib) — no canvas / native dependency on the server.
 *
 * Used by GET /api/app-qr/:key: each app page displays a QR that encodes a
 * same-site short link (/s/<code>, see db.js app_qr + share_links) pointing
 * at that app, so WeChat can open it by scanning.  The short code stays
 * stable per app while its target stays editable in the DB — a retarget
 * never invalidates an already-printed QR.
 * --------------------------------------------------------------------- */
const zlib = require("zlib");
const QRCode = require("./public/qrcode.js");

/* CRC-32 (PNG chunk checksum). */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/* Render `text` as a QR PNG.
 * opts: { scale, margin, ecc } — scale = pixels per module, margin = quiet
 * zone in modules (QR spec wants ≥ 4; kept on all four sides).  Grayscale
 * (8-bit, colour type 0), which scanners read just as reliably as colour
 * and keeps the file tiny. */
function pngForText(text, opts) {
  opts = opts || {};
  const margin = opts.margin != null ? opts.margin : 4;
  const scale = opts.scale != null ? opts.scale : 5;
  const { modules } = QRCode.encode(String(text), { ecc: opts.ecc || "M" });
  const n = modules.length;
  const px = (n + margin * 2) * scale;

  /* One byte per pixel: 0 = dark module, 255 = white.  Each scanline is
   * prefixed with filter type 0 (None), which PNG requires. */
  const raw = Buffer.alloc(px * (px + 1));
  let o = 0;
  for (let y = 0; y < px; y++) {
    raw[o++] = 0; // filter: None
    const row = Math.floor(y / scale) - margin;
    for (let x = 0; x < px; x++) {
      const col = Math.floor(x / scale) - margin;
      const dark = row >= 0 && row < n && col >= 0 && col < n && modules[row][col];
      raw[o++] = dark ? 0 : 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0); // width
  ihdr.writeUInt32BE(px, 4); // height
  ihdr[8] = 8;               // bit depth
  ihdr[9] = 0;               // colour type: grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // compression/filter/interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return { png, modules: n, size: px };
}

module.exports = { pngForText, crc32 };
