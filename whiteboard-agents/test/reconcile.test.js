import test from "node:test";
import assert from "node:assert/strict";
import { ExcalidrawClient } from "../lib/client.js";

const makeClient = () => new ExcalidrawClient({ roomId: "r", roomKey: "k", username: "t" });
const el = (id, version, versionNonce = 1, extra = {}) => ({ id, version, versionNonce, ...extra });

test("higher remote version wins", () => {
  const c = makeClient();
  c.reconcile([el("a", 1, 5, { text: "old" })]);
  const changed = c.reconcile([el("a", 2, 1, { text: "new" })]);
  assert.equal(changed.length, 1);
  assert.equal(c.scene.get("a").text, "new");
});

test("lower remote version is ignored", () => {
  const c = makeClient();
  c.reconcile([el("a", 3, 5, { text: "current" })]);
  const changed = c.reconcile([el("a", 2, 9, { text: "stale" })]);
  assert.equal(changed.length, 0);
  assert.equal(c.scene.get("a").text, "current");
});

test("equal version: local kept when local.versionNonce <= remote.versionNonce", () => {
  const c = makeClient();
  c.reconcile([el("a", 2, 10, { text: "local" })]);
  // remote nonce higher -> local wins (excalidraw tie-break)
  assert.equal(c.reconcile([el("a", 2, 20, { text: "remote" })]).length, 0);
  assert.equal(c.scene.get("a").text, "local");
  // remote nonce lower -> remote wins
  assert.equal(c.reconcile([el("a", 2, 5, { text: "remote2" })]).length, 1);
  assert.equal(c.scene.get("a").text, "remote2");
});

test("equal version and equal nonce: local kept (idempotence)", () => {
  const c = makeClient();
  const e = el("a", 2, 10, { text: "same" });
  c.reconcile([e]);
  assert.equal(c.reconcile([{ ...e }]).length, 0);
});

test("reconcile is idempotent for whole scenes", () => {
  const c = makeClient();
  const scene = [el("a", 1), el("b", 4, 2, { isDeleted: true }), el("c", 2)];
  const first = c.reconcile(scene);
  assert.equal(first.length, 3);
  const second = c.reconcile(scene.map((e) => ({ ...e })));
  assert.equal(second.length, 0);
});

test("changed list contains exactly the accepted elements", () => {
  const c = makeClient();
  c.reconcile([el("a", 2, 1), el("b", 2, 1)]);
  const changed = c.reconcile([
    el("a", 3, 1, { text: "bump" }), // accepted: higher version
    el("b", 1, 1), // rejected: lower version
    el("c", 1, 1), // accepted: new element
  ]);
  assert.deepEqual(changed.map((e) => e.id).sort(), ["a", "c"]);
});

test("elements without id are skipped", () => {
  const c = makeClient();
  const changed = c.reconcile([null, {}, { version: 3 }, el("ok", 1)]);
  assert.deepEqual(changed.map((e) => e.id), ["ok"]);
  assert.equal(c.scene.size, 1);
});

test("getElements sorts by fractional index and can exclude deleted", () => {
  const c = makeClient();
  c.reconcile([
    el("b", 1, 1, { index: "a2" }),
    el("a", 1, 1, { index: "a1" }),
    el("gone", 1, 1, { index: "a0", isDeleted: true }),
  ]);
  assert.deepEqual(c.getElements().map((e) => e.id), ["gone", "a", "b"]);
  assert.deepEqual(c.getElements({ includeDeleted: false }).map((e) => e.id), ["a", "b"]);
});
