import test from "node:test";
import assert from "node:assert/strict";
import {
  makeText,
  makeShape,
  makeNote,
  makeArrow,
  makeFreedraw,
  makeFrame,
  makeImage,
  indexAfter,
  maxIndex,
  bbox,
  overlaps,
  findFreeSpace,
  edgeToEdge,
  measureText,
  wrapText,
} from "../lib/elements.js";
import { loadRestoreElements } from "./helpers/excalidraw.js";

// restoreElements drops elements it considers invalid/unknown — surviving the
// round-trip with type intact is the compatibility contract for our factories.
const restoreElements = await loadRestoreElements();
const surviveRestore = (els) => {
  const restored = restoreElements(els, null);
  assert.equal(
    restored.length,
    els.length,
    `restoreElements dropped elements: ${els.length} -> ${restored.length}`,
  );
  return restored;
};

test("makeText survives excalidraw restore", () => {
  const [r] = surviveRestore([makeText({ text: "hello\nworld", x: 10, y: 20 })]);
  assert.equal(r.type, "text");
  assert.equal(r.text, "hello\nworld");
  assert.equal(r.x, 10);
});

test("makeShape (all shapes) survives excalidraw restore", () => {
  for (const shape of ["rectangle", "ellipse", "diamond"]) {
    const [r] = surviveRestore([makeShape({ shape, x: 0, y: 0 })]);
    assert.equal(r.type, shape);
  }
});

test("makeNote container+text pair survives restore and stays bound", () => {
  const els = makeNote({ text: "a sticky note with some text to wrap", x: 5, y: 5 });
  assert.equal(els.length, 2);
  const [container, text] = surviveRestore(els);
  assert.equal(text.containerId, container.id);
  assert.deepEqual(container.boundElements, [{ type: "text", id: text.id }]);
});

test("makeArrow survives restore with points intact", () => {
  const [r] = surviveRestore([makeArrow({ x: 0, y: 0, points: [[0, 0], [100, 50]] })]);
  assert.equal(r.type, "arrow");
  assert.equal(r.points.length, 2);
  assert.deepEqual([...r.points[1]], [100, 50]);
});

test("makeFreedraw survives restore", () => {
  const [r] = surviveRestore([
    makeFreedraw({ x: 0, y: 0, points: [[0, 0], [8, 9], [26, -12]] }),
  ]);
  assert.equal(r.type, "freedraw");
  assert.equal(r.points.length, 3);
});

test("makeFrame survives restore with its name", () => {
  const [r] = surviveRestore([makeFrame({ x: 0, y: 0, width: 300, height: 200, name: "🤖 Agents" })]);
  assert.equal(r.type, "frame");
  assert.equal(r.name, "🤖 Agents");
});

test("makeImage survives restore with its fileId", () => {
  const [r] = surviveRestore([
    makeImage({ x: 0, y: 0, width: 320, height: 240, fileId: "a".repeat(40) }),
  ]);
  assert.equal(r.type, "image");
  assert.equal(r.fileId, "a".repeat(40));
  assert.equal(r.status, "saved");
});

test("customData rides through restore (authorship survives)", () => {
  const el = makeText({ text: "x", x: 0, y: 0, customData: { wb: { agent: "Echo", kind: "note" } } });
  const [r] = surviveRestore([el]);
  assert.equal(r.customData?.wb?.agent, "Echo");
});

test("indexAfter is strictly increasing", () => {
  let key = null;
  for (let i = 0; i < 200; i++) {
    const next = indexAfter(key);
    if (key) assert.ok(next > key, `${next} should sort after ${key}`);
    key = next;
  }
});

test("maxIndex finds the highest fractional index", () => {
  assert.equal(maxIndex([{ index: "a1x" }, { index: "a3b" }, { index: null }]), "a3b");
  assert.equal(maxIndex([{}]), null);
});

test("fractional indices from indexAfter are accepted by restore", () => {
  let idx = null;
  const els = [];
  for (let i = 0; i < 5; i++) {
    idx = indexAfter(idx);
    els.push(makeShape({ x: i * 10, y: 0 }));
    els[i].index = idx;
  }
  const restored = surviveRestore(els);
  assert.deepEqual(restored.map((e) => e.index), els.map((e) => e.index));
});

test("findFreeSpace never returns an overlapping rect", () => {
  // dense grid of existing elements around the origin
  const elements = [];
  for (let gx = -3; gx <= 3; gx++) {
    for (let gy = -3; gy <= 3; gy++) {
      elements.push({ x: gx * 150, y: gy * 120, width: 130, height: 100, type: "rectangle" });
    }
  }
  for (const want of [
    { x: 0, y: 0, w: 200, h: 80 },
    { x: -100, y: 50, w: 60, h: 60 },
    { x: 300, y: -200, w: 400, h: 300 },
  ]) {
    const spot = findFreeSpace(elements, want);
    const candidate = { x: spot.x, y: spot.y, w: want.w, h: want.h };
    for (const e of elements) {
      assert.ok(
        !overlaps(candidate, bbox(e), 24),
        `free space ${JSON.stringify(spot)} overlaps ${JSON.stringify(bbox(e))}`,
      );
    }
  }
});

test("findFreeSpace returns the requested spot when it is free", () => {
  const spot = findFreeSpace([], { x: 42, y: 43, w: 100, h: 100 });
  assert.deepEqual(spot, { x: 42, y: 43 });
});

test("edgeToEdge endpoints land on the boxes' edges, not centers", () => {
  const a = { x: 0, y: 0, w: 100, h: 60 };
  const b = { x: 300, y: 0, w: 100, h: 60 };
  const { x, y, points } = edgeToEdge(a, b, 8);
  // start: just right of box a
  assert.ok(x >= a.x + a.w && x <= a.x + a.w + 10, `start x ${x} should hug a's right edge`);
  assert.equal(y, 30); // vertical center
  // end: just left of box b
  const endX = x + points[1][0];
  assert.ok(endX <= b.x && endX >= b.x - 10, `end x ${endX} should hug b's left edge`);
});

test("edgeToEdge works for diagonal and vertical layouts", () => {
  const a = { x: 0, y: 0, w: 50, h: 50 };
  for (const b of [
    { x: 200, y: 200, w: 50, h: 50 },
    { x: 0, y: 300, w: 50, h: 50 },
  ]) {
    const { x, y, points } = edgeToEdge(a, b);
    // start point must be outside box a's interior center region but near it
    assert.ok(Math.hypot(x - 25, y - 25) >= 25 - 1e-6, "start escaped a's center");
    const end = { x: x + points[1][0], y: y + points[1][1] };
    const bc = { x: b.x + 25, y: b.y + 25 };
    assert.ok(Math.hypot(end.x - bc.x, end.y - bc.y) >= 25 - 1e-6, "end stops before b's center");
  }
});

test("measureText/wrapText behave sanely", () => {
  const m = measureText("hello", 20);
  assert.ok(m.width > 0 && m.height >= 25);
  const wrapped = wrapText("one two three four five six", 10);
  for (const line of wrapped.split("\n")) assert.ok(line.length <= 10 || !line.includes(" "));
});
