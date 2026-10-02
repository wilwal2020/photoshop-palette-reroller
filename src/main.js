"use strict";

const VERSION = "1.8.0";

const photoshop = require("photoshop");
const app = photoshop.app;
const { batchPlay } = photoshop.action;
const { executeAsModal } = photoshop.core;

/* ---------------- config ---------------- */
const HARMONIES = ["Random", "Analogous", "Complementary", "Split", "Triadic", "Tetradic", "Mono"];
const STYLES = ["Default", "Vibrant", "Muted", "Pastel", "Deep"];

// Per-style targets in OKLCH (see "OKLab / OKLCH" below). L is perceived
// lightness, 0 = black .. 1 = white; a roll spreads its colours evenly across
// lMin..lMax. Chroma is a share (rcMin..rcMax) of the most the sRGB gamut
// allows at that lightness and hue, capped at cMax, so a style looks equally
// vivid in every hue. `drab` is how hard a roll avoids giving a yellow-ish hue
// a dark slot, where it can only come out olive or khaki.
function styleParams(style) {
  switch (style) {
    case "Vibrant": return { lMin: 0.52, lMax: 0.85, rcMin: 0.80, rcMax: 0.96, cMax: 0.33,  drab: 0.8 };
    case "Muted":   return { lMin: 0.42, lMax: 0.84, rcMin: 0.30, rcMax: 0.55, cMax: 0.075, drab: 0.3 };
    case "Pastel":  return { lMin: 0.79, lMax: 0.92, rcMin: 0.60, rcMax: 0.92, cMax: 0.11,  drab: 0.3 };
    case "Deep":    return { lMin: 0.25, lMax: 0.52, rcMin: 0.65, rcMax: 0.92, cMax: 0.22,  drab: 0.4 };
    default:        return { lMin: 0.40, lMax: 0.90, rcMin: 0.40, rcMax: 0.85, cMax: 0.22,  drab: 0.6 };
  }
}

/* ---------------- state ---------------- */
const state = {
  enabledHarmonies: ["Analogous", "Complementary", "Split", "Triadic", "Tetradic", "Mono"],
  style: "Default",
  placeBySize: false,  // pick which colour goes where from each layer's visible size
  docID: null,      // the document the working set below belongs to
  swatches: [],     // [{ r, g, b, hex, locked, group }] aligned 1:1 with layerIDs
  layerIDs: [],     // the working set of fill-layer IDs the panel controls
  linkArm: null,    // index of the swatch currently armed for linking, or null
  nextGroup: 0      // counter for minting fresh (solo) group ids
};

/* ---------------- colour math ---------------- */
function rand(a, b) { return a + Math.random() * (b - a); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function norm360(h) { return ((h % 360) + 360) % 360; }

function toHex(r, g, b) {
  const h = n => ("0" + n.toString(16)).slice(-2).toUpperCase();
  return "#" + h(r) + h(g) + h(b);
}

// shortest angular distance between two hues, 0..180
function circDist(a, b) {
  const d = norm360(a - b);
  return d > 180 ? 360 - d : d;
}

// signed shortest rotation from hue `from` to hue `to`, in (-180, 180]
function hueDelta(from, to) {
  const d = norm360(to - from);
  return d > 180 ? d - 360 : d;
}

function circMean(hues) {
  let x = 0, y = 0;
  for (const h of hues) { x += Math.cos(h * Math.PI / 180); y += Math.sin(h * Math.PI / 180); }
  return norm360(Math.atan2(y, x) * 180 / Math.PI);
}

/* ---------------- OKLab / OKLCH ---------------- */
// Palettes are built in OKLCH (Björn Ottosson's perceptual colour space):
// equal steps in L look like equal steps in lightness for every hue, and hue
// angles are spread evenly around the wheel. HSB is neither — a yellow and a
// blue with the same "brightness" look nowhere near equally light, and a
// quarter of the HSB wheel is shades of green.

function srgbToLinear(v) {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearToSrgb(v) {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  };
}

function rgbToOklch(r, g, b) {
  const o = rgbToOklab(r, g, b);
  return { L: o.L, C: Math.sqrt(o.a * o.a + o.b * o.b), h: norm360(Math.atan2(o.b, o.a) * 180 / Math.PI) };
}

// OKLCH -> linear-light sRGB (components outside 0..1 mean out of gamut)
function oklchToLinear(L, C, h) {
  const hr = h * Math.PI / 180, a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ];
}

function oklchToRgb(L, C, h) {
  return oklchToLinear(L, C, h).map(v => Math.round(clamp(linearToSrgb(clamp(v, 0, 1)), 0, 1) * 255));
}

function inGamut(L, C, h) {
  const v = oklchToLinear(L, C, h), E = 1e-5;
  return v[0] >= -E && v[0] <= 1 + E && v[1] >= -E && v[1] <= 1 + E && v[2] >= -E && v[2] <= 1 + E;
}

// The most chroma sRGB can show at this lightness and hue.
function maxChroma(L, h) {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(L, mid, h)) lo = mid; else hi = mid;
  }
  return lo;
}

