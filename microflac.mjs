/*!
 * microflac.js 1.0.0 - a small, dependency-free FLAC encoder in plain JavaScript.
 *
 * Copyright (c) 2026 Dialer's Apps
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial
 * portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
 * LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
 * THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * What it is
 *   Encodes PCM audio to FLAC. No WebAssembly, no DOM, no dependencies: it runs in a page, a Worker or Node.
 *   Every encoded file has a real STREAMINFO (including the MD5 of the unencoded audio), correct CRC-8 /
 *   CRC-16, and 4096-sample blocks (the last one may be shorter). The default level ("max") searches hard:
 *   all four stereo modes per block, FIXED predictors 0-4 and LPC orders 1-12 over six apodization windows
 *   with a coefficient-precision search, wasted-bits detection and an exact Rice partition search.
 *
 * API
 *   microflac.encode({ channels: [Float32Array | Float64Array | Int16Array | Int32Array, ...],
 *                      sampleRate: 44100, bitsPerSample: 16, level: "max", onProgress: fn }) -> Uint8Array
 *   microflac.encode({ interleaved: typedArray, numChannels: 2, sampleRate, bitsPerSample, ... })  -> Uint8Array
 *   microflac.encodeAsync(sameOptions) -> Promise<Uint8Array>      (yields to the event loop between blocks)
 *   microflac.createEncoder({ sampleRate, bitsPerSample, level }) -> { write(channels), writeInterleaved(a, n), finish() }
 *   microflac.version -> "1.0.0"
 *
 *   - bitsPerSample: 8, 16 (default) or 24. numChannels: 1 to 8 (stereo decorrelation only for 2).
 *   - Float input (Float32Array / Float64Array) is nominally -1..1 and is scaled by 2^(bitsPerSample-1) - 1,
 *     rounded and clamped. Integer input (Int16Array / Int32Array / ...) is used as-is, clamped to the
 *     range of bitsPerSample.
 *   - level: "max" (default) or "fast" (one window, LPC order <= 8, no precision search; several times faster,
 *     slightly larger files).
 *   - onProgress(fraction 0..1) is called after each block when the total length is known (encode / encodeAsync).
 */
const microflac = (function () {
"use strict";
const BLOCK = 4096, MAX_LPC = 12, MAX_PO = 8;
const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i, d = i << 8;
  for (let j = 0; j < 8; j++) {
    c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  }
  CRC8[i] = c; CRC16[i] = d;
}
const POW2 = new Float64Array(64), POWINV = new Float64Array(64);
for (let i = 0; i < 64; i++) { POW2[i] = Math.pow(2, i); POWINV[i] = Math.pow(2, -i); }
const bitlen = (x) => 32 - Math.clz32(x);

// ---------------------------------------------------------------- MD5
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
function Md5() {
  this.a = 0x67452301 | 0; this.b = 0xefcdab89 | 0; this.c = 0x98badcfe | 0; this.d = 0x10325476 | 0;
  this.buf = new Uint8Array(64); this.n = 0; this.total = 0; this.w = new Int32Array(16);
}
Md5.prototype._block = function (p, o) {
  const w = this.w;
  for (let i = 0; i < 16; i++) w[i] = p[o + 4 * i] | (p[o + 4 * i + 1] << 8) | (p[o + 4 * i + 2] << 16) | (p[o + 4 * i + 3] << 24);
  let a = this.a, b = this.b, c = this.c, d = this.d;
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
    else { f = c ^ (b | ~d); g = (7 * i) & 15; }
    const t = (a + f + MD5_K[i] + w[g]) | 0, s = MD5_S[i];
    a = d; d = c; c = b; b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
  }
  this.a = (this.a + a) | 0; this.b = (this.b + b) | 0; this.c = (this.c + c) | 0; this.d = (this.d + d) | 0;
};
Md5.prototype.update = function (bytes) {
  let i = 0; const len = bytes.length; this.total += len;
  if (this.n) {
    while (i < len && this.n < 64) this.buf[this.n++] = bytes[i++];
    if (this.n < 64) return;
    this._block(this.buf, 0); this.n = 0;
  }
  for (; i + 64 <= len; i += 64) this._block(bytes, i);
  while (i < len) this.buf[this.n++] = bytes[i++];
};
Md5.prototype.digest = function () {
  const bits = this.total * 8, lo = bits % 4294967296, hi = Math.floor(bits / 4294967296);
  const pad = new Uint8Array(((this.n < 56 ? 56 : 120) - this.n) + 8);
  pad[0] = 0x80;
  for (let i = 0; i < 4; i++) { pad[pad.length - 8 + i] = (lo >>> (8 * i)) & 255; pad[pad.length - 4 + i] = (hi >>> (8 * i)) & 255; }
  this.update(pad);
  const out = new Uint8Array(16);
  [this.a, this.b, this.c, this.d].forEach((v, j) => { for (let i = 0; i < 4; i++) out[j * 4 + i] = (v >>> (8 * i)) & 255; });
  return out;
};

