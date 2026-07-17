"use strict";

const VERSION = "1.6.6";

const photoshop = require("photoshop");
const app = photoshop.app;
const { batchPlay } = photoshop.action;
const { executeAsModal } = photoshop.core;

/* ---------------- config ---------------- */
const HARMONIES = ["Random", "Analogous", "Complementary", "Split", "Triadic", "Tetradic", "Mono"];
const STYLES = ["Default", "Vibrant", "Muted", "Pastel", "Deep"];

function styleParams(style) {
  switch (style) {
    case "Vibrant": return { satBase: 0.80, satJit: 0.10, briMin: 0.50, briMax: 0.92 };
    case "Muted":   return { satBase: 0.32, satJit: 0.10, briMin: 0.45, briMax: 0.82 };
    case "Pastel":  return { satBase: 0.28, satJit: 0.10, briMin: 0.80, briMax: 0.96 };
    case "Deep":    return { satBase: 0.70, satJit: 0.12, briMin: 0.26, briMax: 0.60 };
    default:        return { satBase: 0.58, satJit: 0.18, briMin: 0.38, briMax: 0.93 };
  }
}

/* ---------------- state ---------------- */
const state = {
  enabledHarmonies: ["Analogous", "Complementary", "Split", "Triadic", "Tetradic", "Mono"],
  style: "Default",
  swatches: [],     // [{ r, g, b, hex, locked, group }] aligned 1:1 with layerIDs
  layerIDs: [],     // the working set of fill-layer IDs the panel controls
  linkArm: null,    // index of the swatch currently armed for linking, or null
  nextGroup: 0      // counter for minting fresh (solo) group ids
};

/* ---------------- color math ---------------- */
function rand(a, b) { return a + Math.random() * (b - a); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function hsbToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360 / 360;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHsb(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h: h, s: max === 0 ? 0 : d / max, v: max };
}

function toHex(r, g, b) {
  const h = n => ("0" + n.toString(16)).slice(-2).toUpperCase();
  return "#" + h(r) + h(g) + h(b);
}