// perceptual distance between two colours: Euclidean distance in OKLab
function deltaE(p, q) {
  const dL = p.L - q.L, da = p.a - q.a, db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

function makeColor(r, g, b) {
  return { r: r, g: g, b: b, hex: toHex(r, g, b), lab: rgbToOklab(r, g, b) };
}

/* ---------------- palette generation ---------------- */
const NEUTRAL_C = 0.025;      // below this chroma a colour is effectively grey; its hue means nothing
const ATTEMPTS = 12;          // candidate palettes rolled per Generate
const ATTEMPTS_SIZED = 24;    // more when placing by size, which has more to satisfy
const SEP_TARGET = 0.09;      // OKLab distance at which two swatches read as clearly different
const CONTRAST_TARGET = 0.26; // how far a layer should stand off from the layer it sits on (see standOff)

function pickHarmony() {
  const pool = state.enabledHarmonies.length ? state.enabledHarmonies : HARMONIES.slice(1);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Hue families of each harmony as offsets from the base hue. Some harmonies
// come in more than one shape; one is picked per roll for variety.
function harmonyFamilies(mode) {
  switch (mode) {
    case "Complementary": return [0, 180];
    case "Split": { const d = rand(24, 40); return [0, 180 - d, 180 + d]; }
    case "Triadic": return [0, 120, 240];
    case "Tetradic": {
      if (Math.random() < 0.5) return [0, 90, 180, 270];   // square
      const s = Math.random() < 0.5 ? 60 : -60;             // rectangle: two complementary pairs
      return [0, s, 180, 180 + s];
    }
    default: return [0];
  }
}

// Rotate the harmony to fit the locked colours as closely as possible: each
// locked hue is tried on each family, and the rotation with the least total
// mismatch wins. Ties are broken at random, so a single locked colour can sit
// on any arm of a split or tetrad rather than always being the key colour.
function fitBase(lockedHues, fams) {
  if (!lockedHues.length) return Math.random() * 360;
  let best = [], bestCost = Infinity;
  for (const h of lockedHues) {
    for (const f of fams) {
      const base = h - f;
      let cost = 0;
      for (const h2 of lockedHues) {
        let m = Infinity;
        for (const f2 of fams) m = Math.min(m, circDist(h2, base + f2));
        cost += m;
      }
      if (cost < bestCost - 0.5) { bestCost = cost; best = [base]; }
      else if (cost <= bestCost + 0.5) best.push(base);
    }
  }
  return best[Math.floor(Math.random() * best.length)];
}

// Light tones lean toward warm yellow and dark tones toward violet, the way
// lit surfaces and shadows do. On top of that, darkened hues near olive are
// pushed out of it — yellows toward amber and bronze, yellow-greens toward
// green — since at its own hue a dark yellow can only be muddy olive.
const WARM_HUE = 95, COOL_HUE = 300, OLIVE_HUE = 112;
function shiftHue(h, L) {
  const t = clamp((L - 0.62) / 0.3, -1, 1);
  if (t !== 0) {
    const d = hueDelta(h, t > 0 ? WARM_HUE : COOL_HUE);
    h += Math.sign(d) * Math.min(Math.abs(d), Math.abs(t) * 10);
  }
  const olive = Math.max(0, 1 - circDist(h, OLIVE_HUE) / 38);
  const dark = clamp((0.78 - L) / 0.4, 0, 1);
  if (olive > 0 && dark > 0) h += (hueDelta(OLIVE_HUE, h) > 0 ? 1 : -1) * 30 * olive * dark;
  return h;
}

// Yellows only exist as light colours; darkened, a yellow turns olive or
// khaki. Scores how far a hue/lightness pairing falls into that.
function drabness(h, L) {
  const yellowish = Math.max(0, 1 - circDist(h, 100) / 45);
  return yellowish * clamp((0.7 - L) / 0.35, 0, 1);
}

// Everything about a roll that stays fixed across its candidates: the
// harmony's shape and rotation, the lightness band, and the locked colours.
// `stacked` (placing by size, with layers sitting on each other) asks for
// enough lightness range that stacked layers can stand apart.
function planPalette(groups, mode, sp, stacked) {
  const n = groups.length;
  const plan = {
    mode: mode, fams: null, base: 0, span: 0, nHue: n,
    lockedColor: new Array(n).fill(null),
    lockedHues: [],       // hues of locked colours that have one (not greys)
    lockedFamilies: [],   // harmony family each of those hues sits in
    lockedL: [],          // lightness of locked colours that use up a lightness slot
    lMin: sp.lMin, lMax: sp.lMax, lSlots: n
  };

  const locked = [];
  for (let i = 0; i < n; i++) {
    if (!groups[i].locked) continue;
    const c = groups[i].color;
    plan.lockedColor[i] = makeColor(c.r, c.g, c.b);
    locked.push(rgbToOklch(c.r, c.g, c.b));
  }
  // A locked grey/white/black has no real hue, so it neither steers the
  // harmony nor takes up one of its hue slots.
  for (const c of locked) {
    if (c.C >= NEUTRAL_C) plan.lockedHues.push(c.h);
    else plan.nHue--;
  }

  if (mode === "Analogous" || mode === "Mono") {
    plan.base = plan.lockedHues.length ? circMean(plan.lockedHues) : Math.random() * 360;
    if (mode === "Analogous") {
      plan.span = plan.nHue <= 3 ? rand(40, 80) : rand(60, 105);
      let spread = 0;
      for (const h of plan.lockedHues) spread = Math.max(spread, circDist(h, plan.base));
      plan.span = Math.max(plan.span, 2 * spread + 12);   // wide enough to hold every locked hue
    }
  } else {
    plan.fams = harmonyFamilies(mode);
    plan.base = fitBase(plan.lockedHues, plan.fams);
    plan.lockedFamilies = plan.lockedHues.map(h => {
      let best = 0;
      for (let f = 1; f < plan.fams.length; f++) {
        if (circDist(h, plan.base + plan.fams[f]) < circDist(h, plan.base + plan.fams[best])) best = f;
      }
      return best;
    });
  }

  // Harmonies with little hue contrast need more lightness contrast to keep
  // their swatches apart, so widen the band for them when it's too narrow.
  const perStep = mode === "Mono" ? 0.075 : (mode === "Analogous" ? 0.05 : 0.035);
  const need = Math.min(Math.max(perStep * (n - 1), stacked ? 0.24 : 0), 0.62);
  const width = plan.lMax - plan.lMin;
  if (width < need) {
    const grow = need - width, mid = (plan.lMin + plan.lMax) / 2;
    if (mid > 0.62) plan.lMin -= grow;            // light styles grow darker
    else if (mid < 0.45) plan.lMax += grow;       // dark styles grow lighter
    else { plan.lMin -= grow / 2; plan.lMax += grow / 2; }
    plan.lMin = Math.max(plan.lMin, 0.16);
    plan.lMax = Math.min(plan.lMax, 0.97);
  }

  // A locked colour far outside the band (a black in a pastel palette, say)
  // doesn't use up one of the band's lightness slots.
  for (const c of locked) {
    if (c.L < plan.lMin - 0.08 || c.L > plan.lMax + 0.08) plan.lSlots--;
    else plan.lockedL.push(c.L);
  }
  return plan;
}

// Hue slots for one candidate. Family-based harmonies deal slots out evenly
// across their families (families holding a locked colour first), and fan
// members of the same family over a small arc: related, but distinct.
function buildHueSlots(plan) {
  const n = plan.nHue, slots = [];
  if (n <= 0) return slots;
  if (plan.mode === "Analogous") {
    const step = n > 1 ? plan.span / (n - 1) : 0;
    const start = n > 1 ? plan.base - plan.span / 2 : plan.base;
    for (let i = 0; i < n; i++) slots.push(start + i * step + rand(-4, 4));
  } else if (plan.mode === "Mono") {
    for (let i = 0; i < n; i++) slots.push(plan.base + rand(-5, 5));
  } else {
    const F = plan.fams.length;
    const count = new Array(F).fill(0);
    for (const f of plan.lockedFamilies) count[f]++;
    for (let k = plan.lockedFamilies.length; k < n; k++) {
      let min = Infinity, pool = [];
      for (let f = 0; f < F; f++) {
        if (count[f] < min) { min = count[f]; pool = [f]; }
        else if (count[f] === min) pool.push(f);
      }
      count[pool[Math.floor(Math.random() * pool.length)]]++;
    }
    for (let f = 0; f < F; f++) {
      const k = count[f], center = plan.base + plan.fams[f];
      if (k === 1) slots.push(center + rand(-6, 6));
      else if (k > 1) {
        const w = Math.min(rand(10, 18) * (k - 1), 40);
        for (let i = 0; i < k; i++) slots.push(center - w / 2 + (i * w) / (k - 1) + rand(-2, 2));
      }
    }
  }
  return slots;
}

// Lightness slots spread evenly across the band, with a little jitter.
function buildLightnessSlots(count, lMin, lMax) {
  if (count <= 0) return [];
  if (count === 1) return [rand(lMin, lMax)];
  const step = (lMax - lMin) / (count - 1), out = [];
  for (let i = 0; i < count; i++) out.push(clamp(lMin + i * step + rand(-0.2, 0.2) * step, 0.08, 0.97));
  return out;
}

// Pair each locked value with its nearest free slot, closest pairs first, and
// return the slots left over for the unlocked colours.
function claimNearest(slots, values, dist) {
  const free = slots.slice(), vals = values.slice();
  while (vals.length && free.length) {
    let bi = 0, bj = 0, bd = Infinity;
    for (let i = 0; i < vals.length; i++) {
      for (let j = 0; j < free.length; j++) {
        const d = dist(vals[i], free[j]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    vals.splice(bi, 1);
    free.splice(bj, 1);
  }
  return free;
}

// Roll up per-layer size measurements into link groups. Each group gets its
// total visual weight, the group it mostly sits on (`backdrop`, -1 for none),
// and `rel`: its size on a log scale from 0 (smallest) to 1 (largest), or
// null when the sizes are too alike (under 2x apart) to say anything.
function groupSizes(groups, layerSizes) {
  const gOf = [];
  groups.forEach((g, gi) => g.members.forEach(m => { gOf[m] = gi; }));
  const info = groups.map(() => ({ weight: 0, under: new Map(), backdrop: -1, rel: null }));
  layerSizes.forEach((s, li) => {
    const gi = gOf[li];
    if (!s || gi === undefined) return;
    info[gi].weight += s.weight;
    for (const [lj, amount] of s.under) {
      const gj = lj < 0 ? -1 : gOf[lj];
      if (gj === undefined || gj === gi) continue;   // sitting on its own linked layers doesn't count
      info[gi].under.set(gj, (info[gi].under.get(gj) || 0) + amount);
    }
  });
  for (const x of info) {
    let best = 0;
    for (const [gj, amount] of x.under) if (amount > best) { best = amount; x.backdrop = gj; }
  }
  const logs = info.filter(x => x.weight > 1e-5).map(x => Math.log(x.weight));
  const lo = Math.min(...logs), hi = Math.max(...logs);
  if (logs.length >= 2 && hi - lo >= Math.log(2)) {
    for (const x of info) if (x.weight > 1e-5) x.rel = (Math.log(x.weight) - lo) / (hi - lo);
  }
  return info;
}

// Contrast a group should have against what it sits on. Small areas need
// more to read (colour differences are harder to see on small patches), so
// the target grows to 1.6x for the smallest details.
function contrastTarget(g) {
  return CONTRAST_TARGET * (1 + 0.6 * (1 - (g.rel === null ? 0.5 : g.rel)));
}

// How many layers deep a group sits (0: on nothing of ours).
function stackDepth(size, gi) {
  let d = 0;
  for (let g = size[gi].backdrop; g >= 0 && d < size.length; g = size[g].backdrop) d++;
  return d;
}

// Lightness-only estimate of contrastShortfall, for placing lightness before
// hues and chroma are chosen.
function lightnessShortfall(L, size) {
  let sum = 0;
  size.forEach((g, gi) => {
    if (g.backdrop < 0 || L[gi] === undefined || L[g.backdrop] === undefined) return;
    const w = Math.min(1, g.weight / 0.002);
    sum += w * Math.max(0, 1 - 1.6 * Math.abs(L[gi] - L[g.backdrop]) / contrastTarget(g));
  });
  return sum;
}

// Hand the free lightness slots to the unlocked groups. Without size info
// that's a plain shuffle. Placing by size, the biggest group takes the
// lightest or darkest slot as a calm ground; then each group, after whatever
// it sits on (and small details before bigger shapes beside them), takes the
// slot that stands out most against its backdrop — sometimes the runner-up,
// for variety. A few swap passes then fix anything the greedy order missed,
// and small details that still can't stand out inside the style's lightness
// band may step up to ACCENT_REACH outside it, the way a tiny bright accent
// works in a dark design (the big areas keep the style's look).
const ACCENT_REACH = 0.15;
function assignLightness(free, slots, L, size, band) {
  slots = slots.slice();
  if (!size) {
    shuffle(slots);
    free.forEach((gi, k) => { L[gi] = slots[k]; });
    return;
  }
  const dominant = free.filter(gi => size[gi].rel === 1);
  const rest = free.filter(gi => size[gi].rel !== 1);
  const depth = new Map(rest.map(gi => [gi, stackDepth(size, gi)]));
  const noisy = new Map(rest.map(gi => [gi, size[gi].weight * rand(0.8, 1.25)]));
  rest.sort((a, b) => depth.get(a) - depth.get(b) || noisy.get(a) - noisy.get(b));
  for (const gi of dominant.concat(rest)) {
    const g = size[gi];
    let pick;
    if (g.rel === 1) {
      const darkest = Math.random() < 0.5;
      pick = 0;
      for (let i = 1; i < slots.length; i++) if (darkest ? slots[i] < slots[pick] : slots[i] > slots[pick]) pick = i;
    } else if (g.backdrop >= 0 && L[g.backdrop] !== undefined) {
      const ref = L[g.backdrop];
      const ranked = slots.map((v, i) => i).sort((a, b) => Math.abs(slots[b] - ref) - Math.abs(slots[a] - ref));
      pick = ranked[ranked.length > 1 && Math.random() < 0.3 ? 1 : 0];
    } else {
      pick = Math.floor(Math.random() * slots.length);
    }
    L[gi] = slots[pick];
    slots.splice(pick, 1);
  }
  let cost = lightnessShortfall(L, size);
  for (let pass = 0; pass < 4 && cost > 0; pass++) {
    let improved = false;
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        const a = rest[i], b = rest[j];
        [L[a], L[b]] = [L[b], L[a]];
        const c = lightnessShortfall(L, size);
        if (c < cost - 1e-9) { cost = c; improved = true; }
        else [L[a], L[b]] = [L[b], L[a]];
      }
    }
    if (!improved) break;
  }
  if (!band) return;
  const lo = Math.max(0.12, band.lMin - ACCENT_REACH), hi = Math.min(0.96, band.lMax + ACCENT_REACH);
  for (const gi of rest) {
    const g = size[gi];
    if (g.rel === null || g.rel > 0.35 || g.backdrop < 0 || L[g.backdrop] === undefined) continue;
    const ref = L[g.backdrop], need = contrastTarget(g) / 1.6;
    if (Math.abs(L[gi] - ref) >= need) continue;
    // step out on whichever side gets more contrast, preferring its own side
    const up = Math.min(hi, ref + need), down = Math.max(lo, ref - need);
    const own = L[gi] >= ref ? up : down, other = L[gi] >= ref ? down : up;
    const best = Math.abs(own - ref) >= Math.abs(other - ref) - 0.02 ? own : other;
    if (Math.abs(best - ref) > Math.abs(L[gi] - ref)) L[gi] = best;
  }
}

// Share of the gamut's chroma a colour uses. Placing by size, big areas lean
// calm and small ones vivid (rel: 0 = smallest group, 1 = largest).
function chromaShare(sp, rel) {
  if (rel === null || rel === undefined) return rand(sp.rcMin, sp.rcMax);
  const u = rand(0.45 * (1 - rel), 1 - 0.45 * rel);
  return (sp.rcMin + (sp.rcMax - sp.rcMin) * u) * (1 - 0.45 * Math.pow(rel, 1.5));
}

// How clearly one colour stands off another it sits on. Weighted toward
// lightness, since lightness contrast is what makes shapes read.
function standOff(p, q) {
  const dL = (p.L - q.L) * 1.6, da = p.a - q.a, db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

// Average shortfall (0 = every layer stands off what it sits on) across
// layers with a backdrop; nearly invisible layers count for less.
function contrastShortfall(colors, groups, size) {
  let sum = 0, wsum = 0;
  size.forEach((g, gi) => {
    const b = g.backdrop;
    if (b < 0 || (groups[gi].locked && groups[b].locked)) return;
    const w = Math.min(1, g.weight / 0.002);
    if (w <= 0) return;
    sum += w * Math.max(0, 1 - standOff(colors[gi].lab, colors[b].lab) / contrastTarget(g));
    wsum += w;
  });
  return wsum ? sum / wsum : 0;
}

// One candidate palette: locked colours claim the hue and lightness slots
// nearest their own, and the leftover slots go to the unlocked colours —
// hues at random, lightness at random or (placing by size) by role.
function buildCandidate(groups, plan, sp, size) {
  const n = groups.length;
  const hues = shuffle(claimNearest(buildHueSlots(plan), plan.lockedHues, circDist));
  const lights = claimNearest(buildLightnessSlots(plan.lSlots, plan.lMin, plan.lMax),
                              plan.lockedL, (a, b) => Math.abs(a - b));
  const L = new Array(n), free = [];
  for (let gi = 0; gi < n; gi++) {
    if (groups[gi].locked) L[gi] = plan.lockedColor[gi].lab.L;
    else free.push(gi);
  }
  assignLightness(free, lights, L, size, plan);

  const colors = new Array(n);
  let drab = 0;
  for (let gi = 0; gi < n; gi++) {
    if (groups[gi].locked) { colors[gi] = plan.lockedColor[gi]; continue; }
    const slotHue = hues.pop();
    drab += drabness(slotHue, L[gi]);
    const h = norm360(shiftHue(slotHue, L[gi]));
    const C = Math.min(chromaShare(sp, size ? size[gi].rel : null) * maxChroma(L[gi], h), sp.cMax);
    const rgb = oklchToRgb(L[gi], C, h);
    colors[gi] = makeColor(rgb[0], rgb[1], rgb[2]);
  }
  return { colors: colors, drab: drab };
}

// How far apart the two most similar colours are, over pairs that include at
// least one colour this roll is free to change.
function minSeparation(colors, groups) {
  let min = Infinity;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      if (groups[i].locked && groups[j].locked) continue;
      min = Math.min(min, deltaE(colors[i].lab, colors[j].lab));
    }
  }
  return min;
}

// Collapse swatches into link-groups, in order of first appearance.
// A group is locked if any of its members is locked; its current colour is
// taken from the first member.
function computeGroups() {
  const order = [];
  const map = {};
  for (let i = 0; i < state.swatches.length; i++) {
    const g = state.swatches[i].group;
    if (!(g in map)) { map[g] = { key: g, members: [], locked: false }; order.push(map[g]); }
    map[g].members.push(i);
    if (state.swatches[i].locked) map[g].locked = true;
  }
  order.forEach(grp => {
    const s = state.swatches[grp.members[0]];
    grp.color = { r: s.r, g: s.g, b: s.b, hex: s.hex };
  });
  return order;
}

// Generate one colour per unlocked group and write it to every member layer.
// Rolls several candidates and keeps the best: swatches clearly apart, no
// yellows forced dark, and — given `layerSizes` (from measureLayerSizes,
// aligned with state.layerIDs) — every layer standing off what it sits on.
// Returns the harmony used, or null when everything is locked.
function generateGroupedPalette(layerSizes) {
  const groups = computeGroups();
  if (groups.every(g => g.locked)) return null;
  const mode = pickHarmony();
  const sp = styleParams(state.style);
  const size = layerSizes ? groupSizes(groups, layerSizes) : null;
  const plan = planPalette(groups, mode, sp, !!size && size.some(g => g.backdrop >= 0));

  let best = null, bestScore = -Infinity;
  const attempts = size ? ATTEMPTS_SIZED : ATTEMPTS;
  for (let a = 0; a < attempts; a++) {
    const cand = buildCandidate(groups, plan, sp, size);
    let score = Math.min(minSeparation(cand.colors, groups) / SEP_TARGET, 1) - sp.drab * cand.drab;
    if (size) score -= contrastShortfall(cand.colors, groups, size);
    if (score > bestScore) { bestScore = score; best = cand; }
    if (score >= 1) break;   // nothing left to improve: good enough
  }

  for (let gi = 0; gi < groups.length; gi++) {
    if (groups[gi].locked) continue;   // locked layers keep exactly the colour they have
    const c = best.colors[gi];
    for (const idx of groups[gi].members) {
      const s = state.swatches[idx];
      s.r = c.r; s.g = c.g; s.b = c.b; s.hex = c.hex;
    }
  }
  return mode;
}

/* ---------------- Photoshop I/O ---------------- */

function activeDocID() { return app.documents.length ? app.activeDocument.id : null; }

// Working sets of the documents that aren't active, so switching documents
// and back keeps each one's swatches, locks and links.
const docSets = new Map();

// Point `state` at the active document's working set. Layer ids are only
// unique within a document, so a set captured in one document must never be
// applied in another — it would recolour whatever layers share those ids.
// Returns true when it switched (callers re-render).
function syncDocContext() {
  const cur = activeDocID();
  if (cur === state.docID) return false;
  if (state.docID !== null) {
    docSets.set(state.docID, { layerIDs: state.layerIDs, swatches: state.swatches, nextGroup: state.nextGroup });
  }
  const open = new Set();
  for (let i = 0; i < app.documents.length; i++) open.add(app.documents[i].id);
  for (const id of Array.from(docSets.keys())) if (!open.has(id)) docSets.delete(id);
  const saved = cur !== null ? docSets.get(cur) : undefined;
  if (saved) docSets.delete(cur);
  state.docID = cur;
  state.layerIDs = saved ? saved.layerIDs : [];
  state.swatches = saved ? saved.swatches : [];
  state.nextGroup = saved ? saved.nextGroup : 0;
  state.linkArm = null;
  return true;
}

// Every layer id in the active document (recursing into groups).
function collectAllLayerIDs() {
  const out = new Set();
  if (!app.documents.length) return out;
  const walk = (layers) => {
    for (const l of layers) {
      out.add(l.id);
      if (l.layers && l.layers.length) walk(l.layers);
    }
  };
  walk(app.activeDocument.layers);
  return out;
}

function isSolidFill(desc) {
  const adj = desc && desc.adjustment;
  return !!(adj && adj.length && adj[0]._obj === "solidColorLayer");
}

// Drop layers from the working set that were deleted or are no longer solid
// colour fills (rasterized, converted to a smart object, ...) — one such layer
// would otherwise make every apply fail. Swatches stay aligned; locks and
// link groups on the surviving layers are kept. Returns how many were dropped.
async function pruneInvalidLayers() {
  if (!state.layerIDs.length) return 0;
  const existing = collectAllLayerIDs();
  const keep = state.layerIDs.map(id => existing.has(id));
  const live = state.layerIDs.filter((id, i) => keep[i]);
  if (live.length) {
    try {
      const descs = await batchPlay(live.map(id => ({ _obj: "get", _target: [{ _ref: "layer", _id: id }] })), {});
      let k = 0;
      for (let i = 0; i < keep.length; i++) if (keep[i] && !isSolidFill(descs[k++])) keep[i] = false;
    } catch (e) { /* couldn't check layer kinds; the existence check still applies */ }
  }
  const dropped = keep.filter(k => !k).length;
  if (!dropped) return 0;
  state.layerIDs = state.layerIDs.filter((id, i) => keep[i]);
  state.swatches = state.swatches.filter((s, i) => keep[i]);
  state.linkArm = null;
  return dropped;
}

// Returns the IDs of selected layers whose content is a solid color fill.
async function getSolidFillLayerIDs() {
  if (!app.documents.length) return [];
  const layers = app.activeDocument.activeLayers;
  if (!layers.length) return [];
  const gets = layers.map(l => ({ _obj: "get", _target: [{ _ref: "layer", _id: l.id }] }));
  const descs = await batchPlay(gets, {});
  const ids = [];
  for (let i = 0; i < layers.length; i++) {
    if (isSolidFill(descs[i])) ids.push(layers[i].id);
  }
  return ids;
}

/* ---------------- layer sizes (Place by size) ---------------- */
// Measures how much of the image each layer in the working set really covers
// and what each one sits on, on a coarse grid over the document. A layer's
// shape is its content bounds, refined by its vector and user masks (read
// with the Imaging API, Photoshop 24.4+; bounds alone on older versions),
// limited to its clipping base, faded by its opacity, and hidden where layers
// above cover it.
const SIZE_GRID = 128;   // cells along the document's long side

function num(v) { return typeof v === "number" ? v : (v && typeof v._value === "number" ? v._value : NaN); }

// Every layer by id, with its stacking position (0 = topmost) and siblings.
function layerTree(doc) {
  const out = new Map();
  let z = 0;
  const walk = (coll) => {
    const sibs = [];
    for (let i = 0; i < coll.length; i++) sibs.push(coll[i]);
    sibs.forEach((l, i) => {
      out.set(l.id, { dom: l, z: z++, sibs: sibs, index: i });
      if (l.layers && l.layers.length) walk(l.layers);
    });
  };
  walk(doc.layers);
  return out;
}

function boundsIn(dom, grid) {
  const b = dom && (dom.boundsNoEffects || dom.bounds);
  if (!b) return null;
  const left = Math.max(0, Math.floor(num(b.left))), top = Math.max(0, Math.floor(num(b.top)));
  const right = Math.min(grid.docW, Math.ceil(num(b.right))), bottom = Math.min(grid.docH, Math.ceil(num(b.bottom)));
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

// Opacity that reaches the image: own opacity and fill, times every enclosing
// group's opacity; 0 if it or any enclosing group is hidden.
function effectiveAlpha(dom) {
  let a = 1;
  for (let l = dom, depth = 0; l && depth < 64; l = l.parent, depth++) {
    if (l.visible === false) return 0;
    const o = num(l.opacity);
    if (o >= 0) a *= o / 100;
  }
  const f = num(dom.fillOpacity);
  return f >= 0 ? a * f / 100 : a;
}

// The layer a clipped layer is clipped to: the nearest unclipped one below it.
function clippingBase(node) {
  if (!node.dom.isClippingMask) return null;
  for (let k = node.index + 1; k < node.sibs.length; k++) {
    if (!node.sibs[k].isClippingMask) return node.sibs[k];
  }
  return null;
}

// Fraction of each grid cell inside rectangle b.
function rectCoverage(grid, b) {
  const cov = new Float32Array(grid.W * grid.H);
  if (!b) return cov;
  const x0 = Math.floor(b.left / grid.cw), x1 = Math.min(grid.W - 1, Math.ceil(b.right / grid.cw) - 1);
  const y0 = Math.floor(b.top / grid.ch), y1 = Math.min(grid.H - 1, Math.ceil(b.bottom / grid.ch) - 1);
  for (let y = y0; y <= y1; y++) {
    const oy = Math.min(b.bottom, (y + 1) * grid.ch) - Math.max(b.top, y * grid.ch);
    for (let x = x0; x <= x1; x++) {
      const ox = Math.min(b.right, (x + 1) * grid.cw) - Math.max(b.left, x * grid.cw);
      if (ox > 0 && oy > 0) cov[y * grid.W + x] = (ox * oy) / (grid.cw * grid.ch);
    }
  }
  return cov;
}

// Multiply coverage by an image (mask or alpha values) that spans document
// rect `src`. Each cell takes the average of the image over its part of the
// layer bounds `b`. Photoshop may trim the image, so parts of `b` outside
// `src` take `img.outside`: shown (1) for masks, empty (0) for transparency.
function multiplyByImage(cov, grid, b, src, img) {
  const sw = src.right - src.left, sh = src.bottom - src.top;
  if (!(sw > 0 && sh > 0)) return;
  const sx = img.w / sw, sy = img.h / sh;
  for (let y = 0; y < grid.H; y++) {
    const cy0 = Math.max(b.top, y * grid.ch), cy1 = Math.min(b.bottom, (y + 1) * grid.ch);
    if (cy1 <= cy0) continue;
    for (let x = 0; x < grid.W; x++) {
      const i = y * grid.W + x;
      if (!cov[i]) continue;
      const cx0 = Math.max(b.left, x * grid.cw), cx1 = Math.min(b.right, (x + 1) * grid.cw);
      if (cx1 <= cx0) continue;
      const ix0 = Math.max(cx0, src.left), ix1 = Math.min(cx1, src.right);
      const iy0 = Math.max(cy0, src.top), iy1 = Math.min(cy1, src.bottom);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      const px0 = Math.min(img.w - 1, Math.floor((ix0 - src.left) * sx));
      const px1 = Math.max(px0, Math.min(img.w - 1, Math.ceil((ix1 - src.left) * sx) - 1));
      const py0 = Math.min(img.h - 1, Math.floor((iy0 - src.top) * sy));
      const py1 = Math.max(py0, Math.min(img.h - 1, Math.ceil((iy1 - src.top) * sy) - 1));
      let sum = 0, cnt = 0;
      for (let py = py0; py <= py1; py++) {
        for (let px = px0; px <= px1; px++) { sum += img.data[(py * img.w + px) * img.stride + img.offset]; cnt++; }
      }
      const inside = ((ix1 - ix0) * (iy1 - iy0)) / ((cx1 - cx0) * (cy1 - cy0));
      cov[i] *= (sum / cnt / img.scale) * inside + img.outside * (1 - inside);
    }
  }
}

// Read a mask ("user" / "vector") or, with kind "alpha", the layer's pixel
// transparency, for rectangle b at about two samples per grid cell.
async function readLayerImage(docID, layerID, kind, b, grid) {
  const imaging = photoshop.imaging;
  const opts = { documentID: docID, layerID: layerID, sourceBounds: b };
  const want = Math.max(1, Math.ceil((b.right - b.left) / grid.cw * 2));
  if (want < b.right - b.left) opts.targetSize = { width: want };
  let res;
  if (kind === "alpha") res = await imaging.getPixels(Object.assign(opts, { componentSize: 8 }));
  else res = await imaging.getLayerMask(Object.assign(opts, { kind: kind }));
  const d = res.imageData;
  try {
    if (kind === "alpha" && !d.hasAlpha) return null;   // opaque throughout its bounds
    const cs = d.componentSize;
    return {
      data: await d.getData({ chunky: true }), w: d.width, h: d.height,
      stride: d.components || 1, offset: kind === "alpha" ? (d.components || 1) - 1 : 0,
      scale: cs === 16 ? 32768 : (cs === 32 ? 1 : 255),
      outside: kind === "alpha" ? 0 : 1,
      src: res.sourceBounds || b
    };
  } finally {
    d.dispose();
  }
}

// Where a layer can show at all: its bounds, refined by its masks and (for
// layers with pixels of their own) its transparency. A failed read just
// leaves the coarser estimate; `stats` counts reads for the status line.
async function shapeCoverage(docID, id, dom, desc, grid, stats) {
  const b = boundsIn(dom, grid);
  const cov = rectCoverage(grid, b);
  if (!b || stats.rough) return cov;
  const reads = [];
  if (desc.hasVectorMask && desc.vectorMaskEnabled !== false) reads.push("vector");
  if (desc.hasUserMask && desc.userMaskEnabled !== false) reads.push("user");
  if (!(desc.adjustment && desc.adjustment.length)) reads.push("alpha");   // not a fill layer
  for (const kind of reads) {
    try {
      const img = await readLayerImage(docID, id, kind, b, grid);
      if (img) multiplyByImage(cov, grid, b, img.src, img);
      stats.ok++;
    } catch (e) {
      stats.failed++;
    }
  }
  return cov;
}

// For each layer in the working set: `weight`, the fraction of the image it
// visibly covers, and `under`, [[layer index or -1 for none, amount], ...]
// saying what it sits on. Returns { rough, layers } or null.
async function measureLayerSizes() {
  const doc = app.activeDocument;
  const docW = num(doc.width), docH = num(doc.height);
  if (!(docW > 0 && docH > 0)) return null;
  const k = SIZE_GRID / Math.max(docW, docH);
  const grid = { W: Math.max(1, Math.round(docW * k)), H: Math.max(1, Math.round(docH * k)), docW, docH };
  grid.cw = docW / grid.W;
  grid.ch = docH / grid.H;
  const imaging = photoshop.imaging;
  const stats = { ok: 0, failed: 0,
    rough: !(imaging && typeof imaging.getLayerMask === "function" && typeof imaging.getPixels === "function") };

  const tree = layerTree(doc);
  const ids = state.layerIDs;
  if (ids.some(id => !tree.has(id))) return null;
  const getDesc = idList => batchPlay(idList.map(id => ({ _obj: "get", _target: [{ _ref: "layer", _id: id }] })), {});
  const descs = await getDesc(ids);

  const entries = [];
  for (let i = 0; i < ids.length; i++) {
    const node = tree.get(ids[i]);
    const alpha = effectiveAlpha(node.dom);
    const cov = alpha > 0
      ? await shapeCoverage(doc.id, ids[i], node.dom, descs[i] || {}, grid, stats)
      : new Float32Array(grid.W * grid.H);
    entries.push({ i, id: ids[i], node, alpha, cov });
  }

  // clipped layers only show where their base does
  const baseCov = new Map(entries.map(e => [e.id, e.cov]));
  for (const e of entries) {
    if (!e.alpha) continue;
    const base = clippingBase(e.node);
    if (!base) continue;
    let bc = baseCov.get(base.id);
    if (!bc) {
      const bd = (await getDesc([base.id]))[0] || {};
      bc = await shapeCoverage(doc.id, base.id, base, bd, grid, stats);
      baseCov.set(base.id, bc);
    }
    for (let p = 0; p < bc.length; p++) e.cov[p] *= Math.min(1, bc[p]);
  }

  // top-down: what each layer still shows after the layers above it
  const P = grid.W * grid.H;
  const order = entries.slice().sort((a, b) => a.node.z - b.node.z);
  const remaining = new Float32Array(P).fill(1);
  for (const e of order) {
    let w = 0;
    for (let p = 0; p < P; p++) {
      const v = e.cov[p] * e.alpha * remaining[p];
      if (v > 0) { w += v; remaining[p] -= v; }
    }
    e.weight = w / P;
  }
  // bottom-up: which layer each one sits on, tracking each cell's top opaque layer
  const owner = new Int32Array(P).fill(-1);
  for (let j = order.length - 1; j >= 0; j--) {
    const e = order[j], under = new Map();
    for (let p = 0; p < P; p++) {
      const c = e.cov[p] * e.alpha;
      if (c <= 0) continue;
      under.set(owner[p], (under.get(owner[p]) || 0) + c);
      if (c >= 0.5) owner[p] = e.i;
    }
    e.under = Array.from(under.entries());
  }
  return {
    rough: stats.rough || (stats.failed > 0 && stats.ok === 0),
    layers: entries.map(e => ({ weight: e.weight, under: e.under }))
  };
}

/* ---------------- main action ---------------- */
let busy = false;
let suppressDepth = 0;  // > 0 while our own changes are landing in the document
let syncTimer = null;
let colorEpoch = 0;     // bumped whenever the panel itself sets swatch colours

function beginSuppress() { suppressDepth++; }
// release a tick later so trailing change events from our own op are ignored
function endSuppress() { setTimeout(() => { suppressDepth = Math.max(0, suppressDepth - 1); }, 60); }

// Recolor all target fill layers in one batched, single-undo operation.
async function applyColors(ids, palette, historyName) {
  const name = historyName || "Re-roll Palette";
  const cmds = [];
  for (let i = 0; i < ids.length; i++) {
    cmds.push({ _obj: "select", _target: [{ _ref: "layer", _id: ids[i] }], makeVisible: false });
    const c = palette[i];
    cmds.push({
      _obj: "set",
      _target: [{ _ref: "contentLayer", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "solidColorLayer", color: { _obj: "RGBColor", red: c.r, grain: c.g, blue: c.b } }
    });
  }
  // restore the original multi-selection so the next roll has the same set
  for (let i = 0; i < ids.length; i++) {
    const cmd = { _obj: "select", _target: [{ _ref: "layer", _id: ids[i] }], makeVisible: false };
    if (i > 0) cmd.selectionModifier = { _enum: "selectionModifierType", _value: "addToSelection" };
    cmds.push(cmd);
  }

  beginSuppress();
  try {
    await executeAsModal(async (ctx) => {
      let suspId;
      try { suspId = await ctx.hostControl.suspendHistory({ documentID: app.activeDocument.id, name: name }); } catch (e) {}
      await batchPlay(cmds, {});
      if (suspId !== undefined) { try { await ctx.hostControl.resumeHistory(suspId); } catch (e) {} }
    }, { commandName: name });
  } finally {
    endSuppress();
  }
}

// Read the live colours of the working layer set and update the swatches.
// Used by the change/undo listener so the panel mirrors the document.
async function syncFromLayers() {
  if (!state.layerIDs.length || state.docID === null || state.docID !== activeDocID()) return;
  const existing = collectAllLayerIDs();
  const idx = [];
  for (let i = 0; i < state.layerIDs.length && i < state.swatches.length; i++) {
    const id = state.layerIDs[i];
    // skip layers that are gone (deleted, perhaps about to be undone) and the
    // one the hover reveal has painted green
    if (existing.has(id) && !(hl && hl.id === id)) idx.push(i);
  }
  if (!idx.length) return;
  const epoch = colorEpoch, swatches = state.swatches;
  let descs;
  try {
    descs = await batchPlay(idx.map(i => ({ _obj: "get", _target: [{ _ref: "layer", _id: state.layerIDs[i] }] })), {});
  } catch (e) { return; }
  // the panel recoloured (or the set changed) while we were reading: stale
  if (busy || epoch !== colorEpoch || swatches !== state.swatches) return;
  let changed = false;
  idx.forEach((i, k) => {
    const adj = descs[k] && descs[k].adjustment;
    if (adj && adj.length && adj[0]._obj === "solidColorLayer" && adj[0].color
        && typeof adj[0].color.red === "number") {   // non-RGB docs report other colour models
      const col = adj[0].color;
      const r = Math.round(col.red), g = Math.round(col.grain), b = Math.round(col.blue);
      const s = swatches[i];
      if (s.r !== r || s.g !== g || s.b !== b) {
        s.r = r; s.g = g; s.b = b; s.hex = toHex(r, g, b);
        changed = true;
      }
    }
  });
  if (changed) renderSwatches();
}

// Colours are only re-read after events that can change them (or a document
// switch); plain layer selection just checks which document is active.
let syncColorsPending = false;
function onPsEvent(event) {
  if (suppressDepth > 0) return;
  if (event === "set" || event === "historyStateChanged") syncColorsPending = true;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    const colors = syncColorsPending;
    syncColorsPending = false;
    if (suppressDepth > 0 || busy) return;
    const switched = syncDocContext();
    if (switched) { renderSwatches(); setStatus(""); }
    if (colors || switched) await syncFromLayers();
  }, 130);
}

// Define (or replace) the working set and rebuild aligned swatch slots.
function captureSet(ids) {
  state.docID = activeDocID();
  state.layerIDs = ids.slice();
  state.swatches = [];
  state.linkArm = null;
  state.nextGroup = 0;
  colorEpoch++;
  for (let i = 0; i < ids.length; i++) {
    state.swatches.push({ r: 0, g: 0, b: 0, hex: "#000000", locked: false, group: state.nextGroup++ });
  }
}

function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const sa = a.slice().sort((x, y) => x - y), sb = b.slice().sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

async function reroll() {
  if (busy) return;
  busy = true;
  try {
    await releaseReveal();   // put a hover-revealed layer back before touching the document
    syncDocContext();
    if (!app.documents.length) { renderSwatches(); setStatus("Open a document first."); return; }
    const dropped = await pruneInvalidLayers();
    const sel = await getSolidFillLayerIDs();
    const have = state.layerIDs.length > 0;
    // A new multi-layer selection redefines the set; otherwise keep the stored set.
    if (sel.length >= 2 && !(have && sameSet(sel, state.layerIDs))) {
      captureSet(sel);
    } else if (!have) {
      if (!sel.length) { renderSwatches(); setStatus("Select one or more Solid Color fill layers."); return; }
      captureSet(sel);
    }
    let sizes = null, sizeNote = "";
    if (state.placeBySize && computeGroups().some(g => !g.locked)) {
      let m = null;
      try {
        await executeAsModal(async () => { m = await measureLayerSizes(); }, { commandName: "Measure Layers" });
      } catch (e) { m = null; }
      if (m) { sizes = m.layers; sizeNote = " · by size" + (m.rough ? " (bounds only)" : ""); }
      else sizeNote = " · couldn't measure sizes";
    }
    const mode = generateGroupedPalette(sizes);
    if (!mode) { renderSwatches(); setStatus("Everything is locked — unlock a colour to re-roll."); return; }
    colorEpoch++;
    await applyColors(state.layerIDs, state.swatches, "Re-roll Palette");
    renderSwatches();
    const n = state.layerIDs.length;
    setStatus(n + " layer" + (n > 1 ? "s" : "") + " recolored · " + mode + sizeNote
      + (dropped ? " (dropped " + dropped + " deleted/converted layer" + (dropped > 1 ? "s" : "") + ")" : ""));
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : e));
  } finally {
    busy = false;
  }
}

