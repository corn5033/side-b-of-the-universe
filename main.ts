// "Side B of the Universe" — a black hole whose accretion disk is a vinyl record,
// played by a tonearm that pivots on a small moon.
//
// Everything is drawn procedurally: no image is read, no dependency is used. The scene is an
// analytic per-sample shader rendered with supersampling in linear HDR, then bloomed,
// tone-mapped and written with a small PNG encoder built on node:zlib.
//
// Run outside the grader:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1024;
const H = 1024;
const SS = 3; // supersamples per axis

// ---------------------------------------------------------------- math helpers
const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const fract = (x: number) => x - Math.floor(x);

function hash2(i: number, j: number): number {
  let n = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = Math.imul(n ^ (n >>> 15), 2246822519);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// value noise; when px > 0 the x axis wraps with that period (used around the disk)
function vnoise(x: number, y: number, px: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  let x0 = xi;
  let x1 = xi + 1;
  if (px > 0) {
    x0 = ((x0 % px) + px) % px;
    x1 = ((x1 % px) + px) % px;
  }
  const a = hash2(x0, yi);
  const b = hash2(x1, yi);
  const c = hash2(x0, yi + 1);
  const d = hash2(x1, yi + 1);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

function fbm(x: number, y: number, oct: number, px: number): number {
  let s = 0;
  let a = 0.5;
  let p = px;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y, p);
    x = x * 2 + 17.3;
    y = y * 2 + 9.1;
    p *= 2;
    a *= 0.5;
  }
  return s;
}

// ---------------------------------------------------------------- scene layout
// Screen space is [-1,1]^2 with y pointing down.
const CX = -0.07;
const CY = 0.08; // black hole centre
const ROT = -0.2; // roll of the record in the picture plane
const COSR = Math.cos(ROT);
const SINR = Math.sin(ROT);
const TILT = 0.46; // squash of the disk: we look at the record from above
const RIN = 0.27;
const ROUT = 0.9;
const RS = 0.215; // shadow radius on screen
const GROOVES = 64;

// needle position on the record (disk-plane polar coordinates)
const NEEDLE_R = 0.635;
const NEEDLE_TH = 0.62;
function diskToScreen(r: number, th: number): [number, number] {
  const X = r * Math.cos(th);
  const Y = r * Math.sin(th) * TILT;
  return [CX + X * COSR - Y * SINR, CY + X * SINR + Y * COSR];
}
const [NX, NY] = diskToScreen(NEEDLE_R, NEEDLE_TH);

// the moon the tonearm pivots on
const MX = 0.73;
const MY = -0.66;
const MR = 0.17;
// tonearm: gimbal on the moon -> head just above the needle
const GX = MX - 0.035;
const GY = MY + 0.04;
const HX = NX + 0.012;
const HY = NY - 0.05;

const out3 = [0, 0, 0];

// ---------------------------------------------------------------- background
function background(u: number, v: number, o: number[]) {
  // deep space gradient + two soft nebula clouds (teal low-left, violet high-right)
  const n1 = fbm(u * 1.6 + 3.1, v * 1.6 + 1.7, 5, 0);
  const n2 = fbm(u * 2.3 - 5.2, v * 2.3 + 8.4, 5, 0);
  const teal = smooth(0.42, 0.78, n1) * smooth(1.5, 0.2, Math.hypot(u + 0.75, v - 0.8));
  const vio = smooth(0.45, 0.8, n2) * smooth(1.4, 0.1, Math.hypot(u - 0.2, v + 0.85));
  let r = 0.004 + teal * 0.004 + vio * 0.05;
  let g = 0.005 + teal * 0.06 + vio * 0.008;
  let b = 0.014 + teal * 0.085 + vio * 0.09;

  // stars: two jittered grids
  for (let layer = 0; layer < 2; layer++) {
    const cells = layer === 0 ? 70 : 26;
    const sx = (u + 1.5) * cells;
    const sy = (v + 1.5) * cells;
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const h = hash2(ix + layer * 131, iy - layer * 57);
    if (h > (layer === 0 ? 0.9 : 0.93)) {
      const jx = 0.25 + 0.5 * hash2(ix * 3 + 1, iy * 5 + layer);
      const jy = 0.25 + 0.5 * hash2(ix * 7 + 2, iy * 3 + layer);
      const dx = (sx - ix - jx) / cells;
      const dy = (sy - iy - jy) / cells;
      const d2 = dx * dx + dy * dy;
      const k = hash2(ix + 9, iy + 4);
      const size = layer === 0 ? 0.0013 : 0.0022;
      const inten = (layer === 0 ? 0.45 : 1.5) * (0.15 + k * k * k * 3.0) * Math.exp(-d2 / (size * size));
      const tint = hash2(ix - 3, iy + 11);
      r += inten * (0.75 + 0.25 * tint);
      g += inten * 0.85;
      b += inten * (1.0 - 0.3 * tint);
    }
  }
  o[0] = r;
  o[1] = g;
  o[2] = b;
}

