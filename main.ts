// "Unzipping the Night" — the night sky is a sheet of cloth with a brass zipper in it.
// Someone has climbed a ladder from the hill and is pulling the slider down: where the
// zipper is open, the morning pours out.
//
// Everything is drawn procedurally: no image is read, no dependency is used. Shapes are
// painted back to front into a 3x supersampled linear-light buffer, which is then box
// filtered, bloomed and written with a small PNG encoder built on node:zlib.
//
// Run outside the grader:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1024;
const H = 1024;
const SS = 3;
const RW = W * SS;
const RH = H * SS;

// ---------------------------------------------------------------- helpers
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lin = (c: number) => Math.pow(c / 255, 2.2);
type RGB = [number, number, number];
const hex = (h: number, gain = 1): RGB => [lin((h >> 16) & 255) * gain, lin((h >> 8) & 255) * gain, lin(h & 255) * gain];

let seed = 20261113;
function rnd(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const h = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(wx - vx * h, wy - vy * h) - r;
}
function sdRBox(px: number, py: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// ---------------------------------------------------------------- canvas
// Unit coordinates: x and y in [0,1], y down. A shader returns coverage in [0,1] and
// leaves its colour in `col`; paint() blends it over what is already there.
const buf = new Float32Array(RW * RH * 3);
const col: RGB = [0, 0, 0];
function setc(c: RGB, k = 1) {
  col[0] = c[0] * k;
  col[1] = c[1] * k;
  col[2] = c[2] * k;
}
function paint(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => number) {
  const i0 = clamp(Math.floor(x0 * RW), 0, RW - 1);
  const i1 = clamp(Math.ceil(x1 * RW), 0, RW - 1);
  const j0 = clamp(Math.floor(y0 * RH), 0, RH - 1);
  const j1 = clamp(Math.ceil(y1 * RH), 0, RH - 1);
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) / RH;
    for (let i = i0; i <= i1; i++) {
      const a = fn((i + 0.5) / RW, y);
      if (a <= 0) continue;
      const k = (j * RW + i) * 3;
      if (a >= 1) {
        buf[k] = col[0];
        buf[k + 1] = col[1];
        buf[k + 2] = col[2];
      } else {
        buf[k] += (col[0] - buf[k]) * a;
        buf[k + 1] += (col[1] - buf[k + 1]) * a;
        buf[k + 2] += (col[2] - buf[k + 2]) * a;
      }
    }
  }
}

// ---------------------------------------------------------------- layout
const CXc = 0.5; // the zipper runs down the middle
const YS = 0.43; // where the two rows of teeth enter the slider
const YTOP = -0.04; // the opening runs off the top of the picture
const WTOP = 0.345; // half width of the opening up there
const MOUTH = 0.02; // half width at the slider
const HORIZON = 0.8;

// half width of the opening at height y (teardrop: it bellies out quickly above the slider)
function halfWidth(y: number): number {
  const t = clamp((YS - y) / (YS - YTOP), 0, 1.2);
  return MOUTH + (WTOP - MOUTH) * (1.25 * Math.pow(t, 0.62) - 0.25 * t * t);
}

// the right-hand edge as a polyline with arc length; the left edge is its mirror image
const EN = 160;
const EX = new Float64Array(EN + 1);
const EY = new Float64Array(EN + 1);
const ES = new Float64Array(EN + 1);
for (let i = 0; i <= EN; i++) {
  const u = i / EN;
  const t = u * u * 1.05; // denser near the slider where the curve turns fastest
  EY[i] = YS - t * (YS - YTOP);
  EX[i] = halfWidth(EY[i]);
  ES[i] = i === 0 ? 0 : ES[i - 1] + Math.hypot(EX[i] - EX[i - 1], EY[i] - EY[i - 1]);
}
// distance from (|x - centre|, y) to the edge, and the arc length of the nearest point
let edgeS = 0;
function edgeDist(ax: number, y: number): number {
  let best = 1e9;
  for (let i = 0; i < EN; i++) {
    const vx = EX[i + 1] - EX[i];
    const vy = EY[i + 1] - EY[i];
    const wx = ax - EX[i];
    const wy = y - EY[i];
    const h = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
    const d = Math.hypot(wx - vx * h, wy - vy * h);
    if (d < best) {
      best = d;
      edgeS = ES[i] + h * (ES[i + 1] - ES[i]);
    }
  }
  return best;
}
const inOpening = (x: number, y: number) => y < YS && Math.abs(x - CXc) < halfWidth(y);

