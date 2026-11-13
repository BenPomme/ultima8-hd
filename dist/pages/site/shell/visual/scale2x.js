// shell/visual/scale2x.js
// Pure, dependency-free Scale2x (AdvMAME2x) edge-aware upscaler.
//
// Scale2x doubles each source pixel into a 2x2 block and only ever paints a
// block pixel with a colour that already exists in the neighbourhood, so the
// original game palette and full alpha are preserved exactly (no new colours,
// no blending, no invented detail). It is the same quadrant rule the WebGL
// presentation shader in ./framefilter.js evaluates on the GPU; keeping a pure
// JS copy gives the 2D fallback path and the unit tests a single ground truth.
//
// Rule (E = source pixel, A/B/C/D = up/right/left/down neighbours):
//   E0 (top-left)     = (C==A && C!=D && A!=B) ? A : E
//   E1 (top-right)    = (A==B && A!=C && B!=D) ? B : E
//   E2 (bottom-left)  = (D==C && D!=B && C!=A) ? C : E
//   E3 (bottom-right) = (B==D && B!=A && D!=C) ? D : E
// Out-of-bounds neighbours read as E, so border pixels stay unmodified.

const DEFAULT_ALPHA = 255;

function clampIndex(v, max) {
  return v < 0 ? 0 : v > max ? max : v;
}

/**
 * Double an RGBA source buffer with the Scale2x quadrant rule.
 *
 * @param {ArrayLike<number>} src  RGBA samples, length >= width*height*4.
 * @param {number} width           source width in pixels (> 0).
 * @param {number} height          source height in pixels (> 0).
 * @returns {Uint8ClampedArray}    RGBA output, length width*height*4*4.
 */
export function scale2x(src, width, height) {
  if (!src) throw new TypeError("scale2x: src buffer is required");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`scale2x: width/height must be positive integers (got ${width}x${height})`);
  }
  if (src.length < width * height * 4) {
    throw new RangeError(`scale2x: src too small (${src.length} < ${width * height * 4})`);
  }

  const w = width;
  const h = height;
  const outW = w * 2;
  const out = new Uint8ClampedArray(outW * h * 2 * 4);

  for (let y = 0; y < h; y++) {
    const upY = clampIndex(y - 1, h - 1);
    const downY = clampIndex(y + 1, h - 1);
    for (let x = 0; x < w; x++) {
      const leftX = clampIndex(x - 1, w - 1);
      const rightX = clampIndex(x + 1, w - 1);

      const e = (y * w + x) * 4;
      const a = (upY * w + x) * 4;       // up
      const b = (y * w + rightX) * 4;    // right
      const c = (y * w + leftX) * 4;     // left
      const d = (downY * w + x) * 4;     // down

      const Er = src[e], Eg = src[e + 1], Eb = src[e + 2];
      const Ea = src[e + 3] ?? DEFAULT_ALPHA;
      const Ar = src[a], Ag = src[a + 1], Ab = src[a + 2], Aa = src[a + 3] ?? DEFAULT_ALPHA;
      const Br = src[b], Bg = src[b + 1], Bb = src[b + 2], Ba = src[b + 3] ?? DEFAULT_ALPHA;
      const Cr = src[c], Cg = src[c + 1], Cb = src[c + 2], Ca = src[c + 3] ?? DEFAULT_ALPHA;
      const Dr = src[d], Dg = src[d + 1], Db = src[d + 2], Da = src[d + 3] ?? DEFAULT_ALPHA;

      const eq = (r1, g1, b1, a1, r2, g2, b2, a2) =>
        r1 === r2 && g1 === g2 && b1 === b2 && a1 === a2;

      // E0: left and up agree, and neither matches down/right.
      let e0 = esrc(Er, Eg, Eb, Ea);
      if (eq(Cr, Cg, Cb, Ca, Ar, Ag, Ab, Aa) && !eq(Cr, Cg, Cb, Ca, Dr, Dg, Db, Da) && !eq(Ar, Ag, Ab, Aa, Br, Bg, Bb, Ba)) {
        e0 = [Ar, Ag, Ab, Aa];
      }
      // E1: up and right agree, and neither matches left/down.
      let e1 = esrc(Er, Eg, Eb, Ea);
      if (eq(Ar, Ag, Ab, Aa, Br, Bg, Bb, Ba) && !eq(Ar, Ag, Ab, Aa, Cr, Cg, Cb, Ca) && !eq(Br, Bg, Bb, Ba, Dr, Dg, Db, Da)) {
        e1 = [Br, Bg, Bb, Ba];
      }
      // E2: down and left agree, and neither matches right/up.
      let e2 = esrc(Er, Eg, Eb, Ea);
      if (eq(Dr, Dg, Db, Da, Cr, Cg, Cb, Ca) && !eq(Dr, Dg, Db, Da, Br, Bg, Bb, Ba) && !eq(Cr, Cg, Cb, Ca, Ar, Ag, Ab, Aa)) {
        e2 = [Cr, Cg, Cb, Ca];
      }
      // E3: right and down agree, and neither matches up/left.
      let e3 = esrc(Er, Eg, Eb, Ea);
      if (eq(Br, Bg, Bb, Ba, Dr, Dg, Db, Da) && !eq(Br, Bg, Bb, Ba, Ar, Ag, Ab, Aa) && !eq(Dr, Dg, Db, Da, Cr, Cg, Cb, Ca)) {
        e3 = [Dr, Dg, Db, Da];
      }

      const topLeft = (y * 2 * outW + x * 2) * 4;
      const topRight = topLeft + 4;
      const botLeft = topLeft + outW * 4;
      const botRight = botLeft + 4;
      out[topLeft] = e0[0]; out[topLeft + 1] = e0[1]; out[topLeft + 2] = e0[2]; out[topLeft + 3] = e0[3];
      out[topRight] = e1[0]; out[topRight + 1] = e1[1]; out[topRight + 2] = e1[2]; out[topRight + 3] = e1[3];
      out[botLeft] = e2[0]; out[botLeft + 1] = e2[1]; out[botLeft + 2] = e2[2]; out[botLeft + 3] = e2[3];
      out[botRight] = e3[0]; out[botRight + 1] = e3[1]; out[botRight + 2] = e3[2]; out[botRight + 3] = e3[3];
    }
  }
  return out;
}

function esrc(r, g, b, a) { return [r, g, b, a]; }

/** Output dimensions for a given source size (integer 2x). */
export function scale2xSize(width, height) {
  return { width: width * 2, height: height * 2 };
}