// a few hero stars with diffraction spikes: [x, y, intensity]
const HERO: number[][] = [
  [-0.78, -0.72, 1.0],
  [-0.3, -0.86, 0.55],
  [0.86, 0.62, 0.8],
  [-0.9, 0.3, 0.45],
  [0.2, -0.55, 0.4],
  [0.55, 0.9, 0.5],
];
function heroStars(u: number, v: number, o: number[]) {
  for (let i = 0; i < HERO.length; i++) {
    const dx = u - HERO[i][0];
    const dy = v - HERO[i][1];
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > 0.09 || ay > 0.09) continue;
    const d2 = dx * dx + dy * dy;
    const k = HERO[i][2];
    let s = 9 * Math.exp(-d2 / 0.000012);
    s += 1.6 * Math.exp(-ay / 0.0016) * Math.exp(-ax / (0.022 * k));
    s += 1.6 * Math.exp(-ax / 0.0016) * Math.exp(-ay / (0.022 * k));
    s *= k;
    o[0] += s * 0.8;
    o[1] += s * 0.9;
    o[2] += s;
  }
}

// ---------------------------------------------------------------- the record
// heat ramp from the molten inner edge to cold black vinyl
const RAMP_T = [0.0, 0.07, 0.2, 0.38, 0.6, 1.0];
const RAMP_C = [
  [6.5, 5.2, 3.4],
  [4.2, 2.0, 0.5],
  [2.2, 0.6, 0.08],
  [0.8, 0.11, 0.05],
  [0.13, 0.012, 0.06],
  [0.035, 0.005, 0.045],
];
function ramp(t: number, o: number[]) {
  let i = 0;
  while (i < RAMP_T.length - 2 && t > RAMP_T[i + 1]) i++;
  const f = clamp((t - RAMP_T[i]) / (RAMP_T[i + 1] - RAMP_T[i]), 0, 1);
  const a = RAMP_C[i];
  const b = RAMP_C[i + 1];
  o[0] = mix(a[0], b[0], f);
  o[1] = mix(a[1], b[1], f);
  o[2] = mix(a[2], b[2], f);
}

const GAPS = [0.36, 0.55, 0.74, 0.9]; // silent bands between "tracks"
const SHEEN_TH = 2.5; // direction of the vinyl highlight wedge