// ---------------------------------------------------------------- bit writer
function BitWriter(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.nacc = 0; }
BitWriter.prototype.put = function (v, n) {            // n <= 16, v < 2^n
  this.acc = (this.acc << n) | v; this.nacc += n;
  while (this.nacc >= 8) { this.nacc -= 8; this.buf[this.pos++] = (this.acc >>> this.nacc) & 255; }
  this.acc &= (1 << this.nacc) - 1;
};
BitWriter.prototype.putBits = function (v, n) {         // n <= 32, 0 <= v < 2^n
  if (n <= 16) this.put(v, n);
  else { this.put(Math.floor(v / 65536), n - 16); this.put(v & 0xffff, 16); }
};
BitWriter.prototype.putSigned = function (v, n) { if (n > 0) this.putBits((v & ((1 << n) - 1)) >>> 0, n); };
BitWriter.prototype.putUnary = function (q) { while (q >= 16) { this.put(0, 16); q -= 16; } this.put(1, q + 1); };
BitWriter.prototype.align = function () { if (this.nacc) this.put(0, 8 - this.nacc); };

// ---------------------------------------------------------------- analysis scratch + windows
const sc = {
  y: new Int32Array(BLOCK), res: new Int32Array(BLOCK), U: new Uint32Array(BLOCK), yw: new Float64Array(BLOCK),
  autoc: new Float64Array(MAX_LPC + 1), coefs: new Float64Array(8 * (MAX_LPC + 1) * (MAX_LPC + 1)),
  q: new Float64Array(MAX_LPC), sums: new Float64Array(1 << MAX_PO), cnts: new Float64Array(1 << MAX_PO),
  costK: new Float64Array((1 << MAX_PO) * 32), maxAbsP: new Float64Array(1 << MAX_PO),
  tmpA: new Float64Array(MAX_LPC + 2), tmpB: new Float64Array(MAX_LPC + 2),
};
const winCache = new Map();
function segTukey(w, a, b, p) {
  const len = b - a; if (len <= 0) return;
  const Np = Math.floor(p / 2 * len) - 1;
  if (Np > 0) {
    for (let i = 0; i <= Np; i++) {
      w[a + i] = 0.5 - 0.5 * Math.cos(Math.PI * i / Np);
      w[b - Np - 1 + i] = 0.5 - 0.5 * Math.cos(Math.PI * (i + Np) / Np);
    }
    for (let i = a + Np + 1; i < b - Np - 1; i++) w[i] = 1;
  } else for (let i = a; i < b; i++) w[i] = 1;
}
function getWindows(n) {
  let ws = winCache.get(n); if (ws) return ws;
  ws = [];
  let w = new Float64Array(n); segTukey(w, 0, n, 0.5); ws.push(w);                                  // tukey(0.5)
  const parts = 2, ov = 0.1, psize = Math.floor(n / (parts - (parts - 1) * ov)), osize = Math.floor(psize * ov);
  for (let i = 0; i < parts; i++) {                                                                 // partial_tukey(2)
    w = new Float64Array(n); const s = i * (psize - osize), e = i === parts - 1 ? n : Math.min(n, s + psize);
    segTukey(w, s, e, 0.25); ws.push(w);
  }
  for (let i = 0; i < 3; i++) {                                                                     // punchout_tukey(3)
    w = new Float64Array(n); const hs = Math.floor(i * n / 3), he = Math.floor((i + 1) * n / 3);
    segTukey(w, 0, hs, 0.2); segTukey(w, he, n, 0.2); ws.push(w);
  }
  winCache.set(n, ws); return ws;
}

