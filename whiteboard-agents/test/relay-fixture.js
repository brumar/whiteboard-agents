// Local socket.io server speaking the excalidraw-room protocol, so client and
// daemon tests run offline. Point clients at it via WB_WS_SERVER.
import http from "node:http";
import { Server } from "socket.io";

export async function startRelay() {
  const httpServer = http.createServer();
  const io = new Server(httpServer, {
    transports: ["websocket"],
    cors: { origin: "*" },
    maxHttpBufferSize: 10e6,
  });

  const roomOf = (socket) => [...socket.rooms].find((r) => r !== socket.id);

  io.on("connection", (socket) => {
    socket.emit("init-room");

    socket.on("join-room", async (roomID) => {
      await socket.join(roomID);
      const peers = await io.in(roomID).fetchSockets();
      if (peers.length <= 1) {
        socket.emit("first-in-room");
      } else {
        socket.broadcast.to(roomID).emit("new-user", socket.id);
      }
      io.in(roomID).emit(
        "room-user-change",
        peers.map((s) => s.id),
      );
    });

    socket.on("server-broadcast", (roomID, encryptedData, iv) => {
      socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
    });

    socket.on("server-volatile-broadcast", (roomID, encryptedData, iv) => {
      socket.volatile.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
    });

    socket.on("disconnecting", async () => {
      const roomID = roomOf(socket);
      if (!roomID) return;
      const peers = (await io.in(roomID).fetchSockets()).filter((s) => s.id !== socket.id);
      socket.broadcast.to(roomID).emit(
        "room-user-change",
        peers.map((s) => s.id),
      );
    });
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    io,
    close: () =>
      new Promise((resolve) => {
        io.close(() => resolve());
      }),
  };
}