// ---------------------------------------------------------------- palette
const NIGHT_TOP = hex(0x0a0d33);
const NIGHT_LOW = hex(0x1a2a78);
const TAPE = hex(0x2a348c);
const TAPE_LIT = hex(0xf08a4b);
const STITCH = hex(0xf6e7bd);
const STAR = hex(0xfff3cf);
const BRASS = hex(0xf2b33a);
const BRASS_HI = hex(0xffe9a0);
const BRASS_LO = hex(0xb06a14);
const INK = hex(0x1b0f2e);
const HILL_FAR = hex(0x16205f);
const HILL_MID = hex(0x0f164a);
const HILL_NEAR = hex(0x080b2c);
const WOOD = hex(0xe9b56a);
const WOOD_LO = hex(0x9a5a2a);
const COAT = hex(0xffc93c);
const COAT_LO = hex(0xd98a1e);
const SCARF = hex(0xe8372f);
const SKIN = hex(0xf6c79a);
const TROUSERS = hex(0x8f9bea);
const TROUSERS_LO = hex(0x6672c4);
const BOOT = hex(0x9c2a22);

// ---------------------------------------------------------------- 1. the night cloth
// tension creases fan out from the slider, where the cloth is being pulled
function creases(x: number, y: number): number {
  const dx = x - CXc;
  const dy = y - (YS + 0.03);
  const r = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx);
  const fan = Math.sin(a * 9 + 0.6) * 0.6 + Math.sin(a * 17 - 1.1) * 0.4;
  return fan * Math.exp(-r / 0.34) * smooth(0.03, 0.12, r);
}
paint(0, 0, 1, 1, (x, y) => {
  const g = smooth(0.0, 0.85, y);
  const c = 1 + 0.2 * creases(x, y);
  col[0] = mix(NIGHT_TOP[0], NIGHT_LOW[0], g) * c;
  col[1] = mix(NIGHT_TOP[1], NIGHT_LOW[1], g) * c;
  col[2] = mix(NIGHT_TOP[2], NIGHT_LOW[2], g) * c;
  return 1;
});

// stars: plain dots, a few four-point sparkles, and a thin crescent moon
for (let i = 0; i < 230; i++) {
  const sx = rnd();
  const sy = rnd() * 0.8;
  const big = rnd();
  const r = 0.0011 + 0.0022 * big * big * big;
  const k = 0.45 + 0.55 * rnd();
  if (Math.abs(sx - CXc) < halfWidth(Math.min(sy, YS)) + 0.05 && sy < YS + 0.03) continue;
  paint(sx - r, sy - r, sx + r, sy + r, (x, y) => {
    setc(STAR, k);
    return Math.hypot(x - sx, y - sy) < r ? 1 : 0;
  });
}
const SPARKS = [
  [0.085, 0.3, 0.02],
  [0.9, 0.1, 0.024],
  [0.2, 0.56, 0.015],
  [0.83, 0.47, 0.018],
  [0.93, 0.66, 0.013],
  [0.06, 0.68, 0.014],
  [0.76, 0.27, 0.012],
  [0.3, 0.74, 0.011],
];
for (const [sx, sy, r] of SPARKS) {
  paint(sx - r, sy - r, sx + r, sy + r, (x, y) => {
    const ax = Math.abs(x - sx) / r;
    const ay = Math.abs(y - sy) / r;
    setc(STAR, 1.25);
    // astroid: |x|^(1/2) + |y|^(1/2) < 1
    return Math.sqrt(ax) + Math.sqrt(ay) < 1 ? 1 : 0;
  });
}
{
  const mx = 0.135;
  const my = 0.13;
  const mr = 0.052;
  paint(mx - mr, my - mr, mx + mr, my + mr, (x, y) => {
    setc(STAR, 1.2);
    return Math.hypot(x - mx, y - my) < mr && Math.hypot(x - mx - 0.024, y - my + 0.012) > mr * 0.95 ? 1 : 0;
  });
}