/* ---------------- UI ---------------- */
function setStatus(msg) { document.getElementById("status").textContent = msg; }

// Reassign the current colours to different layers: a uniformly random
// permutation of the unlocked groups (identity excluded, so something always
// moves). Unlike a fixed rotation, every arrangement is reachable — including
// partial swaps where some colours stay put. Linked layers move together;
// locked groups never move.
async function swapPositions() {
  if (busy) return;
  busy = true;
  try {
    await releaseReveal();
    syncDocContext();
    await pruneInvalidLayers();
    if (!state.swatches.length || !state.layerIDs.length) { renderSwatches(); setStatus("Generate a palette first."); return; }
    const groups = computeGroups();
    const unlocked = groups.filter(grp => !grp.locked);
    if (unlocked.length < 2) { renderSwatches(); setStatus("Need 2+ unlocked groups to swap."); return; }

    const colors = unlocked.map(grp => ({ r: grp.color.r, g: grp.color.g, b: grp.color.b, hex: grp.color.hex }));
    const perm = colors.map((_, i) => i);
    do { shuffle(perm); } while (perm.every((v, i) => v === i)); // never a no-op
    unlocked.forEach((grp, k) => {
      const c = colors[perm[k]];
      for (const idx of grp.members) {
        const s = state.swatches[idx];
        s.r = c.r; s.g = c.g; s.b = c.b; s.hex = c.hex;
      }
    });
    colorEpoch++;

    await applyColors(state.layerIDs, state.swatches, "Swap Palette Colors");
    renderSwatches();
    setStatus("Swapped positions.");
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : e));
  } finally {
    busy = false;
  }
}

