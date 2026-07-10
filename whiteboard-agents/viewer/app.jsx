// Minimal offline Excalidraw viewer: renders a scene JSON through the real
// excalidraw renderer so agents can "see" the board without network access.
import React from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

window.EXCALIDRAW_ASSET_PATH = "/assets/";

async function main() {
  const res = await fetch("/scene.json");
  const raw = await res.json();
  let elements;
  try {
    elements = restoreElements(raw.elements, null);
    window.__restoreError = null;
  } catch (err) {
    window.__restoreError = String(err);
    elements = [];
  }
  const root = createRoot(document.getElementById("root"));
  let api = null;
  root.render(
    <div style={{ width: "100vw", height: "100vh" }}>
      <Excalidraw
        excalidrawAPI={(a) => {
          api = a;
          window.__api = a;
        }}
        initialData={{ elements, appState: { viewBackgroundColor: "#ffffff" }, scrollToContent: true }}
        viewModeEnabled
      />
    </div>,
  );
  // signal readiness for the screenshotter
  const wait = setInterval(() => {
    if (api && api.getSceneElements().length >= 0) {
      window.__ready = true;
      clearInterval(wait);
    }
  }, 200);
}

main();