// ---------------------------------------------------------------- rice coding
function maxPartitionOrder(n, order) {
  let p = MAX_PO;
  while (p > 0 && ((n & ((1 << p) - 1)) !== 0 || (n >> p) <= order)) p--;
  return p;
}
function foldU(res, start, n) {
  const U = sc.U; let mx = 0;
  for (let i = start; i < n; i++) { const r = res[i], u = ((r << 1) ^ (r >> 31)) >>> 0; U[i] = u; if (u > mx) mx = u; }
  return mx;
}
function riceCostEst(sum, cnt) {
  if (cnt === 0) return 4;
  const mean = sum / cnt;
  let k = mean < 1 ? 0 : 31 - Math.clz32(mean >= 4294967295 ? 4294967295 : Math.floor(mean));
  if (k > 29) k = 29;
  const b0 = cnt * (k + 1) + sum * POWINV[k] - cnt * 0.5, b1 = cnt * (k + 2) + sum * POWINV[k + 1] - cnt * 0.5;
  return (b0 < b1 ? b0 : b1) + 4;
}
function riceEstimate(res, start, n, order) {
  foldU(res, start, n);
  const U = sc.U, sums = sc.sums, cnts = sc.cnts;
  const pmax = maxPartitionOrder(n, order), parts = 1 << pmax, psz = n >> pmax;
  for (let p = 0; p < parts; p++) {
    const lo = p === 0 ? start : p * psz, hi = (p + 1) * psz; let s = 0;
    for (let i = lo; i < hi; i++) s += U[i];
    sums[p] = s; cnts[p] = hi - lo;
  }
  let best = Infinity;
  for (let po = pmax; ; po--) {
    let total = 6; const np = 1 << po;
    for (let p = 0; p < np; p++) total += riceCostEst(sums[p], cnts[p]);
    if (total < best) best = total;
    if (po === 0) break;
    for (let p = 0; p < (np >> 1); p++) { sums[p] = sums[2 * p] + sums[2 * p + 1]; cnts[p] = cnts[2 * p] + cnts[2 * p + 1]; }
  }
  return best;
}
function ricePlan(res, start, n, order) {
  const maxU = foldU(res, start, n), U = sc.U;
  const pmax = maxPartitionOrder(n, order), parts = 1 << pmax, psz = n >> pmax;
  const kcap = maxU === 0 ? 0 : Math.min(30, bitlen(maxU)), KS = kcap + 1, costK = sc.costK, mab = sc.maxAbsP, cnts = sc.cnts;
  for (let p = 0; p < parts; p++) {
    const lo = p === 0 ? start : p * psz, hi = (p + 1) * psz; let m = 0;
    for (let i = lo; i < hi; i++) { const r = res[i], a = r < 0 ? -r : r; if (a > m) m = a; }
    mab[p] = m; cnts[p] = hi - lo;
  }
  for (let k = 0; k <= kcap; k++) {
    for (let p = 0; p < parts; p++) {
      const lo = p === 0 ? start : p * psz, hi = (p + 1) * psz; let s = 0;
      for (let i = lo; i < hi; i++) s += U[i] >>> k;
      costK[p * KS + k] = s + cnts[p] * (k + 1);
    }
  }
  const methods = kcap > 14 ? [0, 1] : [0];
  let best = Infinity, bestPo = 0, bestM = 0;
  const evalGroup = (po, g, method, out) => {          // returns cost; out = [k or -1 (escape), raw width]
    const gs = 1 << (pmax - po), base = g * gs, kmax = Math.min(kcap, method ? 30 : 14);
    let cnt = 0, m = 0;
    for (let j = 0; j < gs; j++) { cnt += cnts[base + j]; if (mab[base + j] > m) m = mab[base + j]; }
    const pbits = method ? 5 : 4;
    let bc = Infinity, bk = 0;
    for (let k = 0; k <= kmax; k++) {
      let c = 0; for (let j = 0; j < gs; j++) c += costK[(base + j) * KS + k];
      if (c < bc) { bc = c; bk = k; }
    }
    bc += pbits;
    const raw = m === 0 ? 0 : bitlen(m) + 1, ec = pbits + 5 + cnt * raw;
    if (ec < bc) { out[0] = -1; out[1] = raw; return ec; }
    out[0] = bk; out[1] = 0; return bc;
  };
  const tmp = [0, 0];
  for (const method of methods) {
    for (let po = 0; po <= pmax; po++) {
      let total = 6; const np = 1 << po;
      for (let g = 0; g < np; g++) total += evalGroup(po, g, method, tmp);
      if (total < best) { best = total; bestPo = po; bestM = method; }
    }
  }
  const np = 1 << bestPo, ks = new Int8Array(np), raws = new Uint8Array(np);
  for (let g = 0; g < np; g++) { evalGroup(bestPo, g, bestM, tmp); ks[g] = tmp[0]; raws[g] = tmp[1]; }
  return { bits: best, po: bestPo, method: bestM, ks, raws };
}