/* ---------------- hover reveal ---------------- */
// Hovering a swatch's chain icon paints its layer chroma-green in the
// document so you can instantly see which layer the row controls; moving the
// pointer away restores it. The green is committed as its own named history
// state, and on release we *step back* through history — undo navigation adds
// nothing to the stack, so the user's undo history is left exactly as it was.
// (A held-open modal scope would avoid the history state entirely, but
// Photoshop doesn't repaint the canvas while a modal is held, so the green
// would never show.)
const HL_NAME = "Reveal Layer";
const HL_GREEN = { red: 0, grain: 255, blue: 0 };
let hl = null;                     // { docID, id, r, g, b } of the layer painted green, or null
let hlChain = Promise.resolve();   // serializes reveal/restore operations

function queueHl(fn) { hlChain = hlChain.then(fn).catch(() => {}); }

function selectLayersCmds(ids) {
  if (!ids.length) return [{ _obj: "selectNoLayers", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }];
  return ids.map((id, i) => {
    const cmd = { _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false };
    if (i > 0) cmd.selectionModifier = { _enum: "selectionModifierType", _value: "addToSelection" };
    return cmd;
  });
}

function hoverRevealIn(idx) {
  if (busy) return;
  queueHl(async () => {
    if (busy || hl) return;
    if (state.docID === null || state.docID !== activeDocID() || idx >= state.layerIDs.length) return;
    const sw = state.swatches[idx];
    // recorded before painting, so the restore runs even if the reveal fails halfway
    hl = { docID: state.docID, id: state.layerIDs[idx], r: sw.r, g: sw.g, b: sw.b };
    const id = hl.id;
    beginSuppress();
    try {
      await executeAsModal(async (ctx) => {
        const prevSel = app.activeDocument.activeLayers.map(l => l.id);
        let susp;
        try { susp = await ctx.hostControl.suspendHistory({ documentID: app.activeDocument.id, name: HL_NAME }); } catch (e) {}
        await batchPlay([
          { _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false },
          { _obj: "set", _target: [{ _ref: "contentLayer", _enum: "ordinal", _value: "targetEnum" }],
            to: { _obj: "solidColorLayer", color: Object.assign({ _obj: "RGBColor" }, HL_GREEN) } }
        ], {});
        try { await batchPlay(selectLayersCmds(prevSel), {}); } catch (e) {}   // selection back right away
        if (susp !== undefined) { try { await ctx.hostControl.resumeHistory(susp); } catch (e) {} }
      }, { commandName: HL_NAME });
    } catch (e) {
      /* layer gone or modal unavailable — the restore copes either way */
    } finally {
      endSuppress();
    }
  });
}

