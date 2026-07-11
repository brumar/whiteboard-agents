// Minimal offline Excalidraw viewer: renders a scene JSON through the real
// excalidraw renderer so agents can "see" the board without network access.
// window.__setScene lets a warm renderer swap the scene without a reload.
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

  // Replace the scene in place (warm renderer path). `focusIds` crops the
  // viewport to those elements (e.g. a frame and its children); `files` are
  // BinaryFileData ({id, mimeType, dataURL, created}) for image elements.
  window.__setScene = (rawElements, focusIds, files) => {
    let restored;
    try {
      restored = restoreElements(rawElements, null);
      window.__restoreError = null;
    } catch (err) {
      window.__restoreError = String(err);
      return -1;
    }
    if (files && files.length) {
      try {
        api.addFiles(files);
        window.__filesError = null;
      } catch (err) {
        window.__filesError = String(err);
      }
    }
    api.updateScene({ elements: restored });
    const focus = focusIds
      ? restored.filter((e) => focusIds.includes(e.id))
      : restored.filter((e) => !e.isDeleted);
    if (focus.length) api.scrollToContent(focus, { fitToContent: true });
    return restored.filter((e) => !e.isDeleted).length;
  };

  // live mode (host's /view page): follow the room over SSE, read-only
  if (window.__live || location.search.includes("live=1")) {
    let scrolled = false;
    const es = new EventSource("/events");
    es.onmessage = (ev) => {
      if (!api) return;
      const msg = JSON.parse(ev.data);
      if (msg.type === "scene") {
        try {
          const restored = restoreElements(msg.elements, null);
          api.updateScene({ elements: restored });
          if (!scrolled && restored.length) {
            api.scrollToContent(restored, { fitToContent: true });
            scrolled = true;
          }
        } catch (err) {
          window.__restoreError = String(err);
        }
      } else if (msg.type === "cursors") {
        api.updateScene({
          collaborators: new Map(
            msg.cursors.map((c) => [
              c.name,
              { username: c.name, pointer: { x: c.x, y: c.y, tool: "pointer" }, button: "up" },
            ]),
          ),
        });
      }
    };
  }

  // signal readiness for the screenshotter
  const wait = setInterval(() => {
    if (api && api.getSceneElements().length >= 0) {
      window.__ready = true;
      clearInterval(wait);
    }
  }, 200);
}

main();
