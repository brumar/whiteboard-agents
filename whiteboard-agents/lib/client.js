// Headless Excalidraw live-collab client.
// Speaks the excalidraw-room socket.io protocol with E2E room encryption.
import { EventEmitter } from "node:events";
import { io } from "socket.io-client";
import { encryptPayload, decryptPayload } from "./crypto.js";

export const WS_SERVER_URL = process.env.WB_WS_SERVER || "https://oss-collab.excalidraw.com";

const WS_EVENTS = {
  SERVER: "server-broadcast",
  SERVER_VOLATILE: "server-volatile-broadcast",
};

export class ExcalidrawClient extends EventEmitter {
  constructor({ roomId, roomKey, username, scene, sceneReadOnly = false }) {
    super();
    this.roomId = roomId;
    this.roomKey = roomKey;
    this.username = username || "agent";
    this.socket = null;
    this.initialized = false;
    // scene: Map<elementId, element> — reconciled view of the board.
    // Injectable so several sockets (one per agent identity) can share one
    // store; read-only sockets skip scene decryption entirely (the shared
    // store is fed by exactly one primary socket).
    this.scene = scene || new Map();
    this.sceneReadOnly = sceneReadOnly;
    this.collaborators = new Set();
  }

  // Promote a read-only socket to scene processing (used when the previous
  // primary socket of a shared scene detaches).
  setSceneReadOnly(readOnly) {
    this.sceneReadOnly = readOnly;
  }

  connect() {
    return new Promise((resolve, reject) => {
      // websocket only: the relay's polling transport sits behind a
      // load balancer without session affinity, so long-polling breaks.
      const socket = io(WS_SERVER_URL, {
        transports: ["websocket"],
        timeout: 20000,
        // the relay validates Origin against excalidraw.com
        extraHeaders: { Origin: "https://excalidraw.com" },
      });
      this.socket = socket;

      let connectErrors = 0;
      socket.on("connect_error", (err) => {
        this.emit("connect-error", err);
        if (++connectErrors >= 5) {
          socket.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      socket.on("init-room", () => {
        socket.emit("join-room", this.roomId);
      });

      socket.on("first-in-room", () => {
        this.initialized = true;
        this.emit("first-in-room");
        resolve({ firstInRoom: true });
      });

      socket.on("new-user", () => {
        // A collaborator just joined: send them the full scene we know.
        // Read-only sockets stay quiet — their primary answers for the room.
        if (!this.sceneReadOnly) this.broadcastScene("SCENE_INIT", this.getElements(), true);
        this.emit("new-user");
      });

      socket.on("room-user-change", (clients) => {
        this.collaborators = new Set(clients);
        // read-only sockets have no SCENE_INIT to wait for — joining is enough
        if (this.sceneReadOnly && !this.initialized) {
          this.initialized = true;
          resolve({ firstInRoom: false, sceneReadOnly: true });
        }
        this.emit("room-user-change", clients);
      });

      socket.on("client-broadcast", async (encryptedData, iv) => {
        if (this.sceneReadOnly) return; // primary socket handles scene traffic
        let data;
        try {
          data = await decryptPayload(this.roomKey, encryptedData, iv);
        } catch (err) {
          this.emit("decrypt-error", err);
          return;
        }
        switch (data.type) {
          case "SCENE_INIT":
          case "SCENE_UPDATE": {
            const changed = this.reconcile(data.payload.elements || []);
            if (!this.initialized) {
              this.initialized = true;
              resolve({ firstInRoom: false });
            }
            if (changed.length) this.emit("scene-changed", changed, data.type);
            break;
          }
          case "MOUSE_LOCATION":
            this.emit("pointer", data.payload);
            break;
          case "IDLE_STATUS":
            this.emit("idle-status", data.payload);
            break;
          default:
            this.emit("message", data);
        }
      });

      socket.on("disconnect", (reason) => this.emit("disconnect", reason));

      // If nobody else is online we never get SCENE_INIT nor first-in-room
      // fast enough; resolve after a grace period — persistence fills the gap.
      setTimeout(() => {
        if (!this.initialized) {
          this.initialized = true;
          resolve({ firstInRoom: null, timedOut: true });
        }
      }, 5000);
    });
  }

  // Merge remote elements into the local scene; higher version wins,
  // versionNonce breaks ties (mirrors excalidraw's reconciliation).
  reconcile(remoteElements) {
    const changed = [];
    for (const el of remoteElements) {
      if (!el || !el.id) continue;
      const local = this.scene.get(el.id);
      const keepLocal =
        local &&
        (local.version > el.version ||
          (local.version === el.version && local.versionNonce <= el.versionNonce));
      if (!keepLocal) {
        this.scene.set(el.id, el);
        changed.push(el);
      }
    }
    return changed;
  }

  getElements({ includeDeleted = true } = {}) {
    const els = [...this.scene.values()];
    const live = includeDeleted ? els : els.filter((e) => !e.isDeleted);
    return live.sort((a, b) =>
      (a.index || "") < (b.index || "") ? -1 : (a.index || "") > (b.index || "") ? 1 : 0,
    );
  }

  async _broadcast(data, volatile = false) {
    const socket = this.socket;
    if (!socket?.connected) return;
    const { encryptedBuffer, iv } = await encryptPayload(this.roomKey, JSON.stringify(data));
    // close() may have run while we were encrypting
    if (this.socket !== socket || !socket.connected) return;
    socket.emit(
      volatile ? WS_EVENTS.SERVER_VOLATILE : WS_EVENTS.SERVER,
      this.roomId,
      encryptedBuffer,
      iv,
    );
  }

  // Add/update elements: reconcile locally then broadcast just those elements.
  async syncElements(elements) {
    this.reconcile(elements);
    await this.broadcastScene("SCENE_UPDATE", elements, true);
  }

  async broadcastScene(type, elements, _syncAll) {
    await this._broadcast({ type, payload: { elements } });
  }

  async sendCursor(x, y, { button = "up", selectedElementIds = {} } = {}) {
    if (!this.socket?.id) return;
    await this._broadcast(
      {
        type: "MOUSE_LOCATION",
        payload: {
          socketId: this.socket.id,
          pointer: { x, y, tool: "pointer" },
          button,
          selectedElementIds,
          username: this.username,
        },
      },
      true,
    );
  }

  async sendIdleStatus(userState = "active") {
    if (!this.socket?.id) return;
    await this._broadcast(
      {
        type: "IDLE_STATUS",
        payload: { socketId: this.socket.id, userState, username: this.username },
      },
      true,
    );
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}