function hoverRevealOut() {
  queueHl(async () => {
    if (!hl) return;
    const shown = hl;
    hl = null;
    // only the active document's history can be stepped; if the user switched
    // documents mid-hover, the reveal stays in that document's history
    if (shown.docID !== activeDocID()) return;
    beginSuppress();
    try {
      await executeAsModal(async () => {
        // Normal case: the top history state is still our reveal — stepping
        // back removes the green and leaves the undo stack untouched.
        let name = "";
        try {
          const d = await batchPlay([{ _obj: "get", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "targetEnum" }] }], {});
          if (d && d[0] && typeof d[0].name === "string") name = d[0].name;
        } catch (e) {}
        if (name === HL_NAME) {
          await batchPlay([{ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }], {});
          return;
        }
        // Something else happened in between — repaint the original colour,
        // but only if the layer is actually still green.
        let isGreen = false;
        try {
          const d2 = await batchPlay([{ _obj: "get", _target: [{ _ref: "layer", _id: shown.id }] }], {});
          const adj = d2 && d2[0] && d2[0].adjustment;
          if (adj && adj.length && adj[0]._obj === "solidColorLayer" && adj[0].color
              && typeof adj[0].color.red === "number") {
            const c = adj[0].color;
            isGreen = Math.round(c.red) === HL_GREEN.red
                   && Math.round(c.grain) === HL_GREEN.grain
                   && Math.round(c.blue) === HL_GREEN.blue;
          }
        } catch (e) {}
        if (isGreen) {
          const prevSel = app.activeDocument.activeLayers.map(l => l.id);
          await batchPlay([
            { _obj: "select", _target: [{ _ref: "layer", _id: shown.id }], makeVisible: false },
            { _obj: "set", _target: [{ _ref: "contentLayer", _enum: "ordinal", _value: "targetEnum" }],
              to: { _obj: "solidColorLayer", color: { _obj: "RGBColor", red: shown.r, grain: shown.g, blue: shown.b } } }
          ], {});
          try { await batchPlay(selectLayersCmds(prevSel), {}); } catch (e) {}
        }
      }, { commandName: "Restore Layer" });
    } catch (e) {
      /* nothing to restore */
    } finally {
      endSuppress();
    }
  });
}