function disk(X: number, Y: number, o: number[]) {
  const r = Math.hypot(X, Y);
  const th = Math.atan2(Y, X);
  const t = (r - RIN) / (ROUT - RIN);
  ramp(t, o);

  // grooves: every ring has its own brightness, with a fine dark line between rings
  const gr = r * GROOVES;
  const gi = Math.floor(gr);
  const gh = hash2(gi, 7);
  const gf = gr - gi;
  let line = (0.5 + 0.5 * gh) * (0.72 + 0.28 * Math.cos(TAU * gf));

  // silent bands
  let gap = 0;
  for (let i = 0; i < GAPS.length; i++) gap = Math.max(gap, 1 - smooth(0.008, 0.014, Math.abs(t - GAPS[i])));
  line = mix(line, 0.3, gap);

  // molten turbulence, sheared into a spiral, fading out toward the cold rim
  const a = th / TAU + 0.5;
  const n = fbm(a * 20 + r * 5.5, r * 13, 4, 20);
  const plasma = mix(0.35 + 2.1 * n * n, 1, smooth(0.25, 0.85, t));

  // the approaching side burns brighter
  const doppler = 1 + 0.45 * Math.cos(th - 2.9);

  const e = line * plasma * doppler;
  o[0] *= e;
  o[1] *= e;
  o[2] *= e;

  // vinyl sheen: two opposite wedges, warm on one side and teal on the other
  const cs = Math.cos(th - SHEEN_TH);
  const wedge = Math.pow(Math.abs(cs), 46);
  const vinyl = smooth(0.22, 0.55, t) * (0.25 + 0.75 * gh) * (1 - 0.6 * gap) * (0.7 + 0.3 * Math.cos(TAU * gf));
  const sh = wedge * vinyl;
  if (cs > 0) {
    o[0] += sh * 1.9;
    o[1] += sh * 1.25;
    o[2] += sh * 0.7;
  } else {
    o[0] += sh * 0.25;
    o[1] += sh * 1.25;
    o[2] += sh * 1.5;
  }
  // broad faint second sheen so the cold vinyl never goes completely dead
  const broad = Math.pow(Math.abs(cs), 6) * vinyl * 0.1;
  o[0] += broad * 0.9;
  o[1] += broad * 0.5;
  o[2] += broad * 0.7;

  // the groove already played glows behind the needle
  let dth = NEEDLE_TH - th;
  dth -= Math.floor(dth / TAU) * TAU; // angle behind the needle, 0..TAU
  const trail = Math.exp(-dth / 1.5) * Math.exp(-Math.pow((r - NEEDLE_R) / 0.0045, 2));
  o[0] += trail * 0.5;
  o[1] += trail * 4.2;
  o[2] += trail * 5.5;

  // crisp lit outer lip
  const lip = smooth(0.985, 1.0, t);
  o[0] += lip * 1.1;
  o[1] += lip * 0.3;
  o[2] += lip * 0.6;
}

// ---------------------------------------------------------------- tonearm pieces
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number, res: number[]) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const L2 = vx * vx + vy * vy;
  const h = clamp((wx * vx + wy * vy) / L2, 0, 1);
  const dx = wx - vx * h;
  const dy = wy - vy * h;
  res[0] = Math.hypot(dx, dy);
  res[1] = h;
  res[2] = (wx * vy - wy * vx) / Math.sqrt(L2); // signed side
}
const seg = [0, 0, 0];

// chrome tube shading across its width, s in [-1,1]
function chrome(s: number, o: number[], gain: number) {
  const warm = Math.exp(-Math.pow((s + 0.3) / 0.28, 2));
  const cool = Math.exp(-Math.pow((s - 0.78) / 0.2, 2));
  const body = 0.05 * (1 - s * s);
  o[0] = gain * (body + warm * 1.7 + cool * 0.1);
  o[1] = gain * (body + warm * 1.25 + cool * 0.75);
  o[2] = gain * (body * 1.4 + warm * 0.85 + cool * 1.0);
}

const ARM_LEN = Math.hypot(HX - GX, HY - GY);
const ADX = (HX - GX) / ARM_LEN;
const ADY = (HY - GY) / ARM_LEN;

