// The inner loop of the image search, in WebAssembly with SIMD.
//
// lib/match.js finds every place a picture appears by cross-correlation, and
// does it with Fourier transforms over overlapping tiles: transform a tile of
// the page, multiply by the template's transform, transform back. Measured on
// a real deck that is ninety-four percent of the second check, and nearly all
// of it is the two transforms. This is those transforms and the multiply
// between them, four lanes at a time -- nothing else.
//
// It computes the same thing, not something close to it. The butterflies run
// in the same order as fftRun in match.js, on the same twiddles, so the only
// difference is that every step here is rounded to single precision where the
// JavaScript works in double and rounds on storing. The self-test holds the
// two together on real planes.
//
// No libc, no allocator, no imports: match.js owns the memory, lays the
// buffers out in it, and hands this pointers. Built by tools/wasm.mjs:
//
//   clang --target=wasm32 -O3 -msimd128 -nostdlib -Wl,--no-entry ...
//
// Twiddles arrive expanded by stage, so a butterfly's four twiddles are four
// neighbouring floats rather than four strided reads: for each stage of
// length len, half = len/2 values, cos(-2*pi*k/n) for k < half, stage after
// stage -- n - 1 values in all, and the same again for sine.
#include <wasm_simd128.h>

typedef float f32;

static void bitreverse(f32 *re, f32 *im, int n, int stride) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      int a = i * stride, b = j * stride;
      f32 t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
}