// Undo any hover reveal and wait until it's fully gone, so our own modal
// operations never interleave with it (or bury it in the undo history).
async function releaseReveal() {
  hoverRevealOut();
  await hlChain;
}

/* ---------------- linking ---------------- */
function groupSize(g) { let c = 0; for (const s of state.swatches) if (s.group === g) c++; return c; }
function isLinked(idx) { return groupSize(state.swatches[idx].group) > 1; }
function groupLocked(g) { return state.swatches.some(s => s.group === g && s.locked); }

// recolor every layer from current swatch state, then re-render
async function applyAll(msg, historyName) {
  busy = true;
  try {
    await releaseReveal();
    await pruneInvalidLayers();
    if (state.layerIDs.length && state.layerIDs.length === state.swatches.length) {
      await applyColors(state.layerIDs, state.swatches, historyName);
    }
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : e));
    msg = null;
  } finally {
    busy = false;
  }
  renderSwatches();
  if (msg) setStatus(msg);
}

// Merge the armed swatch into the target's group: it takes on the target's
// colour and lock state, so a group is always entirely locked or unlocked.
async function completeLink(a, b) {
  state.linkArm = null;
  const s = state.swatches[a], sib = state.swatches[b];
  const lock = groupLocked(sib.group);
  s.group = sib.group;
  s.locked = lock;
  s.r = sib.r; s.g = sib.g; s.b = sib.b; s.hex = sib.hex;
  colorEpoch++;
  await applyAll("Linked.", "Link Palette Colors");
}