// returns coverage (0/1) and writes colour
function tonearm(u: number, v: number, o: number[]): number {
  // counterweight: a fat cylinder behind the gimbal
  // counterweight: a short flat-ended drum behind the gimbal, on a thin stub
  const gx = u - GX;
  const gy = v - GY;
  const galong = gx * ADX + gy * ADY;
  const gside = gx * ADY - gy * ADX;
  if (galong > -0.15 && galong < -0.062 && Math.abs(gside) < 0.043) {
    chrome(-gside / 0.043, o, 0.42);
    const ends = smooth(0, 0.008, Math.min(galong + 0.15, -0.062 - galong));
    const knurl = (0.8 + 0.2 * Math.cos(galong * 520)) * (0.45 + 0.55 * ends);
    o[0] *= knurl;
    o[1] *= knurl;
    o[2] *= knurl;
    return 1;
  }
  if (galong > -0.07 && galong < 0 && Math.abs(gside) < 0.009) {
    chrome(-gside / 0.009, o, 0.8);
    return 1;
  }
  // headshell: a wedge at the end of the tube, slightly angled
  const hx = u - HX;
  const hy = v - HY;
  const along = hx * ADX + hy * ADY;
  const side = hx * ADY - hy * ADX;
  // cartridge: a dark block under the headshell, edge-lit orange by the record below it
  if (along > -0.02 && along < 0.05 && Math.abs(side) < 0.033) {
    const ex = Math.min(along + 0.02, 0.05 - along) / 0.035;
    const ey = (0.033 - Math.abs(side)) / 0.033;
    const edge = 1 - smooth(0, 0.3, Math.min(ex, ey));
    o[0] = 0.035 + edge * 2.4;
    o[1] = 0.03 + edge * 0.95;
    o[2] = 0.05 + edge * 0.3;
    return 1;
  }
  // headshell plate tapering from the tube out to the cartridge
  if (along > -0.085 && along <= -0.02) {
    const half = mix(0.0125, 0.03, smooth(-0.085, -0.02, along));
    if (Math.abs(side) < half) {
      chrome(-side / half, o, 0.7);
      return 1;
    }
  }
  // finger lift: thin curved hook off the headshell
  segDist(u, v, HX + ADY * 0.03, HY - ADX * 0.03, HX + ADY * 0.095 - ADX * 0.012, HY - ADX * 0.095 - ADY * 0.012, seg);
  if (seg[0] < 0.007) {
    chrome(seg[2] / 0.006, o, 0.8);
    return 1;
  }
  // the tube
  segDist(u, v, GX, GY, HX - ADX * 0.06, HY - ADY * 0.06, seg);
  if (seg[0] < 0.0125) {
    chrome(-seg[2] / 0.0125, o, 1.0);
    return 1;
  }
  // gimbal collar
  const gd = Math.hypot(u - GX, v - GY);
  if (gd < 0.04) {
    const s = gd / 0.04;
    const ring = Math.exp(-Math.pow((s - 0.72) / 0.14, 2));
    o[0] = 0.04 + ring * 1.3 + 0.4 * (1 - s);
    o[1] = 0.04 + ring * 0.95 + 0.3 * (1 - s);
    o[2] = 0.06 + ring * 0.8 + 0.3 * (1 - s);
    return 1;
  }
  // cartridge + stylus dropping to the groove
  segDist(u, v, HX, HY + 0.004, NX, NY, seg);
  if (seg[0] < mix(0.012, 0.0025, seg[1])) {
    o[0] = 0.12 + seg[1] * 2.0;
    o[1] = 0.1 + seg[1] * 2.6;
    o[2] = 0.14 + seg[1] * 3.0;
    return 1;
  }
  return 0;
}

function moon(u: number, v: number, o: number[]): number {
  const dx = (u - MX) / MR;
  const dy = (v - MY) / MR;
  const d2 = dx * dx + dy * dy;
  if (d2 >= 1) return 0;
  const nz = Math.sqrt(1 - d2);
  // lit by the disk (warm, from lower left, a bit toward us) and by the nebula (cool rim)
  const lx = -0.66;
  const ly = 0.62;
  const lz = 0.42;
  let dif = Math.max(0, dx * lx + dy * ly + nz * lz);
  const rim = Math.pow(1 - nz, 3) * Math.max(0, dx * 0.6 - dy * 0.75 + 0.2);
  // surface: mottling plus soft craters
  const n = fbm(dx * 3.2 + nz * 1.5 + 4, dy * 3.2 - nz + 2, 5, 0);
  let alb = 0.45 + 0.75 * n;
  const cr = fbm(dx * 7 + 11, dy * 7 + 5, 3, 0);
  alb *= 0.65 + 0.35 * smooth(0.38, 0.5, cr);
  dif *= alb;
  o[0] = 0.006 + dif * 1.5 + rim * 0.1;
  o[1] = 0.006 + dif * 0.72 + rim * 0.7;
  o[2] = 0.012 + dif * 0.36 + rim * 0.95;
  return 1;
}