// ---------------------------------------------------------------- predictors
function fixedResidual(y, n, order, res) {
  switch (order) {
    case 0: for (let i = 0; i < n; i++) res[i] = y[i]; break;
    case 1: for (let i = 1; i < n; i++) res[i] = y[i] - y[i - 1]; break;
    case 2: for (let i = 2; i < n; i++) res[i] = y[i] - 2 * y[i - 1] + y[i - 2]; break;
    case 3: for (let i = 3; i < n; i++) res[i] = y[i] - 3 * y[i - 1] + 3 * y[i - 2] - y[i - 3]; break;
    default: for (let i = 4; i < n; i++) res[i] = y[i] - 4 * y[i - 1] + 6 * y[i - 2] - 4 * y[i - 3] + y[i - 4];
  }
}
function lpcResidual(y, n, q, order, shift, res) {       // false if a residual would not fit comfortably in 32 bits
  const scale = POWINV[shift];
  for (let i = order; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < order; j++) sum += q[j] * y[i - 1 - j];
    const r = y[i] - Math.floor(sum * scale);
    if (r > 1073741823 || r < -1073741824) return false;
    res[i] = r;
  }
  return true;
}
function quantize(a, off, order, prec, q) {              // -> shift, or -1 when unusable
  let cmax = 0;
  for (let j = 0; j < order; j++) { const v = Math.abs(a[off + j]); if (v > cmax) cmax = v; }
  if (!(cmax > 0) || !isFinite(cmax)) return -1;
  const log2cmax = Math.floor(Math.log2(cmax));
  let shift = prec - 1 - log2cmax - 1;
  if (shift > 15) shift = 15;
  if (shift < 0) shift = 0;
  const qmax = POW2[prec - 1] - 1, qmin = -qmax - 1, scale = POW2[shift];
  let err = 0;
  for (let j = 0; j < order; j++) {
    err += a[off + j] * scale;
    let v = Math.round(err);
    if (v > qmax) v = qmax; else if (v < qmin) v = qmin;
    q[j] = v; err -= v;
  }
  return shift;
}
// Levinson-Durbin: out[base + (m-1)*W + j] = coefficient j+1 of the order-m predictor; returns highest usable order
function lpcCoefs(autoc, maxOrder, out, base) {
  const a = sc.tmpA, t = sc.tmpB, W = MAX_LPC + 1; let err = autoc[0];
  a.fill(0);
  for (let m = 1; m <= maxOrder; m++) {
    let acc = autoc[m];
    for (let j = 1; j < m; j++) acc -= a[j] * autoc[m - j];
    const k = acc / err;
    for (let j = 1; j < m; j++) t[j] = a[j];
    for (let j = 1; j < m; j++) a[j] = t[j] - k * t[m - j];
    a[m] = k; err *= 1 - k * k;
    for (let j = 0; j < m; j++) out[base + (m - 1) * W + j] = a[j + 1];
    if (!(err > 0)) return m;
  }
  return maxOrder;
}