// Pop a swatch out of its group into a fresh solo group (colour and lock unchanged).
function unlinkSwatch(idx) {
  state.swatches[idx].group = state.nextGroup++;
  renderSwatches();
  setStatus("Unlinked.");
}

// Handle a tap on a swatch's link icon.
function onLinkClick(idx) {
  if (busy) return;
  hoverRevealOut();
  if (syncDocContext()) { renderSwatches(); setStatus(""); return; }   // rows were another document's
  if (state.linkArm !== null) {
    if (idx === state.linkArm) { state.linkArm = null; renderSwatches(); setStatus(""); }
    else { completeLink(state.linkArm, idx); }
    return;
  }
  if (isLinked(idx)) { unlinkSwatch(idx); }
  else { state.linkArm = idx; renderSwatches(); setStatus("Now tap another colour to link."); }
}

// Handle a tap on a swatch row body.
function onRowClick(idx) {
  if (busy) return;
  hoverRevealOut();
  if (syncDocContext()) { renderSwatches(); setStatus(""); return; }   // rows were another document's
  if (state.linkArm !== null) {            // linking mode: complete or cancel
    if (idx === state.linkArm) { state.linkArm = null; renderSwatches(); setStatus(""); }
    else { completeLink(state.linkArm, idx); }
    return;
  }
  // normal: toggle the lock for the whole link group
  const g = state.swatches[idx].group;
  const lock = !groupLocked(g);
  for (const s of state.swatches) if (s.group === g) s.locked = lock;
  renderSwatches();
}