// shortest angular distance between two hues, 0..180
function circDist(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

// "redmean" weighted RGB distance — cheap but tracks perception reasonably well
function colorDist(a, b) {
  const rm = (a.r + b.r) / 2;
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

function pickHarmony() {
  const pool = state.enabledHarmonies.length ? state.enabledHarmonies : HARMONIES.slice(1);
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildHues(n, base, mode) {
  const hues = []; let set, i;
  if (mode === "Analogous") {
    // spread to fill a pleasant arc rather than a fixed per-step gap
    const span = rand(50, 95);                 // total degrees the set spans
    const step = n > 1 ? span / (n - 1) : 0;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (i = 0; i < n; i++) hues.push(base + dir * (i * step - span / 2) + rand(-5, 5));
  } else if (mode === "Complementary") {
    for (i = 0; i < n; i++) hues.push(base + (i % 2) * 180 + rand(-10, 10));
  } else if (mode === "Split") {
    set = [base, base + 150, base + 210];
    for (i = 0; i < n; i++) hues.push(set[i % 3] + rand(-9, 9));
  } else if (mode === "Triadic") {
    set = [base, base + 120, base + 240];
    for (i = 0; i < n; i++) hues.push(set[i % 3] + rand(-9, 9));
  } else if (mode === "Tetradic") {
    set = [base, base + 90, base + 180, base + 270];
    for (i = 0; i < n; i++) hues.push(set[i % 4] + rand(-7, 7));
  } else { // Mono — keep one hue but allow a faint drift so it isn't flat
    for (i = 0; i < n; i++) hues.push(base + rand(-10, 10));
  }
  return hues;
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

// Build one candidate palette: an array of {r,g,b,hex}, one per group.
// Locked groups keep their colour and anchor the base hue. Each locked group
// claims the hue slot *nearest its own hue*, so the remaining slots (the
// complement, the triad arms, …) go to the unlocked groups — locking a swatch
// never causes another swatch to duplicate its hue.
function buildCandidate(groups, mode, sp) {
  const n = groups.length;
  // Mono can't separate swatches by hue, so give it a wider tonal range and
  // more saturation variety — monochrome palettes live on value contrast.
  if (mode === "Mono") {
    sp = {
      satBase: sp.satBase,
      satJit: Math.max(sp.satJit, 0.24),
      briMin: Math.max(0.10, sp.briMin - 0.14),
      briMax: Math.min(0.97, sp.briMax + 0.04)
    };
  }
  const lockedIdx = [];
  for (let i = 0; i < n; i++) if (groups[i].locked) lockedIdx.push(i);

  let baseHue = Math.random() * 360;
  if (lockedIdx.length) {
    const c = groups[lockedIdx[0]].color;
    baseHue = rgbToHsb(c.r, c.g, c.b).h;
  }
  const hues = buildHues(n, baseHue, mode);

  // Locked groups claim their nearest hue slot; unlocked groups take the rest.
  const slotUsed = new Array(n).fill(false);
  const slotFor = new Array(n).fill(-1);
  for (const gi of lockedIdx) {
    const c = groups[gi].color;
    const gh = rgbToHsb(c.r, c.g, c.b).h;
    let best = -1, bd = Infinity;
    for (let s = 0; s < n; s++) {
      if (slotUsed[s]) continue;
      const d = circDist(hues[s], gh);
      if (d < bd) { bd = d; best = s; }
    }
    slotUsed[best] = true; slotFor[gi] = best;
  }
  let cur = 0;
  for (let gi = 0; gi < n; gi++) {
    if (groups[gi].locked) continue;
    while (slotUsed[cur]) cur++;
    slotUsed[cur] = true; slotFor[gi] = cur;
  }

  // Balanced tones: brightness spread evenly across the style's range (so
  // swatches stay visually separated), with light jitter, then shuffled so no
  // layer is permanently the brightest.
  const tones = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0.5;
    let bri = sp.briMin + t * (sp.briMax - sp.briMin);
    bri = clamp(bri + rand(-0.045, 0.045), 0.08, 0.98);
    let sat = clamp(sp.satBase + rand(-sp.satJit, sp.satJit), 0.05, 0.98);
    if (bri > 0.86) sat *= 0.7;        // keep very light tones from going neon
    if (bri < 0.22) sat = Math.min(sat, 0.85); // keep very dark tones from clipping
    tones.push({ bri: bri, sat: sat });
  }
  shuffle(tones);

  const out = new Array(n);
  let toneCursor = 0;
  for (let gi = 0; gi < n; gi++) {
    if (groups[gi].locked) {
      out[gi] = groups[gi].color;
      toneCursor++;                     // locked group still claims a tone slot
    } else {
      const tone = tones[toneCursor++];
      const rgb = hsbToRgb(hues[slotFor[gi]], tone.sat, tone.bri);
      out[gi] = { r: rgb[0], g: rgb[1], b: rgb[2], hex: toHex(rgb[0], rgb[1], rgb[2]) };
    }
  }
  return out;
}

// A palette's score is the distance between its two most-similar colours —
// higher means every pair is comfortably distinguishable.
function scoreCandidate(colors) {
  if (colors.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const d = colorDist(colors[i], colors[j]);
      if (d < min) min = d;
    }
  }
  return min;
}

// Generate one colour per distinct group and write it to every member layer.
// Rolls several candidates and keeps the one whose closest pair is furthest
// apart, so a reroll never hands back two near-identical swatches.
function generateGroupedPalette() {
  const groups = computeGroups();
  const mode = pickHarmony();
  const sp = styleParams(state.style);

  const ATTEMPTS = 8, GOOD_ENOUGH = 90; // ~a clearly visible difference
  let best = null, bestScore = -1;
  for (let a = 0; a < ATTEMPTS; a++) {
    const cand = buildCandidate(groups, mode, sp);
    const sc = scoreCandidate(cand);
    if (sc > bestScore) { bestScore = sc; best = cand; }
    if (bestScore >= GOOD_ENOUGH) break;
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const c = best[gi];
    for (const idx of groups[gi].members) {
      const s = state.swatches[idx];
      s.r = c.r; s.g = c.g; s.b = c.b; s.hex = c.hex;
    }
  }
}

/* ---------------- Photoshop I/O ---------------- */

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

// Drop stored layers that no longer exist in the active document (deleted, or
// the user switched documents — layer ids are per-document, so stale ids could
// otherwise recolor unrelated layers). Swatches stay aligned; locks and link
// groups on surviving layers are preserved.
function pruneMissingLayers() {
  if (!state.layerIDs.length) return;
  if (!app.documents.length) { state.layerIDs = []; state.swatches = []; state.linkArm = null; return; }
  const existing = collectAllLayerIDs();
  if (state.layerIDs.every(id => existing.has(id))) return;
  const keptIds = [], keptSw = [];
  for (let i = 0; i < state.layerIDs.length; i++) {
    if (existing.has(state.layerIDs[i])) { keptIds.push(state.layerIDs[i]); keptSw.push(state.swatches[i]); }
  }
  state.layerIDs = keptIds;
  state.swatches = keptSw;
  state.linkArm = null;
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
    const adj = descs[i] && descs[i].adjustment;
    if (adj && adj.length && adj[0]._obj === "solidColorLayer") ids.push(layers[i].id);
  }
  return ids;
}

// Recolor all target fill layers in one batched, single-undo operation.
async function applyColors(ids, palette) {
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

  suppress = true;
  try {
    await executeAsModal(async (ctx) => {
      let suspId;
      try { suspId = await ctx.hostControl.suspendHistory({ documentID: app.activeDocument.id, name: "Re-roll Palette" }); } catch (e) {}
      await batchPlay(cmds, {});
      if (suspId !== undefined) { try { await ctx.hostControl.resumeHistory(suspId); } catch (e) {} }
    }, { commandName: "Re-roll Palette" });
  } finally {
    // release a tick later so trailing change events from our own op are ignored
    setTimeout(() => { suppress = false; }, 60);
  }
}

/* ---------------- main action ---------------- */
let busy = false;
let suppress = false;   // true while we're applying our own changes
let syncTimer = null;

// Read the live colours of the working layer set and update the swatches.
// Used by the change/undo listener so the panel mirrors the document.
async function syncFromLayers() {
  if (!state.layerIDs.length || !app.documents.length) return;
  let descs;
  try {
    const gets = state.layerIDs.map(id => ({ _obj: "get", _target: [{ _ref: "layer", _id: id }] }));
    descs = await batchPlay(gets, {});
  } catch (e) { return; }
  let changed = false;
  for (let i = 0; i < state.layerIDs.length && i < state.swatches.length; i++) {
    const adj = descs[i] && descs[i].adjustment;
    if (adj && adj.length && adj[0]._obj === "solidColorLayer" && adj[0].color
        && typeof adj[0].color.red === "number") {   // non-RGB docs report other colour models
      const col = adj[0].color;
      const r = Math.round(col.red), g = Math.round(col.grain), b = Math.round(col.blue);
      const s = state.swatches[i];
      if (s.r !== r || s.g !== g || s.b !== b) {
        s.r = r; s.g = g; s.b = b; s.hex = toHex(r, g, b);
        changed = true;
      }
    }
  }
  if (changed) renderSwatches();
}

function onPsEvent() {
  if (suppress) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    if (suppress || busy) return;
    await syncFromLayers();
  }, 130);
}