// ---------------------------------------------------------------- the listener
// A small astronaut in headphones sits on the near rim of the record, legs over the edge,
// backlit by the disk. Local space: x right, y down, in units of AS, origin at the seat.
const AS = 0.07;
const SEAT_TH = 1.93;
const [AX, AY] = diskToScreen(0.845, SEAT_TH);

function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const h = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(wx - vx * h, wy - vy * h) - r;
}
function sdRBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// backlit suit: dark body, hot orange rim that is strongest on the side facing the hole
function suit(d: number, x: number, y: number, o: number[]) {
  const edge = smooth(-0.17, 0, d);
  const face = clamp(0.62 + 0.3 * x - 0.22 * (y + 1), 0.25, 1.25);
  const rim = edge * edge * face;
  const fill = clamp(0.5 - 0.18 * y, 0, 1);
  o[0] = 0.07 + 0.1 * fill + rim * 3.2;
  o[1] = 0.08 + 0.14 * fill + rim * 1.35;
  o[2] = 0.13 + 0.2 * fill + rim * 0.42;
}

function astronaut(u: number, v: number, o: number[]): number {
  const x = (u - AX) / AS;
  const y = (v - AY) / AS;
  if (x < -1.5 || x > 1.5 || y < -3.3 || y > 1.9) return 0;
  const m = Math.abs(x); // the figure is mirror-symmetric
  let hit = 0;
  let d: number;

  // life-support pack behind the shoulders
  d = sdRBox(x, y, 0, -1.12, 0.86, 0.7, 0.22);
  if (d < 0) {
    suit(d, x, y, o);
    o[0] *= 0.6;
    o[1] *= 0.6;
    o[2] *= 0.6;
    hit = 1;
  }
  // torso
  d = sdRBox(x, y, 0, -0.85, 0.58, 0.8, 0.3);
  if (d < 0) {
    suit(d, x, y, o);
    // chest control box
    if (sdRBox(x, y, 0, -0.92, 0.26, 0.17, 0.05) < 0) {
      o[0] += 0.02;
      o[1] += 0.3 * (x > 0.05 ? 1 : 0.25);
      o[2] += 0.42 * (x > 0.05 ? 1 : 0.25);
    }
    hit = 1;
  }
  // thighs come toward us, shins hang over the lip, boots at the bottom
  d = sdCapsule(m, y, 0.3, -0.12, 0.4, 0.3, 0.27);
  if (d < 0) {
    suit(d, x, y, o);
    hit = 1;
  }
  d = sdCapsule(m, y, 0.4, 0.3, 0.44, 1.2, 0.22);
  if (d < 0) {
    suit(d, x, y, o);
    hit = 1;
  }
  d = sdRBox(m, y, 0.46, 1.47, 0.29, 0.25, 0.14);
  if (d < 0) {
    suit(d, x, y, o);
    hit = 1;
  }
  // arms: shoulders down to hands planted on the record
  d = sdCapsule(m, y, 0.66, -1.32, 0.98, -0.1, 0.2);
  if (d < 0) {
    suit(d, x, y, o);
    hit = 1;
  }
  d = Math.hypot(m - 0.99, y + 0.04) - 0.24;
  if (d < 0) {
    suit(d, x, y, o);
    hit = 1;
  }
  // helmet
  d = Math.hypot(x, y + 2.22) - 0.76;
  if (d < 0) {
    suit(d, x, y, o);
    hit = 1;
    // visor: black glass with a teal reflection of the nebula and a sliver of the disk
    const vx = x / 0.54;
    const vy = (y + 2.17) / 0.43;
    const vd = vx * vx + vy * vy;
    if (vd < 1) {
      const glow = Math.exp(-Math.pow((vy + 0.35 + 0.25 * vx * vx) / 0.2, 2)) * (1 - vd);
      const band = Math.exp(-Math.pow((vy - 0.38) / 0.1, 2)) * (1 - vd) * smooth(-0.9, 0.3, vx);
      o[0] = 0.004 + glow * 0.15 + band * 2.6;
      o[1] = 0.008 + glow * 1.1 + band * 1.0;
      o[2] = 0.02 + glow * 1.5 + band * 0.25;
      // thin bright bezel
      const bz = smooth(0.8, 1.0, vd);
      o[0] += bz * 0.5;
      o[1] += bz * 0.35;
      o[2] += bz * 0.3;
    }
  }
  // headphones: band over the helmet, glowing cups on its sides
  const hr = Math.hypot(x, y + 2.22);
  if (y < -2.3 && Math.abs(hr - 0.84) < 0.075) {
    o[0] = 0.05;
    o[1] = 0.5;
    o[2] = 0.65;
    hit = 1;
  }
  d = sdRBox(m, y, 0.84, -2.2, 0.17, 0.33, 0.13);
  if (d < 0) {
    const core = smooth(-0.16, -0.02, d);
    o[0] = 0.1 + 0.5 * (1 - core);
    o[1] = 0.9 + 1.4 * (1 - core);
    o[2] = 1.2 + 1.6 * (1 - core);
    hit = 1;
  }
  return hit;
}