function renderSwatches() {
  const host = document.getElementById("swatches");
  host.innerHTML = "";
  if (!state.swatches.length) {
    const ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = "Select your Solid Color fill layers, then hit Generate.";
    host.appendChild(ph);
    return;
  }

  state.swatches.forEach((s, idx) => {
    const armed = state.linkArm === idx;
    const linking = state.linkArm !== null;
    const linked = isLinked(idx);
    const locked = groupLocked(s.group);

    const row = document.createElement("div");
    row.className = "sw" + (locked ? " locked" : "") + (armed ? " armed" : "")
                  + (linking && !armed ? " target" : "");

    const chip = document.createElement("div");
    chip.className = "chip";
    chip.style.background = s.hex;
    const lock = document.createElement("div");
    lock.className = "lock";
    chip.appendChild(lock);

    const meta = document.createElement("div");
    meta.className = "meta";
    const hex = document.createElement("div");
    hex.className = "hex";
    hex.textContent = s.hex;
    const st = document.createElement("div");
    st.className = "state";
    st.textContent = armed ? "linking…" : (locked ? "locked" : (linked ? "linked" : "unlocked"));
    meta.appendChild(hex);
    meta.appendChild(st);

    const link = document.createElement("div");
    link.className = "link" + (linked ? " on" : "") + (armed ? " armed" : "");
    link.title = "Hover: flash this layer green in the document. Click: link / unlink with another colour.";
    const chain = document.createElement("span");
    chain.className = "chain";
    link.appendChild(chain);
    link.addEventListener("click", (e) => { e.stopPropagation(); onLinkClick(idx); });
    link.addEventListener("pointerenter", () => hoverRevealIn(idx));
    link.addEventListener("pointerleave", () => hoverRevealOut());

    row.appendChild(chip);
    row.appendChild(meta);
    row.appendChild(link);
    row.addEventListener("click", () => onRowClick(idx));
    host.appendChild(row);
  });
}

// Minimal custom dropdown (native <select> is unreliable in UXP).
function buildDropdown(mountId, options, getVal, setVal) {
  const mount = document.getElementById(mountId);
  const dd = document.createElement("div");
  dd.className = "dd";

  const head = document.createElement("div");
  head.className = "dd-head";
  const headText = document.createElement("span");
  headText.textContent = getVal();
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  head.appendChild(headText);
  head.appendChild(caret);

  const list = document.createElement("div");
  list.className = "dd-list";
  options.forEach(opt => {
    const item = document.createElement("div");
    item.className = "dd-item" + (opt === getVal() ? " sel" : "");
    item.textContent = opt;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      setVal(opt);
      headText.textContent = opt;
      list.querySelectorAll(".dd-item").forEach(el =>
        el.classList.toggle("sel", el.textContent === opt));
      dd.classList.remove("open");
    });
    list.appendChild(item);
  });

  head.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllDropdowns(dd);
    dd.classList.toggle("open");
  });

  dd.appendChild(head);
  dd.appendChild(list);
  mount.appendChild(dd);
}

function closeAllDropdowns(except) {
  document.querySelectorAll(".dd.open").forEach(d => { if (d !== except) d.classList.remove("open"); });
}

// Multi-select checklist dropdown. `selected` is the live array to mutate.
function buildChecklist(mountId, options, selected) {
  const mount = document.getElementById(mountId);
  const dd = document.createElement("div");
  dd.className = "dd";

  const head = document.createElement("div");
  head.className = "dd-head";
  const headText = document.createElement("span");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  head.appendChild(headText);
  head.appendChild(caret);

  function summary() {
    if (selected.length === 0) return "None";
    if (selected.length === options.length) return "All";
    if (selected.length <= 2) return selected.join(", ");
    return selected.length + " selected";
  }
  function refreshHead() { headText.textContent = summary(); }
  refreshHead();

  const list = document.createElement("div");
  list.className = "dd-list";
  options.forEach(opt => {
    const item = document.createElement("div");
    item.className = "dd-item check";
    const box = document.createElement("span");
    box.className = "box";
    const txt = document.createElement("span");
    txt.textContent = opt;
    item.appendChild(box);
    item.appendChild(txt);
    function refreshItem() { item.classList.toggle("on", selected.indexOf(opt) >= 0); }
    refreshItem();
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const at = selected.indexOf(opt);
      if (at >= 0) { if (selected.length > 1) selected.splice(at, 1); }  // keep >=1
      else selected.push(opt);
      refreshItem();
      refreshHead();
    });
    list.appendChild(item);
  });

  head.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllDropdowns(dd);
    dd.classList.toggle("open");
  });

  dd.appendChild(head);
  dd.appendChild(list);
  mount.appendChild(dd);
}

/* ---------------- init ---------------- */
function init() {
  const vEl = document.getElementById("version");
  if (vEl) vEl.textContent = "v" + VERSION;

  const HARMONY_OPTS = HARMONIES.slice(1); // drop the old "Random" entry
  buildChecklist("harmonyDD", HARMONY_OPTS, state.enabledHarmonies);
  buildDropdown("styleDD", STYLES, () => state.style, v => { state.style = v; });

  const sizeToggle = document.getElementById("sizeToggle");
  sizeToggle.addEventListener("click", () => {
    state.placeBySize = !state.placeBySize;
    sizeToggle.classList.toggle("on", state.placeBySize);
  });

  const genBtn = document.getElementById("generate");
  const swapBtn = document.getElementById("swap");
  genBtn.addEventListener("click", () => { reroll(); genBtn.blur(); });
  swapBtn.addEventListener("click", () => { swapPositions(); swapBtn.blur(); });
  // make the buttons mouse-only so a focused button can't be re-fired by Space/Enter
  [genBtn, swapBtn].forEach(el => {
    const swallow = (e) => {
      if (e.key === " " || e.key === "Spacebar" || e.code === "Space" || e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
      }
    };
    el.addEventListener("keydown", swallow);
    el.addEventListener("keyup", swallow);
  });

  document.addEventListener("click", () => closeAllDropdowns(null));
  // safety net: leaving the swatch list always ends a hover reveal
  document.getElementById("swatches").addEventListener("pointerleave", () => hoverRevealOut());

  // live-sync: re-read colours when the document changes, is undone/redone, or
  // the user switches documents
  try {
    photoshop.action.addNotificationListener(
      ["set", "historyStateChanged", "select", "open", "make", "close"], (event) => onPsEvent(event));
  } catch (e) { /* live sync unavailable on this build; rest of panel still works */ }

  try { syncDocContext(); } catch (e) {}
  renderSwatches();
}

init();
