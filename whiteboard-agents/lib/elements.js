// Factories for wire-valid Excalidraw elements, plus fractional-index
// generation compatible with the `fractional-indexing` scheme excalidraw uses.
import { webcrypto } from "node:crypto";

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function incrementInteger(x) {
  const head = x[0];
  let digits = x.slice(1).split("");
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = CHARSET.indexOf(digits[i]) + 1;
    if (d === CHARSET.length) {
      digits[i] = "0";
    } else {
      digits[i] = CHARSET[d];
      return head + digits.join("");
    }
  }
  // carry overflowed: move to next head char with one more digit
  if (head === "z") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  return nextHead + "0".repeat(integerLength(nextHead));
}

function integerLength(head) {
  const c = head.charCodeAt(0);
  if (c >= 97 && c <= 122) return c - 97 + 1; // a-z: 1..26 digits
  if (c >= 65 && c <= 90) return 90 - c + 1; // A-Z (negative range)
  throw new Error(`invalid index head: ${head}`);
}

function integerPart(key) {
  const len = integerLength(key[0]) + 1;
  return key.slice(0, len);
}

// Key strictly greater than `key` (append-at-end ordering). A random
// non-zero fractional char is added so concurrent agents rarely collide.
export function indexAfter(key) {
  const jitter = CHARSET[1 + randInt(CHARSET.length - 2)];
  if (!key) return "a0" + jitter;
  const next = incrementInteger(integerPart(key));
  return (next || key + "V") + jitter;
}

export function maxIndex(elements) {
  let max = null;
  for (const el of elements) {
    if (el.index && (!max || el.index > max)) max = el.index;
  }
  return max;
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

export function randomElementId() {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

const FONT = { hand: 5, normal: 6, code: 3 }; // Excalifont / Nunito / Cascadia

function base(overrides) {
  return {
    id: randomElementId(),
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null, // assigned at insert time
    roundness: null,
    seed: randomSeed(),
    version: 1,
    versionNonce: randomSeed(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...overrides,
  };
}

// Rough text metrics for Excalifont; excalidraw self-corrects on edit.
export function measureText(text, fontSize = 20, lineHeight = 1.25) {
  const lines = String(text).split("\n");
  const maxLen = Math.max(1, ...lines.map((l) => l.length));
  return {
    width: Math.ceil(maxLen * fontSize * 0.55),
    height: Math.ceil(lines.length * fontSize * lineHeight),
  };
}

export function wrapText(text, maxCharsPerLine) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line.length) line = word;
      else if ((line + " " + word).length <= maxCharsPerLine) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

export function makeText({
  text,
  x,
  y,
  fontSize = 20,
  strokeColor = "#1e1e1e",
  fontFamily = "hand",
  textAlign = "left",
  angle = 0,
  opacity = 100,
  link = null,
  customData,
}) {
  const { width, height } = measureText(text, fontSize);
  return base({
    type: "text",
    x,
    y,
    width,
    height,
    angle,
    opacity,
    strokeColor,
    link,
    customData,
    text: String(text),
    fontSize,
    fontFamily: FONT[fontFamily] ?? FONT.hand,
    textAlign,
    verticalAlign: "top",
    containerId: null,
    originalText: String(text),
    autoResize: true,
    lineHeight: 1.25,
  });
}

export function makeShape({
  shape = "rectangle", // rectangle | ellipse | diamond
  x,
  y,
  width = 160,
  height = 90,
  strokeColor = "#1e1e1e",
  backgroundColor = "transparent",
  fillStyle = "solid",
  strokeWidth = 2,
  strokeStyle = "solid",
  opacity = 100,
  angle = 0,
  customData,
}) {
  return base({
    type: shape,
    x,
    y,
    width,
    height,
    angle,
    strokeColor,
    backgroundColor,
    fillStyle,
    strokeWidth,
    strokeStyle,
    opacity,
    roundness: shape === "rectangle" ? { type: 3 } : null,
    customData,
  });
}

// Sticky note: container shape + bound text (two elements).
export function makeNote({
  text,
  x,
  y,
  width = 220,
  strokeColor = "#1e1e1e",
  backgroundColor = "#fff9db",
  fontSize = 16,
  shape = "rectangle",
  minHeight = 60,
  link = null,
  customData,
}) {
  const innerWidth = width - 20;
  const charsPerLine = Math.max(8, Math.floor(innerWidth / (fontSize * 0.55)));
  const wrapped = wrapText(text, charsPerLine);
  const lines = wrapped.split("\n").length;
  const height = Math.max(minHeight, Math.ceil(lines * fontSize * 1.25) + 24);

  const container = makeShape({
    shape,
    x,
    y,
    width,
    height,
    strokeColor,
    backgroundColor,
    customData,
  });
  container.link = link;
  const textEl = base({
    type: "text",
    x: x + 10,
    y: y + height / 2 - (lines * fontSize * 1.25) / 2,
    width: innerWidth,
    height: Math.ceil(lines * fontSize * 1.25),
    strokeColor,
    customData,
    text: wrapped,
    fontSize,
    fontFamily: FONT.hand,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: container.id,
    originalText: String(text),
    autoResize: true,
    lineHeight: 1.25,
  });
  container.boundElements = [{ type: "text", id: textEl.id }];
  return [container, textEl];
}

export function makeArrow({
  points, // [[0,0],[dx,dy],...] relative to x,y
  x,
  y,
  strokeColor = "#1e1e1e",
  strokeWidth = 2,
  strokeStyle = "solid",
  endArrowhead = "arrow",
  startArrowhead = null,
  opacity = 100,
  customData,
}) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return base({
    type: "arrow",
    x,
    y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    strokeColor,
    strokeWidth,
    strokeStyle,
    opacity,
    roundness: { type: 2 },
    customData,
    points,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead,
    endArrowhead,
    elbowed: false,
  });
}

export function makeFreedraw({ points, x, y, strokeColor = "#1e1e1e", strokeWidth = 2, customData }) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return base({
    type: "freedraw",
    x,
    y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    strokeColor,
    strokeWidth,
    customData,
    points,
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: points[points.length - 1],
  });
}