// ---------------------------------------------------------------- subframe analysis
function precisionFor(n) { return n <= 192 ? 7 : n <= 384 ? 8 : n <= 576 ? 9 : n <= 1152 ? 10 : n <= 2304 ? 11 : n <= 4608 ? 12 : 13; }
function analyze(x, n, bps, cfg) {
  const first = x[0]; let same = true, or = 0;
  for (let i = 0; i < n; i++) { const v = x[i]; if (v !== first) same = false; or |= v; }
  if (same) return { kind: 0, bits: 8 + bps, value: first, bps2: bps, wasted: 0, n };
  let w = 0;
  if (or !== 0) { while (!((or >> w) & 1) && w < bps - 1) w++; }
  const y = sc.y, bps2 = bps - w;
  if (w) for (let i = 0; i < n; i++) y[i] = x[i] >> w; else for (let i = 0; i < n; i++) y[i] = x[i];
  const hdr = 8 + w;
  let best = { kind: 1, bits: hdr + n * bps2, bps2, wasted: w, n, vals: null };
  const res = sc.res;
  // ---- fixed predictors
  let fixBest = -1, fixEst = Infinity;
  for (let o = 0; o <= 4 && o < n; o++) {
    fixedResidual(y, n, o, res);
    const est = hdr + o * bps2 + riceEstimate(res, o, n, o);
    if (est < fixEst) { fixEst = est; fixBest = o; }
  }
  const cands = [];
  if (fixBest >= 0) cands.push({ est: fixEst, lpc: false, fixed: fixBest });
  // ---- LPC
  const maxO = Math.min(cfg.maxLpc, n - 1);
  if (maxO >= 1 && n >= 16) {
    const windows = getWindows(n).slice(0, cfg.windows), W = MAX_LPC + 1, P0 = precisionFor(n);
    const top = [];                                      // every (window, order) with its estimate
    for (let wi = 0; wi < windows.length; wi++) {
      const win = windows[wi], yw = sc.yw, ac = sc.autoc;
      for (let i = 0; i < n; i++) yw[i] = y[i] * win[i];
      for (let lag = 0; lag <= maxO; lag++) { let s = 0; for (let i = lag; i < n; i++) s += yw[i] * yw[i - lag]; ac[lag] = s; }
      if (!(ac[0] > 0)) continue;
      ac[0] *= 1 + 1e-9;
      const base = wi * W * W, usable = lpcCoefs(ac, maxO, sc.coefs, base);
      for (let m = 1; m <= usable; m++) {
        const shift = quantize(sc.coefs, base + (m - 1) * W, m, P0, sc.q);
        if (shift < 0 || !lpcResidual(y, n, sc.q, m, shift, res)) continue;
        top.push({ est: hdr + m * bps2 + 9 + m * P0 + riceEstimate(res, m, n, m), wi, m });
      }
    }
    top.sort((a, b) => a.est - b.est);
    for (let t = 0; t < top.length && t < cfg.precTop; t++) {   // precision search on the best (window, order) pairs
      const c = top[t], base = c.wi * W * W + (c.m - 1) * W;
      for (let prec = Math.max(6, P0 + cfg.precLo); prec <= Math.min(15, P0 + cfg.precHi); prec++) {
        const shift = quantize(sc.coefs, base, c.m, prec, sc.q);
        if (shift < 0 || !lpcResidual(y, n, sc.q, c.m, shift, res)) continue;
        cands.push({ est: hdr + c.m * bps2 + 9 + c.m * prec + riceEstimate(res, c.m, n, c.m), lpc: true, wi: c.wi, m: c.m, prec });
      }
    }
  }
  cands.sort((a, b) => a.est - b.est);
  // ---- exact evaluation of the three best estimated candidates
  for (let ci = 0; ci < cands.length && ci < cfg.exactN; ci++) {
    const c = cands[ci];
    let order, shift = 0, q = null, prec = 0;
    if (c.lpc) {
      const W = MAX_LPC + 1;
      order = c.m; prec = c.prec;
      shift = quantize(sc.coefs, c.wi * W * W + (c.m - 1) * W, order, prec, sc.q);
      if (shift < 0 || !lpcResidual(y, n, sc.q, order, shift, res)) continue;
      q = Int32Array.from(sc.q.subarray(0, order));
    } else { order = c.fixed; fixedResidual(y, n, order, res); }
    const plan = ricePlan(res, order, n, order);
    const bits = hdr + order * bps2 + plan.bits + (c.lpc ? 9 + order * prec : 0);
    if (bits < best.bits) {
      best = { kind: c.lpc ? 3 : 2, bits, bps2, wasted: w, n, order, prec, shift, q, plan,
        res: Int32Array.from(res.subarray(0, n)), warm: Int32Array.from(y.subarray(0, order)) };
    }
  }
  if (best.kind === 1) best.vals = Int32Array.from(y.subarray(0, n));
  return best;
}
function writeSub(bw, d) {
  bw.put(0, 1);
  bw.put(d.kind === 0 ? 0 : d.kind === 1 ? 1 : d.kind === 2 ? 8 + d.order : 32 + d.order - 1, 6);
  if (d.wasted > 0) { bw.put(1, 1); bw.putUnary(d.wasted - 1); } else bw.put(0, 1);
  const b = d.bps2;
  if (d.kind === 0) { bw.putSigned(d.value, b); return; }
  if (d.kind === 1) { for (let i = 0; i < d.n; i++) bw.putSigned(d.vals[i], b); return; }
  for (let i = 0; i < d.order; i++) bw.putSigned(d.warm[i], b);
  if (d.kind === 3) {
    bw.put(d.prec - 1, 4); bw.putSigned(d.shift, 5);
    for (let j = 0; j < d.order; j++) bw.putSigned(d.q[j], d.prec);
  }
  const pl = d.plan, np = 1 << pl.po, psz = d.n >> pl.po, pbits = pl.method ? 5 : 4, esc = pl.method ? 31 : 15, res = d.res;
  bw.put(pl.method, 2); bw.put(pl.po, 4);
  for (let g = 0; g < np; g++) {
    const lo = g === 0 ? d.order : g * psz, hi = (g + 1) * psz, k = pl.ks[g];
    if (k < 0) {
      bw.put(esc, pbits); bw.put(pl.raws[g], 5);
      for (let i = lo; i < hi; i++) bw.putSigned(res[i], pl.raws[g]);
    } else {
      bw.put(k, pbits);
      for (let i = lo; i < hi; i++) {
        const r = res[i], u = ((r << 1) ^ (r >> 31)) >>> 0;
        bw.putUnary(u >>> k);
        if (k) bw.putBits(u & (POW2[k] - 1), k);
      }
    }
  }
}


