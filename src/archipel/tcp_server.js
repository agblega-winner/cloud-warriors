const net = require("net");
const { TYPE_PING, TYPE_PONG, encodeTLV, decodeTLV } = require("./protocol");

class TcpServer {
  constructor({ nodeId, host = "0.0.0.0", port, keepaliveSeconds = 15 }) {
    this.nodeId = nodeId;
    this.host = host;
    this.port = port;
    this.keepaliveSeconds = keepaliveSeconds;
    this.server = null;
  }

  start() {
    this.server = net.createServer((socket) => this._handleConnection(socket));
    this.server.maxConnections = 10;
    this.server.listen(this.port, this.host, () => {
      console.log(`[tcp] listening on ${this.host}:${this.port}`);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  _handleConnection(socket) {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[tcp] connection from (${peer})`);
    let buffer = Buffer.alloc(0);

    const keepalive = setInterval(() => {
      const packet = encodeTLV(TYPE_PING, {
        ts: Math.floor(Date.now() / 1000),
        node_id: this.nodeId,
      });
      socket.write(packet);
    }, this.keepaliveSeconds * 1000);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const len = buffer.readUInt32BE(1);
        const frameLen = 5 + len;
        if (buffer.length < frameLen) break;
        const frame = buffer.subarray(0, frameLen);
        buffer = buffer.subarray(frameLen);
        try {
          const { type, payload } = decodeTLV(frame);
          if (type === TYPE_PING) {
            socket.write(
              encodeTLV(TYPE_PONG, {
                ts: Math.floor(Date.now() / 1000),
                node_id: this.nodeId,
              })
            );
            continue;
          }
          if (type === TYPE_PONG) continue;
          console.log(`[tcp] msg type=0x${type.toString(16)} data=${JSON.stringify(payload)}`);
        } catch (_) {
          return;
        }
      }
    });

    const close = () => {
      clearInterval(keepalive);
      console.log(`[tcp] disconnected (${peer})`);
    };
    socket.on("close", close);
    socket.on("error", close);
  }
}

module.exports = { TcpServer };