// ---------------------------------------------------------------- one sample
const dcol = [0, 0, 0];
const tcol = [0, 0, 0];
let holeSeen = 0; // set when the sample shows the bare shadow of the hole
function shade(u: number, v: number, o: number[]) {
  holeSeen = 0;
  background(u, v, o);
  heroStars(u, v, o);

  // rotate into the record's frame and un-squash
  const px = u - CX;
  const py = v - CY;
  const rx = px * COSR + py * SINR;
  const ry = -px * SINR + py * COSR;
  const X = rx;
  const Y = ry / TILT;
  const r = Math.hypot(X, Y);
  const onDisk = r >= RIN && r <= ROUT;
  const d = Math.hypot(px, py);

  // the moon sits behind everything else
  if (moon(u, v, tcol)) {
    o[0] = tcol[0];
    o[1] = tcol[1];
    o[2] = tcol[2];
  }

  // far half of the record
  if (onDisk && Y < 0) {
    disk(X, Y, dcol);
    o[0] = dcol[0];
    o[1] = dcol[1];
    o[2] = dcol[2];
  }

  // the hole itself, and the light bent around it
  if (d < RS) {
    o[0] = 0;
    o[1] = 0;
    o[2] = 0;
    holeSeen = 1;
  } else if (d < RS + 0.3) {
    const e = d - RS;
    const top = 0.5 + 0.5 * (-py / d); // strongest above the hole
    const w = 0.25 + 0.75 * top * top;
    const rings = 0.55 + 0.45 * hash2(Math.floor(d * 300), 3);
    const halo = Math.exp(-e / mix(0.022, 0.05, top)) * 3.0 * w * rings;
    const photon = 7 * Math.exp(-Math.pow((e - 0.0045) / 0.0034, 2)) * (0.45 + 0.55 * w);
    // the far side of the record, bent up and over the hole as a grooved arc
    const arc = 2.6 * top * top * top * (1 - smooth(0.04, 0.062, e)) * rings;
    o[0] += (halo + arc) * 1.0 + photon;
    o[1] += (halo + arc) * 0.5 + photon * 0.8;
    o[2] += (halo + arc) * 0.14 + photon * 0.5;
  }

  // thickness of the record on the near side
  if (Y > 0) {
    const Y2 = (ry - 0.016) / TILT;
    const r2 = Math.hypot(X, Y2);
    if (r2 <= ROUT && r > ROUT) {
      const side = 0.5 + 0.5 * (X / ROUT);
      o[0] = 0.05 + 0.25 * (1 - side);
      o[1] = 0.012 + 0.06 * (1 - side) + 0.05 * side;
      o[2] = 0.03 + 0.08 * side;
    }
  }

  // near half of the record, in front of the hole
  if (onDisk && Y >= 0) {
    disk(X, Y, dcol);
    // soft shadow the tonearm casts on the record
    segDist(u - 0.012, v - 0.03, GX, GY, HX, HY, seg);
    const shd = 1 - 0.65 * (1 - smooth(0.008, 0.028, seg[0])) * smooth(0.5, 0.75, seg[1]);
    o[0] = dcol[0] * shd;
    o[1] = dcol[1] * shd;
    o[2] = dcol[2] * shd;
    holeSeen = 0;
  }

  if (astronaut(u, v, tcol)) {
    o[0] = tcol[0];
    o[1] = tcol[1];
    o[2] = tcol[2];
  }

  if (tonearm(u, v, tcol)) {
    o[0] = tcol[0];
    o[1] = tcol[1];
    o[2] = tcol[2];
    holeSeen = 0;
  }

  // the spark where the stylus meets the groove
  const sx = u - NX;
  const sy = v - NY;
  const sd2 = sx * sx + sy * sy;
  const spark = 14 * Math.exp(-sd2 / 0.00006) + 0.9 * Math.exp(-Math.sqrt(sd2) / 0.03);
  const flare = 2.5 * Math.exp(-Math.abs(sy) / 0.0022) * Math.exp(-Math.abs(sx) / 0.07);
  o[0] += (spark + flare) * 0.45;
  o[1] += (spark + flare) * 0.95;
  o[2] += (spark + flare) * 1.1;
}