// ---------------------------------------------------------------- public API
const SR_CODE = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };
const LEVELS = {
  max: { windows: 6, maxLpc: 12, precTop: 2, precLo: -2, precHi: 3, exactN: 3 },
  fast: { windows: 1, maxLpc: 8, precTop: 1, precLo: 0, precHi: 0, exactN: 1 },
};
const isFloatArray = (a) => a instanceof Float32Array || a instanceof Float64Array;
const isTyped = (a) => ArrayBuffer.isView(a) && !(a instanceof DataView);

function createEncoder(opts) {
  opts = opts || {};
  const sampleRate = opts.sampleRate, bps = opts.bitsPerSample === undefined ? 16 : opts.bitsPerSample;
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 1048575) throw new RangeError("microflac: sampleRate must be an integer 1..1048575");
  if (bps !== 8 && bps !== 16 && bps !== 24) throw new RangeError("microflac: bitsPerSample must be 8, 16 or 24");
  const cfg = LEVELS[opts.level === undefined ? "max" : opts.level];
  if (!cfg) throw new RangeError('microflac: level must be "max" or "fast"');
  const max = POW2[bps - 1] - 1, min = -max - 1, bytesPer = bps >> 3;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null, expected = opts.totalSamples || 0;
  let nch = opts.numChannels || 0, pend = null, pn = 0, total = 0, frameNo = 0, frames = [], finished = false;
  let minFrame = Infinity, maxFrame = 0, minBlock = Infinity, maxBlock = 0, lastBlock = 0, bw = null;
  const md5 = new Md5();

  function init(c) {
    if (!Number.isInteger(c) || c < 1 || c > 8) throw new RangeError("microflac: 1 to 8 channels are supported");
    nch = c; pend = []; for (let i = 0; i < nch; i++) pend.push(new Int32Array(BLOCK));
    bw = new BitWriter(BLOCK * nch * 4 + 2048);
  }
  // srcs[c]: typed array; stride 1 for separate channels, nch for interleaved (then start = c)
  function ingest(srcs, stride, len, offsets) {
    const bytes = new Uint8Array(len * nch * bytesPer);
    let bp = 0, off = 0;
    while (off < len) {
      const take = Math.min(BLOCK - pn, len - off);
      for (let c = 0; c < nch; c++) {
        const src = srcs[c], dst = pend[c], flt = isFloatArray(src);
        let k = offsets[c] + off * stride;
        for (let i = 0; i < take; i++, k += stride) {
          let s = flt ? Math.round(src[k] * max) : src[k];
          if (!(s >= min)) s = min; else if (s > max) s = max;     // also maps NaN to min
          dst[pn + i] = s;
        }
      }
      for (let i = 0; i < take; i++) for (let c = 0; c < nch; c++) {
        const s = pend[c][pn + i]; for (let b = 0; b < bytesPer; b++) bytes[bp++] = (s >> (8 * b)) & 255;
      }
      pn += take; off += take; total += take;
      if (pn === BLOCK) { encodeBlock(BLOCK); pn = 0; }
    }
    md5.update(bytes);
  }
  function write(channels) {
    if (finished) throw new Error("microflac: encoder already finished");
    if (!Array.isArray(channels) || !channels.length) throw new TypeError("microflac: write() takes an array of per-channel typed arrays");
    if (!pend) init(channels.length);
    if (channels.length !== nch) throw new RangeError("microflac: channel count changed");
    const len = channels[0].length;
    for (const c of channels) { if (!isTyped(c)) throw new TypeError("microflac: channels must be typed arrays"); if (c.length !== len) throw new RangeError("microflac: channels differ in length"); }
    ingest(channels, 1, len, channels.map(() => 0));
  }
  function writeInterleaved(arr, numChannels) {
    if (finished) throw new Error("microflac: encoder already finished");
    if (!isTyped(arr)) throw new TypeError("microflac: interleaved data must be a typed array");
    if (!pend) init(numChannels || nch);
    if (numChannels && numChannels !== nch) throw new RangeError("microflac: channel count changed");
    if (arr.length % nch) throw new RangeError("microflac: interleaved length is not a multiple of the channel count");
    const srcs = [], offs = []; for (let c = 0; c < nch; c++) { srcs.push(arr); offs.push(c); }
    ingest(srcs, nch, arr.length / nch, offs);
  }
  function encodeBlock(n) {
    const L = pend[0].subarray(0, n);
    let mode, subs;
    if (nch === 2) {
      const R = pend[1].subarray(0, n), M = new Int32Array(n), S = new Int32Array(n);
      for (let i = 0; i < n; i++) { S[i] = L[i] - R[i]; M[i] = (L[i] + R[i]) >> 1; }
      const dL = analyze(L, n, bps, cfg), dR = analyze(R, n, bps, cfg), dS = analyze(S, n, bps + 1, cfg), dM = analyze(M, n, bps, cfg);
      const choices = [[1, dL, dR], [8, dL, dS], [9, dS, dR], [10, dM, dS]];
      let pick = choices[0], bb = Infinity;
      for (const o of choices) { const b = o[1].bits + o[2].bits; if (b < bb) { bb = b; pick = o; } }
      mode = pick[0]; subs = [pick[1], pick[2]];
    } else {
      mode = nch - 1; subs = [];
      for (let c = 0; c < nch; c++) subs.push(analyze(pend[c].subarray(0, n), n, bps, cfg));
    }
    bw.pos = 0; bw.acc = 0; bw.nacc = 0;
    bw.put(0xff, 8); bw.put(0xf8, 8);
    const bsCode = n === 192 ? 1 : n === 576 ? 2 : n === 1152 ? 3 : n === 2304 ? 4 : n === 4608 ? 5 : n === 256 ? 8 : n === 512 ? 9 :
      n === 1024 ? 10 : n === 2048 ? 11 : n === 4096 ? 12 : n === 8192 ? 13 : n === 16384 ? 14 : n === 32768 ? 15 : n <= 256 ? 6 : 7;
    const srCode = SR_CODE[sampleRate] || 0;
    const sizeCode = bps === 8 ? 1 : bps === 16 ? 4 : 6;
    bw.put((bsCode << 4) | srCode, 8); bw.put((mode << 4) | (sizeCode << 1), 8);
    const f = frameNo;                                   // UTF-8 coded frame number
    if (f < 0x80) bw.put(f, 8);
    else {
      const nb = f < 0x800 ? 2 : f < 0x10000 ? 3 : f < 0x200000 ? 4 : f < 0x4000000 ? 5 : 6;
      bw.put(((0xff00 >> nb) & 0xff) | (f >>> (6 * (nb - 1))), 8);
      for (let i = nb - 2; i >= 0; i--) bw.put(0x80 | ((f >>> (6 * i)) & 0x3f), 8);
    }
    if (bsCode === 6) bw.put(n - 1, 8); else if (bsCode === 7) bw.put(n - 1, 16);
    let crc = 0; for (let i = 0; i < bw.pos; i++) crc = CRC8[crc ^ bw.buf[i]];
    bw.put(crc, 8);
    for (const d of subs) writeSub(bw, d);
    bw.align();
    let c16 = 0; for (let i = 0; i < bw.pos; i++) c16 = ((c16 << 8) & 0xffff) ^ CRC16[(c16 >> 8) ^ bw.buf[i]];
    bw.put(c16 >> 8, 8); bw.put(c16 & 255, 8);
    const out = bw.buf.slice(0, bw.pos);
    frames.push(out); frameNo++;
    if (out.length < minFrame) minFrame = out.length;
    if (out.length > maxFrame) maxFrame = out.length;
    if (lastBlock && lastBlock < minBlock) minBlock = lastBlock;
    if (n > maxBlock) maxBlock = n;
    lastBlock = n;
    if (onProgress && expected) onProgress(Math.min(1, (total - pn + n) / expected));
  }
  function finish() {
    if (finished) throw new Error("microflac: encoder already finished");
    if (!pend) init(nch || 1);
    if (pn > 0) { encodeBlock(pn); pn = 0; }
    finished = true;
    if (!frames.length) { minFrame = 0; minBlock = maxBlock = 0; }
    else if (minBlock === Infinity) minBlock = lastBlock;
    const head = new BitWriter(64);
    head.put(0x664c, 16); head.put(0x6143, 16);          // "fLaC"
    head.put(0x80, 8); head.put(0, 8); head.put(0, 8); head.put(34, 8);   // STREAMINFO, last-metadata flag
    head.put(Math.max(16, minBlock), 16); head.put(Math.max(16, maxBlock), 16);   // STREAMINFO block sizes are >= 16 by spec
    head.put(minFrame >>> 8, 16); head.put(minFrame & 255, 8); head.put(maxFrame >>> 8, 16); head.put(maxFrame & 255, 8);
    head.put(sampleRate >>> 4, 16); head.put(sampleRate & 15, 4); head.put(nch - 1, 3); head.put(bps - 1, 5);
    head.put(Math.floor(total / 4294967296), 4); head.putBits(total >>> 0, 32);
    const sum = md5.digest();
    for (let i = 0; i < 16; i++) head.put(sum[i], 8);
    let size = head.pos; for (const f of frames) size += f.length;
    const out = new Uint8Array(size); out.set(head.buf.subarray(0, head.pos), 0);
    let o = head.pos; for (const f of frames) { out.set(f, o); o += f.length; }
    frames = []; pend = null;
    return out;
  }
  return { write, writeInterleaved, finish };
}