// Define (or replace) the working set and rebuild aligned swatch slots.
function captureSet(ids) {
  state.layerIDs = ids.slice();
  state.swatches = [];
  state.linkArm = null;
  state.nextGroup = 0;
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
  hoverRevealOut();   // release any held reveal so our modal isn't queued behind it
  busy = true;
  try {
    pruneMissingLayers();
    const sel = await getSolidFillLayerIDs();
    const have = state.layerIDs.length > 0;
    // A new multi-layer selection redefines the set; otherwise keep the stored set.
    if (sel.length >= 2 && !(have && sameSet(sel, state.layerIDs))) {
      captureSet(sel);
    } else if (!have) {
      if (!sel.length) { setStatus("Select one or more Solid Color fill layers."); return; }
      captureSet(sel);
    }
    generateGroupedPalette();
    await applyColors(state.layerIDs, state.swatches);
    renderSwatches();
    const n = state.layerIDs.length;
    setStatus(n + " layer" + (n > 1 ? "s" : "") + " recolored.");
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
  hoverRevealOut();
  pruneMissingLayers();
  if (!state.swatches.length || !state.layerIDs.length) { setStatus("Generate a palette first."); return; }
  const groups = computeGroups();
  const unlocked = groups.filter(grp => !grp.locked);
  if (unlocked.length < 2) { setStatus("Need 2+ unlocked groups to swap."); return; }

  busy = true;
  try {
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

    await applyColors(state.layerIDs, state.swatches);
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
let hlShown = -1;                  // row index currently painted green, or -1
let hlChain = Promise.resolve();   // serializes reveal/restore operations

function queueHl(fn) { hlChain = hlChain.then(fn).catch(() => {}); }

function selectLayersCmds(ids) {
  return ids.map((id, i) => {
    const cmd = { _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false };
    if (i > 0) cmd.selectionModifier = { _enum: "selectionModifierType", _value: "addToSelection" };
    return cmd;
  });
}

function hoverRevealIn(idx) {
  if (busy) return;
  queueHl(async () => {
    if (busy || hlShown !== -1) return;
    if (!app.documents.length || idx >= state.layerIDs.length) return;
    const id = state.layerIDs[idx];
    suppress = true;
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
        const sel = selectLayersCmds(prevSel);      // selection back right away
        if (sel.length) await batchPlay(sel, {});
        if (susp !== undefined) { try { await ctx.hostControl.resumeHistory(susp); } catch (e) {} }
      }, { commandName: HL_NAME });
      hlShown = idx;
    } catch (e) {
      /* layer gone or modal unavailable — nothing shown */
    } finally {
      setTimeout(() => { suppress = false; }, 60);
    }
  });
}

