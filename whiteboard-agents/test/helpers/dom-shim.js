// Minimal DOM shims so the browser-built @excalidraw/excalidraw bundle can be
// imported under Node (its module scope touches window/document/canvas/fonts).
// Import this before helpers/excalidraw.js.
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
  globalThis.location = { origin: "http://localhost", href: "http://localhost/", search: "", hash: "" };
  globalThis.devicePixelRatio = 1;
  globalThis.Element = class Element {};
  globalThis.HTMLElement = class HTMLElement extends globalThis.Element {};
  globalThis.Image = class Image {};
  globalThis.FontFace = class FontFace {
    constructor(family) {
      this.family = family;
    }
    load() {
      return Promise.resolve(this);
    }
  };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const ctx2d = {
    filter: "none",
    canvas: {},
    font: "",
    measureText: (t) => ({
      width: (t || "").length * 10,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
    save() {},
    restore() {},
    scale() {},
    translate() {},
    clearRect() {},
    fillRect() {},
    fillText() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
  };
  globalThis.document = {
    createElement: () => ({
      style: {},
      getContext: () => ctx2d,
      addEventListener() {},
      setAttribute() {},
      classList: { add() {}, remove() {} },
    }),
    documentElement: { style: {} },
    addEventListener() {},
    fonts: { add() {}, check: () => true, load: () => Promise.resolve([]) },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  if (!globalThis.navigator) globalThis.navigator = { userAgent: "node" };
}