function prepare(opts) {
  if (!opts || typeof opts !== "object") throw new TypeError("microflac: options object required");
  const o = Object.assign({}, opts);
  if (o.interleaved) {
    if (!isTyped(o.interleaved)) throw new TypeError("microflac: interleaved must be a typed array");
    if (!o.numChannels) throw new RangeError("microflac: numChannels is required with interleaved data");
    o.totalSamples = o.interleaved.length / o.numChannels;
  } else if (o.channels && o.channels.length) {
    o.numChannels = o.channels.length; o.totalSamples = o.channels[0].length;
  } else throw new TypeError("microflac: pass channels: [typedArray, ...] or interleaved + numChannels");
  return o;
}
function encode(opts) {
  const o = prepare(opts), enc = createEncoder(o);
  if (o.interleaved) enc.writeInterleaved(o.interleaved, o.numChannels); else enc.write(o.channels);
  return enc.finish();
}
async function encodeAsync(opts) {
  const o = prepare(opts), enc = createEncoder(o), step = BLOCK * 4, len = o.totalSamples;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  for (let off = 0; off < len || off === 0; off += step) {
    const end = Math.min(len, off + step);
    if (o.interleaved) enc.writeInterleaved(o.interleaved.subarray(off * o.numChannels, end * o.numChannels), o.numChannels);
    else enc.write(o.channels.map((c) => c.subarray(off, end)));
    if (end >= len) break;
    await tick();
  }
  return enc.finish();
}

return { version: "1.0.0", encode, encodeAsync, createEncoder };
})();
export default microflac;
export const { version, encode, encodeAsync, createEncoder } = microflac;