// ---------------------------------------------------------------- 2. the morning behind it
const SUNX = CXc;
const SUNY = 0.215;
const SUNR = 0.112;
const DAWN: [number, RGB][] = [
  [0.0, hex(0xffdd55, 1.12)],
  [0.04, hex(0xffbe32, 1.05)],
  [0.09, hex(0xff9426)],
  [0.15, hex(0xfa6a35)],
  [0.22, hex(0xee4556)],
  [0.3, hex(0xc93279)],
  [0.4, hex(0x8a2b8e)],
];
const SUN = hex(0xfff3b0, 1.12);
const CLOUD = hex(0xfff0cf, 1.2);
// flat storybook clouds: a row of overlapping bumps on a flat base
function cloud(x: number, y: number, cx: number, cy: number, w: number, h: number): boolean {
  const u = (x - cx) / w;
  if (u < -1.15 || u > 1.15) return false;
  const base = cy + h * 0.55;
  if (y > base) return false;
  if (Math.abs(u) < 1 && y > base - h * 0.5) return true;
  if (Math.hypot(u * w, y - (base - h * 0.25)) < 0 ) return true;
  const bumps = [-0.72, -0.25, 0.3, 0.74];
  const sizes = [0.5, 0.95, 0.72, 0.45];
  for (let i = 0; i < 4; i++) {
    const r = h * sizes[i];
    if (Math.hypot(x - cx - bumps[i] * w, y - (base - r * 0.55)) < r) return true;
  }
  return Math.hypot(x - cx + w, y - base + h * 0.25) < h * 0.25 || Math.hypot(x - cx - w, y - base + h * 0.25) < h * 0.25;
}
paint(CXc - WTOP - 0.02, 0, CXc + WTOP + 0.02, YS, (x, y) => {
  if (!inOpening(x, y)) return 0;
  const d = Math.hypot(x - SUNX, y - SUNY);
  if (d < SUNR) {
    setc(SUN);
  } else {
    // posterised rings of colour around the sun
    const e = d - SUNR;
    let i = 0;
    while (i < DAWN.length - 1 && e > DAWN[i + 1][0]) i++;
    setc(DAWN[i][1]);
  }
  if (cloud(x, y, 0.435, 0.292, 0.085, 0.034) || cloud(x, y, 0.64, 0.135, 0.07, 0.03) || cloud(x, y, 0.33, 0.07, 0.06, 0.026)) {
    setc(CLOUD);
  }
  return 1;
});
// birds leaving the opening for the night side
const BIRDS = [
  [0.585, 0.245, 0.017, -0.25],
  [0.63, 0.205, 0.013, -0.1],
  [0.555, 0.19, 0.011, -0.35],
  [0.69, 0.25, 0.012, -0.2],
];
for (const [bx, by, bs, tilt] of BIRDS) {
  paint(bx - bs * 1.3, by - bs, bx + bs * 1.3, by + bs, (x, y) => {
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    const px = ((x - bx) * c + (y - by) * s) / bs;
    const py = (-(x - bx) * s + (y - by) * c) / bs;
    // two shallow arcs meeting in the middle
    const ax = Math.abs(px);
    if (ax > 1) return 0;
    const wing = -0.55 * Math.sin(ax * Math.PI) * (1 - 0.35 * ax) + 0.28 * ax;
    setc(INK);
    return Math.abs(py - wing) < 0.13 * (1.15 - ax) + 0.03 ? 1 : 0;
  });
}

