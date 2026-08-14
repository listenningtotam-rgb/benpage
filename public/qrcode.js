/* ── Minimal pure-JS QR Code encoder (byte mode, versions 1–10) ───────
 * Dependency-free QR generator used by the share dialog to render a
 * scannable code (e.g. to open a post/track in WeChat).
 *
 * Implements the ISO/IEC 18004 algorithm: GF(256) Reed–Solomon ECC,
 * zig-zag data placement, all 8 mask patterns, and the standard penalty
 * scoring for mask selection.  Output is a 2-D boolean matrix which is
 * drawn onto a <canvas> by drawToCanvas().
 *
 * Works in the browser (exposes window.QRCode) and in Node (module.exports)
 * so the matrix can be cross-checked against a reference implementation.
 * --------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.QRCode = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ── GF(256) arithmetic (primitive polynomial 0x11D) ─────────────── */
  const EXP = new Array(256);
  const LOG = new Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    EXP[255] = EXP[0];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255];
  }

  /* Reed–Solomon generator polynomial: ∏(x − α^i) for i = 0..degree-1.
     Coefficients are highest-degree first; gen[0] is always 1. */
  const rsGenCache = {};
  function rsGenPoly(degree) {
    if (rsGenCache[degree]) return rsGenCache[degree];
    let gen = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= gfMul(gen[j], EXP[i]);
      }
      gen = next;
    }
    rsGenCache[degree] = gen;
    return gen;
  }

  function rsEncode(data, degree) {
    const gen = rsGenPoly(degree);
    const res = new Array(data.length + degree).fill(0);
    for (let i = 0; i < data.length; i++) res[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const coef = res[i];
      if (coef === 0) continue;
      for (let j = 1; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
    return res.slice(data.length);
  }

  /* ── RS block table (version → { L/M/Q/H → [ecPerBlock, groups] }) ──
     groups: [ [blockCount, dataCodewordsPerBlock], ... ]  (ISO 18004)   */
  const RS_BLOCKS = {
    1:  { L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
    2:  { L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
    3:  { L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
    4:  { L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
    5:  { L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]] },
    6:  { L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] },
    7:  { L: [20, [[2, 78]]], M: [18, [[4, 31]]], Q: [18, [[2, 14], [4, 15]]], H: [26, [[4, 13], [1, 14]]] },
    8:  { L: [24, [[2, 97]]], M: [22, [[2, 38], [2, 39]]], Q: [22, [[4, 18], [2, 19]]], H: [26, [[4, 14], [2, 15]]] },
    9:  { L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]], Q: [20, [[4, 16], [4, 17]]], H: [24, [[4, 12], [4, 13]]] },
    10: { L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]], Q: [24, [[6, 19], [2, 20]]], H: [28, [[6, 15], [2, 16]]] },
  };

  /* Alignment-pattern centre coordinates per version (row/col lists). */
  const ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  /* Format/version BCH codes (generators 0x537 / 0x1F25, mask 0x5412). */
  const G15 = 0x537;
  const G18 = 0x1f25;
  const G15_MASK = 0x5412;
  const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function bchDigit(v) {
    let d = 0;
    while (v) {
      d += 1;
      v >>>= 1;
    }
    return d;
  }

  function bchTypeInfo(data) {
    let d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0) {
      d ^= G15 << (bchDigit(d) - bchDigit(G15));
    }
    return ((data << 10) | d) ^ G15_MASK;
  }

  function bchTypeNumber(data) {
    let d = data << 12;
    while (bchDigit(d) - bchDigit(G18) >= 0) {
      d ^= G18 << (bchDigit(d) - bchDigit(G18));
    }
    return (data << 12) | d;
  }

  /* The 8 standard data mask functions. */
  const MASK_FUNCS = [
    (i, j) => (i + j) % 2 === 0,
    (i, j) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
    (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0,
    (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 === 0,
  ];

  /* ── Function modules (finders, separators, alignment, timing, version) ──
     Cells stay null where the data codewords will be placed. */
  function buildFunctionModules(version, size) {
    const cells = [];
    for (let r = 0; r < size; r++) cells.push(new Array(size).fill(null));

    function setFinder(row, col) {
      for (let r = -1; r <= 7; r++) {
        if (row + r < 0 || row + r >= size) continue;
        for (let c = -1; c <= 7; c++) {
          if (col + c < 0 || col + c >= size) continue;
          const dark =
            (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          cells[row + r][col + c] = dark;
        }
      }
    }
    setFinder(0, 0);
    setFinder(size - 7, 0);
    setFinder(0, size - 7);

    const pos = ALIGNMENT[version] || [];
    for (const r of pos) {
      for (const c of pos) {
        if (cells[r][c] != null) continue; // overlaps a finder -> skip
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            cells[r + dr][c + dc] =
              Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          }
        }
      }
    }

    for (let r = 8; r < size - 8; r++) if (cells[r][6] == null) cells[r][6] = r % 2 === 0;
    for (let c = 8; c < size - 8; c++) if (cells[6][c] == null) cells[6][c] = c % 2 === 0;

    if (version >= 7) {
      const vbits = bchTypeNumber(version);
      for (let i = 0; i < 18; i++) {
        const dark = ((vbits >> i) & 1) === 1;
        cells[Math.floor(i / 3)][i % 3 + size - 11] = dark;
        cells[i % 3 + size - 11][Math.floor(i / 3)] = dark;
      }
    }
    return cells;
  }

  /* Format-info bits + the fixed dark module (depends on the mask trial). */
  function placeFormatInfo(cells, size, ecc, mask) {
    const bits = bchTypeInfo((ECC_BITS[ecc] << 3) | mask);
    for (let i = 0; i < 15; i++) {
      const dark = ((bits >> i) & 1) === 1;
      // vertical strip (column 8)
      if (i < 6) cells[i][8] = dark;
      else if (i < 8) cells[i + 1][8] = dark;
      else cells[size - 15 + i][8] = dark;
      // horizontal strip (row 8)
      if (i < 8) cells[8][size - i - 1] = dark;
      else if (i < 9) cells[8][15 - i] = dark;
      else cells[8][15 - i - 1] = dark;
    }
    cells[size - 8][8] = true; // fixed dark module
  }


  /* Zig-zag data placement into the remaining null cells. */
  function placeData(cells, size, data, mask) {
    const maskFunc = MASK_FUNCS[mask];
    let inc = -1;
    let row = size - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1; // skip the vertical timing column
      for (;;) {
        for (let c = 0; c < 2; c++) {
          if (cells[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
            }
            if (maskFunc(row, col - c)) dark = !dark;
            cells[row][col - c] = dark;
            bitIndex -= 1;
            if (bitIndex === -1) {
              byteIndex += 1;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || row >= size) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }

  /* ── Mask penalty scoring (classic QR rules) ───────────────────────── */
  function lostPoint(modules, size) {
    let lost = 0;

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        let same = 0;
        const dark = modules[row][col];
        for (let r = -1; r <= 1; r++) {
          if (row + r < 0 || row + r >= size) continue;
          for (let c = -1; c <= 1; c++) {
            if (col + c < 0 || col + c >= size) continue;
            if (r === 0 && c === 0) continue;
            if (dark === modules[row + r][col + c]) same += 1;
          }
        }
        if (same > 5) lost += 3 + same - 5;
      }
    }

    for (let row = 0; row < size - 1; row++) {
      for (let col = 0; col < size - 1; col++) {
        let count = 0;
        if (modules[row][col]) count += 1;
        if (modules[row + 1][col]) count += 1;
        if (modules[row][col + 1]) count += 1;
        if (modules[row + 1][col + 1]) count += 1;
        if (count === 0 || count === 4) lost += 3;
      }
    }

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size - 6; col++) {
        if (
          modules[row][col] && !modules[row][col + 1] &&
          modules[row][col + 2] && modules[row][col + 3] &&
          modules[row][col + 4] && !modules[row][col + 5] &&
          modules[row][col + 6]
        ) lost += 40;
      }
    }
    for (let col = 0; col < size; col++) {
      for (let row = 0; row < size - 6; row++) {
        if (
          modules[row][col] && !modules[row + 1][col] &&
          modules[row + 2][col] && modules[row + 3][col] &&
          modules[row + 4][col] && !modules[row + 5][col] &&
          modules[row + 6][col]
        ) lost += 40;
      }
    }

    let darkCount = 0;
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (modules[row][col]) darkCount += 1;
      }
    }
    const ratio = Math.abs((100 * darkCount) / size / size - 50) / 5;
    lost += ratio * 10;
    return lost;
  }


  /* ── Build codeword stream: bit stuffing → padding → RS → interleave ── */
  function buildCodewords(version, ecc, bytes) {
    const [ec, groups] = RS_BLOCKS[version][ecc];
    const blocks = [];
    for (const [count, dc] of groups) {
      for (let i = 0; i < count; i++) blocks.push({ dc });
    }
    const totalData = blocks.reduce((s, b) => s + b.dc, 0);

    const countBits = version < 10 ? 8 : 16;
    const bits = [];
    function putBits(num, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((num >>> i) & 1);
    }
    putBits(4, 4); // byte mode indicator
    putBits(bytes.length, countBits);
    for (const b of bytes) putBits(b, 8);

    if (bits.length + 4 <= totalData * 8) putBits(0, 4); // terminator
    while (bits.length % 8 !== 0) bits.push(0);          // byte boundary
    let padByte = 0xec;
    while (bits.length < totalData * 8) {
      putBits(padByte, 8);
      padByte = padByte === 0xec ? 0x11 : 0xec;
    }

    const dataBytes = [];
    for (let i = 0; i < totalData * 8; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      dataBytes.push(v);
    }

    const dcArrays = [];
    let offset = 0;
    for (const b of blocks) {
      dcArrays.push(dataBytes.slice(offset, offset + b.dc));
      offset += b.dc;
    }
    const eccArrays = dcArrays.map((d) => rsEncode(d, ec));

    const result = [];
    const maxDc = Math.max.apply(null, blocks.map((b) => b.dc));
    for (let i = 0; i < maxDc; i++) {
      for (const d of dcArrays) if (i < d.length) result.push(d[i]);
    }
    for (let i = 0; i < ec; i++) {
      for (const e of eccArrays) result.push(e[i]);
    }
    return result;
  }

  function chooseVersion(bytes, ecc) {
    for (let v = 1; v <= 10; v++) {
      const [, groups] = RS_BLOCKS[v][ecc];
      const totalData = groups.reduce((s, [count, dc]) => s + count * dc, 0);
      const countBits = v < 10 ? 8 : 16;
      const capacity = Math.floor((totalData * 8 - 4 - countBits) / 8);
      if (bytes.length <= capacity) return v;
    }
    return null;
  }

  function utf8Bytes(str) {
    const te = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    if (te) return Array.from(te.encode(str));
    return Array.from(Buffer.from(str, "utf8")); // old-Node fallback
  }

  /**
   * Encode `text` into a QR matrix.
   * @param {string} text
   * @param {object} [opts] { ecc: 'L'|'M'|'Q'|'H' (default 'M'), version: 1-10 (optional, auto) }
   * @returns {{ version:number, ecc:string, size:number, modules:boolean[][] }}
   */
  function encode(text, opts) {
    opts = opts || {};
    const bytes = utf8Bytes(String(text));
    const requestedEcc = ECC_BITS[opts.ecc] ? opts.ecc : "M";

    let version = opts.version || null;
    let ecc = requestedEcc;
    if (version == null) {
      // Auto-select: prefer requested ECC, fall back to L for longer payloads.
      const levels = ecc === "L" ? ["L"] : [ecc, "L"];
      for (const level of levels) {
        const v = chooseVersion(bytes, level);
        if (v != null) {
          version = v;
          ecc = level;
          break;
        }
      }
      if (version == null) {
        throw new Error("QR content too long (max ~271 bytes at version 10)");
      }
    } else {
      const entry = RS_BLOCKS[version] ? RS_BLOCKS[version][ecc] : null;
      if (!entry) throw new Error("Unsupported QR version");
      const [, groups] = entry;
      const totalData = groups.reduce((s, [count, dc]) => s + count * dc, 0);
      const countBits = version < 10 ? 8 : 16;
      if (bytes.length * 8 + 4 + countBits > totalData * 8) {
        throw new Error("QR content does not fit in the requested version");
      }
    }

    const data = buildCodewords(version, ecc, bytes);
    const size = version * 4 + 17;
    const base = buildFunctionModules(version, size);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const cells = base.map((row) => row.slice());
      placeFormatInfo(cells, size, ecc, mask);
      placeData(cells, size, data, mask);
      const penalty = lostPoint(cells, size);
      if (!best || penalty < best.penalty) best = { mask, penalty, cells };
    }

    return { version, ecc, size, mask: best.mask, modules: best.cells };
  }

  /**
   * Draw a QR code for `text` onto a canvas (quiet zone included).
   * @param {HTMLCanvasElement} canvas
   * @param {string} text
   * @param {object} [opts] { size, margin, dark, light, ecc, version }
   */
  function drawToCanvas(canvas, text, opts) {
    opts = opts || {};
    const margin = opts.margin != null ? opts.margin : 4;
    const dark = opts.dark || "#000000";
    const light = opts.light || "#ffffff";
    const { modules } = encode(text, opts);
    const n = modules.length;
    const px = opts.size || 240;
    const scale = Math.max(1, Math.floor((px - margin * 2) / n));
    const total = n * scale + margin * 2;

    if (canvas.width !== total || canvas.height !== total) {
      canvas.width = total;
      canvas.height = total;
    }
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, total, total);
    ctx.fillStyle = dark;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (modules[r][c]) {
          ctx.fillRect(margin + c * scale, margin + r * scale, scale, scale);
        }
      }
    }
    return { size: n, scale };
  }

  return { encode, drawToCanvas };
});