export function makeImage({ x, y, width, height, fileId, link = null, customData }) {
  return base({
    type: "image",
    x,
    y,
    width,
    height,
    strokeColor: "transparent",
    link,
    customData,
    fileId,
    status: "saved", // already uploaded to room storage when the element lands
    scale: [1, 1],
    crop: null,
  });
}

export function makeFrame({ x, y, width, height, name, customData }) {
  return base({
    type: "frame",
    x,
    y,
    width,
    height,
    strokeColor: "#bbb",
    backgroundColor: "transparent",
    customData,
    name: name || null,
  });
}

export function bbox(el) {
  if (!el) return null;
  return { x: el.x, y: el.y, w: el.width || 0, h: el.height || 0 };
}

export function overlaps(a, b, margin = 0) {
  return !(
    a.x + a.w + margin < b.x ||
    b.x + b.w + margin < a.x ||
    a.y + a.h + margin < b.y ||
    b.y + b.h + margin < a.y
  );
}

// Spiral outward from (x,y) until a w×h box fits without touching
// existing elements (24px margin). Keeps agents from stomping on content.
export function findFreeSpace(elements, { x, y, w, h, margin = 24, step = 40, maxRadius = 2000 }) {
  const boxes = elements.filter((e) => !e.isDeleted && e.type !== "frame").map(bbox);
  const fits = (px, py) => {
    const candidate = { x: px, y: py, w, h };
    return !boxes.some((b) => overlaps(candidate, b, margin));
  };
  if (fits(x, y)) return { x, y };
  for (let r = step; r <= maxRadius; r += step) {
    const steps = Math.max(8, Math.floor((2 * Math.PI * r) / step));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      const px = Math.round(x + r * Math.cos(a));
      const py = Math.round(y + r * Math.sin(a));
      if (fits(px, py)) return { x: px, y: py };
    }
  }
  return { x: x + maxRadius, y };
}

// Straight connector between two bboxes, trimmed to their edges.
export function edgeToEdge(fromBox, toBox, gap = 8) {
  const c1 = { x: fromBox.x + fromBox.w / 2, y: fromBox.y + fromBox.h / 2 };
  const c2 = { x: toBox.x + toBox.w / 2, y: toBox.y + toBox.h / 2 };
  const trim = (box, from, to) => {
    // walk from center toward the other center until leaving the box
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = Math.abs(dx) > 0.01 ? (box.w / 2 + gap) / Math.abs(dx / len) : Infinity;
    const ty = Math.abs(dy) > 0.01 ? (box.h / 2 + gap) / Math.abs(dy / len) : Infinity;
    const t = Math.min(tx, ty, len / 2);
    return { x: from.x + (dx / len) * t, y: from.y + (dy / len) * t };
  };
  const p1 = trim(fromBox, c1, c2);
  const p2 = trim(toBox, c2, c1);
  return { x: p1.x, y: p1.y, points: [[0, 0], [p2.x - p1.x, p2.y - p1.y]] };
}