// ---------------------------------------------------------------- 3. zipper tape, stitches, warm rim
const TAPE_W = 0.03;
paint(0, 0, 1, YS + 0.05, (x, y) => {
  const ax = Math.abs(x - CXc);
  if (inOpening(x, y)) return 0;
  if (ax > halfWidth(Math.min(y, YS)) + TAPE_W * 2.4) return 0;
  const d = edgeDist(ax, y);
  if (d > TAPE_W) return 0;
  // morning light catches the rim of the cloth
  const rim = 1 - smooth(0, 0.011, d);
  col[0] = mix(TAPE[0], TAPE_LIT[0], rim);
  col[1] = mix(TAPE[1], TAPE_LIT[1], rim);
  col[2] = mix(TAPE[2], TAPE_LIT[2], rim);
  // a row of stitches along the outer side of the tape
  if (Math.abs(d - TAPE_W * 0.72) < 0.0017 && (edgeS / 0.0125) % 1 < 0.62) setc(STITCH);
  return 1;
});
// below the slider the tape runs straight down to the horizon
paint(CXc - TAPE_W - 0.022, YS, CXc + TAPE_W + 0.022, HORIZON + 0.03, (x, y) => {
  const ax = Math.abs(x - CXc);
  if (ax > TAPE_W + MOUTH - 0.004) return 0;
  setc(TAPE);
  if (Math.abs(ax - (MOUTH - 0.004 + TAPE_W * 0.72)) < 0.0017 && (y / 0.0125) % 1 < 0.62) setc(STITCH);
  return 1;
});

// ---------------------------------------------------------------- 4. teeth
// one brass tooth: base at (bx,by), pointing along (nx,ny)
const TOOTH_L = 0.027;
const TOOTH_W = 0.0125;
function tooth(bx: number, by: number, nx: number, ny: number, shade: number) {
  const cx = bx + nx * TOOTH_L * 0.5;
  const cy = by + ny * TOOTH_L * 0.5;
  const R = TOOTH_L * 0.75;
  paint(cx - R, cy - R, cx + R, cy + R, (x, y) => {
    const px = x - cx;
    const py = y - cy;
    const u = px * nx + py * ny; // along the tooth
    const v = -px * ny + py * nx; // across it
    // shank plus a slightly wider rounded head
    const d = Math.min(
      sdRBox(u, v, TOOTH_L * 0.5, TOOTH_W * 0.4, 0.002),
      sdRBox(u - TOOTH_L * 0.24, v, TOOTH_L * 0.27, TOOTH_W * 0.5, 0.0045),
    );
    if (d > 0) return 0;
    if (d > -0.0021) {
      setc(INK);
      return 1;
    }
    // lit from the upper left
    const l = clamp(0.5 - (px * 0.7 + py * 0.7) / TOOTH_W, 0, 1);
    col[0] = mix(BRASS_LO[0], mix(BRASS[0], BRASS_HI[0], smooth(0.6, 0.95, l)), smooth(0.05, 0.5, l)) * shade;
    col[1] = mix(BRASS_LO[1], mix(BRASS[1], BRASS_HI[1], smooth(0.6, 0.95, l)), smooth(0.05, 0.5, l)) * shade;
    col[2] = mix(BRASS_LO[2], mix(BRASS[2], BRASS_HI[2], smooth(0.6, 0.95, l)), smooth(0.05, 0.5, l)) * shade;
    return 1;
  });
}
// open rows: teeth stand along each edge and point into the opening
{
  const pitch = 0.0235;
  let next = 0.034;
  for (let i = 1; i <= EN; i++) {
    while (ES[i] >= next) {
      const h = (next - ES[i - 1]) / (ES[i] - ES[i - 1]);
      const ex = mix(EX[i - 1], EX[i], h);
      const ey = mix(EY[i - 1], EY[i], h);
      let tx = EX[i] - EX[i - 1];
      let ty = EY[i] - EY[i - 1];
      const tl = Math.hypot(tx, ty);
      tx /= tl;
      ty /= tl;
      // normal that points toward the centre line (decreasing |x|)
      let nx = ty;
      let ny = -tx;
      if (nx > 0) {
        nx = -nx;
        ny = -ny;
      }
      if (ey > -0.03) {
        tooth(CXc + ex - nx * 0.006, ey - ny * 0.006, nx, ny, 1);
        tooth(CXc - ex + nx * 0.006, ey - ny * 0.006, -nx, ny, 1);
      }
      next += pitch;
    }
  }
}
// closed row: teeth from both sides interlock down to the horizon
{
  const pitch = 0.0118;
  let side = 1;
  for (let y = YS + 0.075; y < HORIZON + 0.02; y += pitch) {
    tooth(CXc + side * 0.0155, y, -side, 0, 1);
    side = -side;
  }
}