function hoverRevealOut() {
  queueHl(async () => {
    if (hlShown === -1) return;
    const idx = hlShown;
    hlShown = -1;
    if (!app.documents.length || idx >= state.layerIDs.length) return;
    const id = state.layerIDs[idx];
    const orig = state.swatches[idx];
    suppress = true;
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
          const d2 = await batchPlay([{ _obj: "get", _target: [{ _ref: "layer", _id: id }] }], {});
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
            { _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false },
            { _obj: "set", _target: [{ _ref: "contentLayer", _enum: "ordinal", _value: "targetEnum" }],
              to: { _obj: "solidColorLayer", color: { _obj: "RGBColor", red: orig.r, grain: orig.g, blue: orig.b } } }
          ], {});
          const sel = selectLayersCmds(prevSel);
          if (sel.length) await batchPlay(sel, {});
        }
      }, { commandName: "Restore Layer" });
    } catch (e) {
      /* nothing to restore */
    } finally {
      setTimeout(() => { suppress = false; }, 60);
    }
  });
}

/* ---------------- linking ---------------- */
function groupSize(g) { let c = 0; for (const s of state.swatches) if (s.group === g) c++; return c; }
function isLinked(idx) { return groupSize(state.swatches[idx].group) > 1; }

// recolor every layer from current swatch state, then re-render
async function applyAll(msg) {
  busy = true;
  try {
    pruneMissingLayers();
    if (state.layerIDs.length && state.layerIDs.length === state.swatches.length) await applyColors(state.layerIDs, state.swatches);
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : e));
  } finally {
    busy = false;
  }
  renderSwatches();
  if (msg) setStatus(msg);
}

// Merge the armed swatch into the target's group and adopt its colour.
async function completeLink(a, b) {
  state.linkArm = null;
  state.swatches[a].group = state.swatches[b].group;
  const sib = state.swatches[b], s = state.swatches[a];
  s.r = sib.r; s.g = sib.g; s.b = sib.b; s.hex = sib.hex;
  await applyAll("Linked.");
}

// Pop a swatch out of its group into a fresh solo group (colour unchanged).
function unlinkSwatch(idx) {
  state.swatches[idx].group = state.nextGroup++;
  renderSwatches();
  setStatus("Unlinked.");
}

// Handle a tap on a swatch's link icon.
function onLinkClick(idx) {
  if (busy) return;
  hoverRevealOut();   // free the held reveal modal so the action runs immediately
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
  if (state.linkArm !== null) {            // linking mode: complete or cancel
    if (idx === state.linkArm) { state.linkArm = null; renderSwatches(); setStatus(""); }
    else { completeLink(state.linkArm, idx); }
    return;
  }
  state.swatches[idx].locked = !state.swatches[idx].locked;  // normal: toggle lock
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

    const row = document.createElement("div");
    row.className = "sw" + (s.locked ? " locked" : "") + (armed ? " armed" : "")
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
    st.textContent = armed ? "linking\u2026" : (s.locked ? "locked" : (linked ? "linked" : "unlocked"));
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
  caret.textContent = "\u25BE";
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
  caret.textContent = "\u25BE";
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

  // live-sync: re-read colours when the document changes or is undone/redone
  try {
    photoshop.action.addNotificationListener(["set", "historyStateChanged"], (event) => onPsEvent(event));
  } catch (e) { /* live sync unavailable on this build; rest of panel still works */ }

  renderSwatches();
}

init();