// ---------------------------------------------------------------- render
const hdr = new Float32Array(W * H * 3);
const hole = new Float32Array(W * H); // how much of each pixel is the hole's shadow: bloom stays out of it
{
  const inv = 1 / (SS * SS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < SS; j++) {
        const v = ((y + (j + 0.5) / SS) / H) * 2 - 1;
        for (let i = 0; i < SS; i++) {
          const u = ((x + (i + 0.5) / SS) / W) * 2 - 1;
          shade(u, v, out3);
          hole[y * W + x] += holeSeen * inv;
          r += out3[0];
          g += out3[1];
          b += out3[2];
        }
      }
      const k = (y * W + x) * 3;
      hdr[k] = r * inv;
      hdr[k + 1] = g * inv;
      hdr[k + 2] = b * inv;
    }
  }
}

// ---------------------------------------------------------------- bloom
// downsample 4x, blur at three radii, add back
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
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s += hdr[((y * 4 + j) * W + x * 4 + i) * 3 + c];
      small[(y * BW + x) * 3 + c] = s / 16;
    }
const b1 = blur(small, 1.6);
const b2 = blur(small, 6);
const b3 = blur(small, 20);
function sampleBloom(buf: Float32Array, x: number, y: number, c: number): number {
  const fx = clamp((x + 0.5) / 4 - 0.5, 0, BW - 1);
  const fy = clamp((y + 0.5) / 4 - 0.5, 0, BH - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, BW - 1);
  const y1 = Math.min(y0 + 1, BH - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  return mix(
    mix(buf[(y0 * BW + x0) * 3 + c], buf[(y0 * BW + x1) * 3 + c], tx),
    mix(buf[(y1 * BW + x0) * 3 + c], buf[(y1 * BW + x1) * 3 + c], tx),
    ty,
  );
}

// ---------------------------------------------------------------- tone map + PNG
const aces = (x: number) => clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1);
const raw = Buffer.alloc(H * (1 + W * 3));
const rowBuf = new Uint8Array(W * 3);
const prev = new Uint8Array(W * 3);
const cand = [new Uint8Array(W * 3), new Uint8Array(W * 3), new Uint8Array(W * 3), new Uint8Array(W * 3), new Uint8Array(W * 3)];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W - 0.5;
    const v = (y + 0.5) / H - 0.5;
    const vig = 1 - 0.55 * smooth(0.45, 0.95, Math.hypot(u, v) * 1.25);
    for (let c = 0; c < 3; c++) {
      let val = hdr[(y * W + x) * 3 + c];
      const keep = 1 - 0.94 * hole[y * W + x];
      val += keep * (0.1 * sampleBloom(b1, x, y, c) + 0.1 * sampleBloom(b2, x, y, c) + 0.09 * sampleBloom(b3, x, y, c));
      val = aces(val * vig * 1.15);
      rowBuf[x * 3 + c] = Math.round(Math.pow(val, 1 / 2.2) * 255);
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