// ---------------------------------------------------------------- 5. the land
const farHill = (x: number) => HORIZON - 0.012 * Math.sin(x * 9 + 0.5) - 0.02 * Math.sin(x * 3.3 + 2) - 0.006 * Math.sin(x * 23);
const midHill = (x: number) => 0.855 - 0.03 * Math.sin(x * 5.2 + 1.2) - 0.012 * Math.sin(x * 13 + 0.3);
const nearHill = (x: number) => 0.93 - 0.075 * Math.exp(-Math.pow((x - 0.66) / 0.2, 2)) - 0.03 * Math.exp(-Math.pow((x - 0.2) / 0.16, 2)) + 0.012 * Math.sin(x * 11);
paint(0, HORIZON - 0.06, 1, 1, (x, y) => {
  if (y > nearHill(x)) setc(HILL_NEAR);
  else if (y > midHill(x)) setc(HILL_MID);
  else if (y > farHill(x)) setc(HILL_FAR);
  else return 0;
  return 1;
});
// a small house with one lit window, where the climber came from
{
  const hx = 0.2;
  const hy = nearHill(0.2) + 0.004;
  const WINDOW = hex(0xffd35a, 1.6);
  paint(hx - 0.06, hy - 0.09, hx + 0.06, hy, (x, y) => {
    const px = x - hx;
    const py = y - hy;
    setc(HILL_NEAR);
    if (Math.abs(px - 0.004) < 0.009 && py > -0.034 && py < -0.014) {
      setc(WINDOW);
      return 1;
    }
    if (Math.abs(px) < 0.03 && py > -0.045 && py <= 0) return 1; // walls
    if (py <= -0.045 && py > -0.078 && Math.abs(px) < 0.04 * (1 - (-0.045 - py) / 0.033)) return 1; // roof
    if (Math.abs(px + 0.018) < 0.005 && py > -0.08 && py <= -0.05) return 1; // chimney
    return 0;
  });
  // round trees beside it
  for (const [tx, tr] of [
    [0.105, 0.03],
    [0.29, 0.022],
    [0.86, 0.026],
  ]) {
    // firs: three stacked triangles on a short trunk
    const base = nearHill(tx) + 0.004;
    const th = tr * 3.4;
    paint(tx - tr, base - th, tx + tr, base, (x, y) => {
      setc(HILL_NEAR);
      const up = (base - y) / th; // 0 at the ground, 1 at the tip
      if (up < 0 || up > 1) return 0;
      if (up < 0.14) return Math.abs(x - tx) < tr * 0.14 ? 1 : 0;
      const tier = up < 0.45 ? (0.45 - up) / 0.31 : up < 0.72 ? (0.72 - up) / 0.27 * 0.78 : (1 - up) / 0.28 * 0.56;
      return Math.abs(x - tx) < tr * (0.12 + 0.88 * tier) ? 1 : 0;
    });
  }
}

