// Back-compat wrapper: `wb daemon` (one process per agent) now runs a
// single-agent room host. New code should use lib/roomhost.js directly —
// this wrapper will be removed a release after the skills stop using it.
import { runRoomHost } from "./roomhost.js";

export async function runDaemon(opts) {
  const { roomId, roomKey, agent, color, background, slot = 0, stateDir } = opts;
  return runRoomHost({
    roomId,
    roomKey,
    stateDir,
    agents: [{ name: agent, color, background, slot }],
  });
}
