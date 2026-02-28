const dgram = require("dgram");

class DiscoveryService {
  constructor({ nodeId, tcpPort, multicastGroup = "239.255.42.99", multicastPort = 6000, helloInterval = 30 }) {
    this.nodeId = nodeId;
    this.tcpPort = tcpPort;
    this.multicastGroup = multicastGroup;
    this.multicastPort = multicastPort;
    this.helloInterval = helloInterval;
    this.recvSocket = null;
    this.sendSocket = null;
    this.helloTimer = null;
  }

  start(onHello) {
    this.recvSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.sendSocket = dgram.createSocket("udp4");

    this.recvSocket.on("message", (msg, rinfo) => {
      try {
        const payload = JSON.parse(msg.toString("utf8"));
        if (payload.type !== "HELLO") return;
        if (payload.node_id === this.nodeId) return;
        onHello(payload.node_id, rinfo.address, Number(payload.tcp_port));
      } catch (_) {
        return;
      }
    });

    this.recvSocket.bind(this.multicastPort, () => {
      this.recvSocket.addMembership(this.multicastGroup);
    });

    this.sendSocket.bind(0, () => {
      this.sendSocket.setMulticastTTL(1);
      this._sendHello();
      this.helloTimer = setInterval(() => this._sendHello(), this.helloInterval * 1000);
    });
  }

  stop() {
    if (this.helloTimer) clearInterval(this.helloTimer);
    if (this.recvSocket) this.recvSocket.close();
    if (this.sendSocket) this.sendSocket.close();
  }

  _sendHello() {
    const payload = Buffer.from(
      JSON.stringify({
        type: "HELLO",
        node_id: this.nodeId,
        tcp_port: this.tcpPort,
        timestamp: Math.floor(Date.now() / 1000),
      }),
      "utf8"
    );
    this.sendSocket.send(payload, this.multicastPort, this.multicastGroup);
  }
}

module.exports = { DiscoveryService };