// ---------------------------------------------------------------- 6. slider and pull tab
const SL_Y = YS + 0.035; // centre of the slider body
const TAB_AX = CXc;
const TAB_AY = SL_Y + 0.022; // where the tab hangs from
const TAB_BX = CXc + 0.03;
const TAB_BY = SL_Y + 0.135; // the end the climber holds
function brass(l: number) {
  const a = smooth(0.05, 0.5, l);
  const b = smooth(0.62, 0.95, l);
  col[0] = mix(BRASS_LO[0], mix(BRASS[0], BRASS_HI[0], b), a);
  col[1] = mix(BRASS_LO[1], mix(BRASS[1], BRASS_HI[1], b), a);
  col[2] = mix(BRASS_LO[2], mix(BRASS[2], BRASS_HI[2], b), a);
}
paint(CXc - 0.08, YS - 0.03, CXc + 0.08, YS + 0.1, (x, y) => {
  const px = x - CXc;
  const py = y - SL_Y;
  // body: wide shoulders where the two rows enter, narrowing to the single closed row
  const half = mix(0.06, 0.034, smooth(-0.045, 0.04, py));
  let d = sdRBox(px, py, half, 0.05, 0.02);
  // the notch between the two mouths
  d = Math.max(d, -(Math.hypot(px, py + 0.058) - 0.02));
  if (d > 0) return 0;
  if (d > -0.0032) {
    setc(INK);
    return 1;
  }
  brass(clamp(0.55 - (px * 0.9 + py * 0.9) / 0.11, 0, 1));
  // raised bridge the tab hangs from
  const bd = sdRBox(px, py + 0.002, 0.013, 0.03, 0.01);
  if (bd < 0) {
    if (bd > -0.0026) setc(INK);
    else brass(clamp(0.75 - (px + py) / 0.05, 0, 1));
  }
  return 1;
});
paint(CXc - 0.05, SL_Y, CXc + 0.09, TAB_BY + 0.04, (x, y) => {
  const d = sdCapsule(x, y, TAB_AX, TAB_AY, TAB_BX, TAB_BY, 0.0175);
  if (d > 0) return 0;
  // the slot near the end of the tab
  const hole = sdCapsule(x, y, mix(TAB_AX, TAB_BX, 0.62), mix(TAB_AY, TAB_BY, 0.62), mix(TAB_AX, TAB_BX, 0.9), mix(TAB_AY, TAB_BY, 0.9), 0.0062);
  if (hole < 0) return 0;
  if (d > -0.003 || hole < 0.003) {
    setc(INK);
    return 1;
  }
  brass(clamp(0.5 - ((x - TAB_AX) * 0.8 + (y - TAB_AY - 0.05) * 0.3) / 0.05, 0, 1));
  return 1;
});