// One row: contiguous, so four neighbouring butterflies of a stage share a
// vector. The first two stages have fewer than four and stay scalar.
static void fft_row(f32 *re, f32 *im, int n, const f32 *twr, const f32 *twi, int inverse) {
  bitreverse(re, im, n, 1);
  int off = 0;
  for (int len = 2; len <= n; len <<= 1) {
    int half = len >> 1;
    const f32 *cr = twr + off;
    const f32 *ci = twi + off;
    for (int i = 0; i < n; i += len) {
      int k = 0;
      for (; k + 4 <= half; k += 4) {
        v128_t wr = wasm_v128_load(cr + k);
        v128_t wi = wasm_v128_load(ci + k);
        if (inverse) wi = wasm_f32x4_neg(wi);
        f32 *ar = re + i + k, *ai = im + i + k;
        f32 *br = ar + half, *bi = ai + half;
        v128_t xr = wasm_v128_load(br), xi = wasm_v128_load(bi);
        v128_t tr = wasm_f32x4_sub(wasm_f32x4_mul(xr, wr), wasm_f32x4_mul(xi, wi));
        v128_t ti = wasm_f32x4_add(wasm_f32x4_mul(xr, wi), wasm_f32x4_mul(xi, wr));
        v128_t yr = wasm_v128_load(ar), yi = wasm_v128_load(ai);
        wasm_v128_store(br, wasm_f32x4_sub(yr, tr));
        wasm_v128_store(bi, wasm_f32x4_sub(yi, ti));
        wasm_v128_store(ar, wasm_f32x4_add(yr, tr));
        wasm_v128_store(ai, wasm_f32x4_add(yi, ti));
      }
      for (; k < half; k++) {
        f32 wr = cr[k];
        f32 wi = inverse ? -ci[k] : ci[k];
        int a = i + k, b = a + half;
        f32 br = re[b], bi = im[b];
        f32 tr = br * wr - bi * wi;
        f32 ti = br * wi + bi * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
    off += half;
  }
}

// Four neighbouring columns at once: element i of each is contiguous in
// memory across the four, so every stage is a vector operation with the
// twiddle broadcast.
static void fft_cols4(f32 *re, f32 *im, int w, int h, int x,
                      const f32 *twr, const f32 *twi, int inverse) {
  for (int i = 1, j = 0; i < h; i++) {
    int bit = h >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      f32 *ra = re + i * w + x, *rb = re + j * w + x;
      f32 *ia = im + i * w + x, *ib = im + j * w + x;
      v128_t t = wasm_v128_load(ra);
      wasm_v128_store(ra, wasm_v128_load(rb)); wasm_v128_store(rb, t);
      t = wasm_v128_load(ia);
      wasm_v128_store(ia, wasm_v128_load(ib)); wasm_v128_store(ib, t);
    }
  }
  int off = 0;
  for (int len = 2; len <= h; len <<= 1) {
    int half = len >> 1;
    const f32 *cr = twr + off;
    const f32 *ci = twi + off;
    for (int i = 0; i < h; i += len) {
      for (int k = 0; k < half; k++) {
        v128_t wr = wasm_f32x4_splat(cr[k]);
        v128_t wi = wasm_f32x4_splat(inverse ? -ci[k] : ci[k]);
        f32 *ar = re + (i + k) * w + x, *ai = im + (i + k) * w + x;
        f32 *br = re + (i + k + half) * w + x, *bi = im + (i + k + half) * w + x;
        v128_t xr = wasm_v128_load(br), xi = wasm_v128_load(bi);
        v128_t tr = wasm_f32x4_sub(wasm_f32x4_mul(xr, wr), wasm_f32x4_mul(xi, wi));
        v128_t ti = wasm_f32x4_add(wasm_f32x4_mul(xr, wi), wasm_f32x4_mul(xi, wr));
        v128_t yr = wasm_v128_load(ar), yi = wasm_v128_load(ai);
        wasm_v128_store(br, wasm_f32x4_sub(yr, tr));
        wasm_v128_store(bi, wasm_f32x4_sub(yi, ti));
        wasm_v128_store(ar, wasm_f32x4_add(yr, tr));
        wasm_v128_store(ai, wasm_f32x4_add(yi, ti));
      }
    }
    off += half;
  }
}

// A single column, for a width that is not a multiple of four.
static void fft_col(f32 *re, f32 *im, int w, int h, int x,
                    const f32 *twr, const f32 *twi, int inverse) {
  bitreverse(re + x, im + x, h, w);
  int off = 0;
  for (int len = 2; len <= h; len <<= 1) {
    int half = len >> 1;
    const f32 *cr = twr + off;
    const f32 *ci = twi + off;
    for (int i = 0; i < h; i += len) {
      for (int k = 0; k < half; k++) {
        f32 wr = cr[k];
        f32 wi = inverse ? -ci[k] : ci[k];
        int a = (i + k) * w + x, b = (i + k + half) * w + x;
        f32 br = re[b], bi = im[b];
        f32 tr = br * wr - bi * wi;
        f32 ti = br * wi + bi * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
    off += half;
  }
}

// The whole two-dimensional transform, rows then columns, as fft2 in
// match.js does it; the inverse scaled by 1/n at the end, as it is there.
__attribute__((export_name("fft2")))
void fft2(f32 *re, f32 *im, int w, int h, int inverse,
          const f32 *twWr, const f32 *twWi, const f32 *twHr, const f32 *twHi) {
  for (int y = 0; y < h; y++) fft_row(re + y * w, im + y * w, w, twWr, twWi, inverse);
  int x = 0;
  for (; x + 4 <= w; x += 4) fft_cols4(re, im, w, h, x, twHr, twHi, inverse);
  for (; x < w; x++) fft_col(re, im, w, h, x, twHr, twHi, inverse);
  if (inverse) {
    int n = w * h;
    f32 by = 1.0f / (f32)n;
    v128_t vb = wasm_f32x4_splat(by);
    int i = 0;
    for (; i + 4 <= n; i += 4) {
      wasm_v128_store(re + i, wasm_f32x4_mul(wasm_v128_load(re + i), vb));
      wasm_v128_store(im + i, wasm_f32x4_mul(wasm_v128_load(im + i), vb));
    }
    for (; i < n; i++) { re[i] *= by; im[i] *= by; }
  }
}

// The pointwise product with the template's spectrum, in place.
__attribute__((export_name("multiply")))
void multiply(f32 *re, f32 *im, const f32 *sr, const f32 *si, int n) {
  int i = 0;
  for (; i + 4 <= n; i += 4) {
    v128_t ar = wasm_v128_load(re + i), ai = wasm_v128_load(im + i);
    v128_t br = wasm_v128_load(sr + i), bi = wasm_v128_load(si + i);
    wasm_v128_store(re + i, wasm_f32x4_sub(wasm_f32x4_mul(ar, br), wasm_f32x4_mul(ai, bi)));
    wasm_v128_store(im + i, wasm_f32x4_add(wasm_f32x4_mul(ar, bi), wasm_f32x4_mul(ai, br)));
  }
  for (; i < n; i++) {
    f32 ar = re[i], ai = im[i];
    re[i] = ar * sr[i] - ai * si[i];
    im[i] = ar * si[i] + ai * sr[i];
  }
}

// Every position's sum of products, directly, for the small windows that
// refinement and verification score: a few hundred positions, where a
// transform costs more than it saves. The same sum the JavaScript loop makes,
// sixteen positions at a time.
//
// Each position's row of products is summed in single precision -- a row is
// at most a few hundred terms -- and the rows are carried in double, as the
// JavaScript carries the whole sum.
//
// And every pixel is taken relative to the position's own first one. The
// template sums to zero, so that changes nothing in the answer, and it is
// what makes single precision safe here: on blank paper each product is a
// pixel near 255 times a template value near 128, the sum cancels to almost
// nothing, and what is left of it in single precision is rounding -- measured,
// 63 where the true sum was -2.4. The score divides that by the patch's
// contrast, which on blank paper is nearly none, and rounding became a match.
// Relative to the patch's own pixel, blank paper is zeroes, and the rounding
// is of the patch's contrast and no more.
static inline v128_t lo64(v128_t v) { return wasm_f64x2_promote_low_f32x4(v); }
static inline v128_t hi64(v128_t v) {
  return wasm_f64x2_promote_low_f32x4(wasm_i32x4_shuffle(v, v, 2, 3, 2, 3));
}

__attribute__((export_name("dots")))
void dots(const f32 *g, int gw, const f32 *t, int tw, int th,
          double *out, int cols, int rows) {
  for (int y = 0; y < rows; y++) {
    double *o = out + y * cols;
    int x = 0;
    for (; x + 16 <= cols; x += 16) {
      v128_t d[8];
      for (int k = 0; k < 8; k++) d[k] = wasm_f64x2_splat(0);
      const f32 *first = g + y * gw + x;
      v128_t c0 = wasm_v128_load(first), c1 = wasm_v128_load(first + 4);
      v128_t c2 = wasm_v128_load(first + 8), c3 = wasm_v128_load(first + 12);
      for (int j = 0; j < th; j++) {
        const f32 *gr = g + (y + j) * gw + x;
        const f32 *tr = t + j * tw;
        v128_t a0 = wasm_f32x4_splat(0), a1 = a0, a2 = a0, a3 = a0;
        for (int i = 0; i < tw; i++) {
          v128_t w = wasm_f32x4_splat(tr[i]);
          a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(gr + i), c0), w));
          a1 = wasm_f32x4_add(a1, wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(gr + i + 4), c1), w));
          a2 = wasm_f32x4_add(a2, wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(gr + i + 8), c2), w));
          a3 = wasm_f32x4_add(a3, wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(gr + i + 12), c3), w));
        }
        d[0] = wasm_f64x2_add(d[0], lo64(a0)); d[1] = wasm_f64x2_add(d[1], hi64(a0));
        d[2] = wasm_f64x2_add(d[2], lo64(a1)); d[3] = wasm_f64x2_add(d[3], hi64(a1));
        d[4] = wasm_f64x2_add(d[4], lo64(a2)); d[5] = wasm_f64x2_add(d[5], hi64(a2));
        d[6] = wasm_f64x2_add(d[6], lo64(a3)); d[7] = wasm_f64x2_add(d[7], hi64(a3));
      }
      for (int k = 0; k < 8; k++) wasm_v128_store(o + x + 2 * k, d[k]);
    }
    for (; x + 4 <= cols; x += 4) {
      v128_t d0 = wasm_f64x2_splat(0), d1 = d0;
      v128_t c = wasm_v128_load(g + y * gw + x);
      for (int j = 0; j < th; j++) {
        const f32 *gr = g + (y + j) * gw + x;
        const f32 *tr = t + j * tw;
        v128_t a = wasm_f32x4_splat(0);
        for (int i = 0; i < tw; i++) {
          a = wasm_f32x4_add(a, wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(gr + i), c), wasm_f32x4_splat(tr[i])));
        }
        d0 = wasm_f64x2_add(d0, lo64(a));
        d1 = wasm_f64x2_add(d1, hi64(a));
      }
      wasm_v128_store(o + x, d0);
      wasm_v128_store(o + x + 2, d1);
    }
    for (; x < cols; x++) {
      double sum = 0;
      f32 c = g[y * gw + x];
      for (int j = 0; j < th; j++) {
        const f32 *gr = g + (y + j) * gw + x;
        const f32 *tr = t + j * tw;
        f32 row = 0;
        for (int i = 0; i < tw; i++) row += (gr[i] - c) * tr[i];
        sum += row;
      }
      o[x] = sum;
    }
  }
}