// ---------------------------------------------------------------- 7. ladder and climber
const LBX = 0.672;
const LBY = nearHill(0.672) + 0.006;
const LTX = 0.578;
const LTY = 0.552;
const LLEN = Math.hypot(LTX - LBX, LTY - LBY);
const LUX = (LTX - LBX) / LLEN; // unit vector up the ladder
const LUY = (LTY - LBY) / LLEN;
const LNX = -LUY; // across the ladder (toward the right)
const LNY = LUX;
const RAIL = 0.018; // half distance between the rails
paint(Math.min(LBX, LTX) - 0.04, LTY - 0.02, Math.max(LBX, LTX) + 0.04, LBY + 0.02, (x, y) => {
  const px = x - LBX;
  const py = y - LBY;
  const u = px * LUX + py * LUY;
  const v = px * LNX + py * LNY;
  if (u < -0.004 || u > LLEN + 0.004) return 0;
  const av = Math.abs(v);
  if (Math.abs(av - RAIL) < 0.0036) {
    setc(v < 0 ? WOOD : WOOD_LO); // the rail facing the light is brighter
    return 1;
  }
  if (av < RAIL && Math.abs((u % 0.0262) - 0.0131) < 0.0027 && u > 0.01) {
    setc(WOOD_LO);
    return 1;
  }
  return 0;
});
// the climber, built from capsules; P(u, v) is a point u up the ladder and v across it
const P = (u: number, v: number): [number, number] => [LBX + LUX * u + LNX * v, LBY + LUY * u + LNY * v];
{
  const U0 = LLEN * 0.5; // how far up the ladder the lower foot stands
  const footL = P(U0, -0.006);
  const footR = P(U0 + 0.04, 0.008);
  const kneeR = P(U0 + 0.07, 0.04);
  const hip = P(U0 + 0.082, 0.014);
  const neck = P(U0 + 0.142, 0.007);
  const head = P(U0 + 0.168, 0.005);
  const handUp: [number, number] = [TAB_BX + 0.004, TAB_BY - 0.004];
  const elbowUp: [number, number] = [mix(neck[0], handUp[0], 0.5) + 0.004, mix(neck[1], handUp[1], 0.5) + 0.016];
  const handRail = P(U0 + 0.125, -RAIL);
  const x0 = Math.min(handUp[0], footL[0]) - 0.07;
  const x1 = Math.max(kneeR[0], hip[0]) + 0.1;
  const y0 = Math.min(head[1], handUp[1]) - 0.04;
  const y1 = footL[1] + 0.02;
  const HAIR = hex(0x2a1638);
  const HAT = SCARF;
  paint(x0, y0, x1, y1, (x, y) => {
    let hit = 0;
    // scarf streaming out behind, away from the opening
    {
      const sx = x - neck[0];
      const sy = y - neck[1];
      if (sx > 0 && sx < 0.1) {
        const wave = 0.01 * Math.sin(sx * 72) - sx * 0.25;
        const th = 0.0098 * (1 - sx / 0.112);
        if (Math.abs(sy - wave) < th) {
          setc(SCARF);
          hit = 1;
        }
      }
    }
    // far leg, then near leg
    if (sdCapsule(x, y, hip[0], hip[1], footL[0], footL[1], 0.0088) < 0) {
      setc(TROUSERS_LO);
      hit = 1;
    }
    if (sdCapsule(x, y, hip[0], hip[1], kneeR[0], kneeR[1], 0.0094) < 0 || sdCapsule(x, y, kneeR[0], kneeR[1], footR[0], footR[1], 0.0086) < 0) {
      setc(TROUSERS);
      hit = 1;
    }
    // boots
    if (sdCapsule(x, y, footL[0] - 0.011, footL[1], footL[0] + 0.005, footL[1], 0.008) < 0 || sdCapsule(x, y, footR[0] - 0.011, footR[1], footR[0] + 0.005, footR[1], 0.008) < 0) {
      setc(BOOT);
      hit = 1;
    }
    // arm holding the rail
    if (sdCapsule(x, y, neck[0], neck[1] + 0.008, handRail[0], handRail[1], 0.0068) < 0) {
      setc(COAT_LO);
      hit = 1;
    }
    // coat: a long capsule, lit on the side facing the morning
    const dc = sdCapsule(x, y, neck[0], neck[1] + 0.011, hip[0], hip[1] + 0.005, 0.0175);
    if (dc < 0) {
      setc(x - neck[0] > 0.005 ? COAT_LO : COAT);
      hit = 1;
    }
    // scarf wrap at the neck
    if (sdCapsule(x, y, neck[0] - 0.011, neck[1] + 0.001, neck[0] + 0.012, neck[1] + 0.004, 0.0072) < 0) {
      setc(SCARF);
      hit = 1;
    }
    // head and woolly hat
    const dh = Math.hypot(x - head[0], y - head[1]);
    if (dh < 0.019) {
      setc(SKIN);
      if (y < head[1] - 0.003) setc(HAT);
      else if (x > head[0] + 0.008) setc(HAIR);
      hit = 1;
    }
    if (Math.hypot(x - head[0] - 0.002, y - head[1] + 0.0235) < 0.0068) {
      setc(STITCH);
      hit = 1;
    }
    // the arm reaching for the pull tab, drawn last so it reads clearly
    if (sdCapsule(x, y, neck[0] - 0.005, neck[1] + 0.011, elbowUp[0], elbowUp[1], 0.0073) < 0 || sdCapsule(x, y, elbowUp[0], elbowUp[1], handUp[0], handUp[1], 0.0068) < 0) {
      setc(COAT);
      hit = 1;
    }
    if (Math.hypot(x - handUp[0], y - handUp[1]) < 0.0088) {
      setc(SKIN);
      hit = 1;
    }
    return hit;
  });
}

// ---------------------------------------------------------------- resolve
const img = new Float32Array(W * H * 3);
{
  const inv = 1 / (SS * SS);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += buf[((y * SS + j) * RW + x * SS + i) * 3 + c];
        img[(y * W + x) * 3 + c] = s * inv;
      }
}

// bloom: only what is brighter than paper white spills, so the flat colours stay flat
const BW = W / 4;
const BH = H / 4;
function blur(src: Float32Array, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  const kr = Math.ceil(radius * 2.5);
  const kern = new Float32Array(kr * 2 + 1);
  let sum = 0;
  for (let i = -kr; i <= kr; i++) {
    kern[i + kr] = Math.exp(-(i * i) / (2 * radius * radius));
    sum += kern[i + kr];
  }
  for (let i = 0; i < kern.length; i++) kern[i] /= sum;
  for (let y = 0; y < BH; y++)
    for (let x = 0; x < BW; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let i = -kr; i <= kr; i++) s += kern[i + kr] * src[(y * BW + clamp(x + i, 0, BW - 1)) * 3 + c];
        tmp[(y * BW + x) * 3 + c] = s;
      }
  for (let y = 0; y < BH; y++)
    for (let x = 0; x < BW; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let i = -kr; i <= kr; i++) s += kern[i + kr] * tmp[(clamp(y + i, 0, BH - 1) * BW + x) * 3 + c];
        dst[(y * BW + x) * 3 + c] = s;
      }
  return dst;
}
const small = new Float32Array(BW * BH * 3);
for (let y = 0; y < BH; y++)
  for (let x = 0; x < BW; x++)
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s += Math.max(0, img[((y * 4 + j) * W + x * 4 + i) * 3 + c] - 0.55);
      small[(y * BW + x) * 3 + c] = s / 16;
    }
const b1 = blur(small, 3);
const b2 = blur(small, 14);
function sampleBloom(b: Float32Array, x: number, y: number, c: number): number {
  const fx = clamp((x + 0.5) / 4 - 0.5, 0, BW - 1);
  const fy = clamp((y + 0.5) / 4 - 0.5, 0, BH - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, BW - 1);
  const y1 = Math.min(y0 + 1, BH - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  return mix(mix(b[(y0 * BW + x0) * 3 + c], b[(y0 * BW + x1) * 3 + c], tx), mix(b[(y1 * BW + x0) * 3 + c], b[(y1 * BW + x1) * 3 + c], tx), ty);
}

// ---------------------------------------------------------------- tone + PNG
const shoulder = (v: number) => (v <= 0.8 ? v : 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2)));
const raw = Buffer.alloc(H * (1 + W * 3));
const rowBuf = new Uint8Array(W * 3);
const prev = new Uint8Array(W * 3);
const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(W * 3));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const vig = 1 - 0.35 * smooth(0.5, 1.0, Math.hypot((x + 0.5) / W - 0.5, (y + 0.5) / H - 0.5) * 1.3);
    for (let c = 0; c < 3; c++) {
      let v = img[(y * W + x) * 3 + c];
      v += 0.1 * sampleBloom(b1, x, y, c) + 0.16 * sampleBloom(b2, x, y, c);
      rowBuf[x * 3 + c] = Math.round(Math.pow(shoulder(v * vig), 1 / 2.2) * 255);
    }
  }
  // choose the PNG filter with the smallest sum of absolute residuals
  let best = 0;
  let bestScore = Infinity;
  for (let f = 0; f < 5; f++) {
    const o = cand[f];
    let score = 0;
    for (let i = 0; i < W * 3; i++) {
      const a = i >= 3 ? rowBuf[i - 3] : 0;
      const b = prev[i];
      const cc = i >= 3 ? prev[i - 3] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - cc);
        const pb = Math.abs(a - cc);
        const pc = Math.abs(a + b - 2 * cc);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
      }
      const d = (rowBuf[i] - p) & 255;
      o[i] = d;
      score += d < 128 ? d : 256 - d;
    }
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  const off = y * (1 + W * 3);
  raw[off] = best;
  raw.set(cand[best], off + 1);
  prev.set(rowBuf);
}

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  let c = 0xffffffff;
  for (let i = 0; i < body.length; i++) c = CRC[(c ^ body[i]) & 255] ^ (c >>> 8);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolour
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
