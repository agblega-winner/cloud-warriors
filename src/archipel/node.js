const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const { DiscoveryService } = require("./discovery");
const { PeerTable } = require("./peer_table");
const { TcpServer } = require("./tcp_server");
const { TYPE_PING, encodeTLV } = require("./protocol");

class Node {
  constructor({ tcpPort, nodeId, helloInterval = 30, staleTimeout = 90, keepaliveSeconds = 15 }) {
    this.tcpPort = tcpPort;
    this.nodeId = nodeId;
    this.helloInterval = helloInterval;
    this.staleTimeout = staleTimeout;
    this.keepaliveSeconds = keepaliveSeconds;
    this.peerTable = new PeerTable();
    this.peerConnections = new Map();
    this.discovery = new DiscoveryService({
      nodeId: this.nodeId,
      tcpPort: this.tcpPort,
      helloInterval: this.helloInterval,
    });
    this.tcpServer = new TcpServer({
      nodeId: this.nodeId,
      port: this.tcpPort,
      keepaliveSeconds: this.keepaliveSeconds,
    });
  }

  start() {
    this.tcpServer.start();
    this.discovery.start((nodeId, ip, tcpPort) => this._onHello(nodeId, ip, tcpPort));
    setInterval(() => this._cleanupStale(), 3000);
    setInterval(() => this._connectPeers(), 2000);
    setInterval(() => this._printPeerTable(), 10000);
    console.log(`[node] id=${this.nodeId.slice(0, 16)}... tcp=${this.tcpPort}`);
  }

  _onHello(nodeId, ip, tcpPort) {
    this.peerTable.upsert(nodeId, ip, tcpPort);
  }

  _cleanupStale() {
    const removed = this.peerTable.removeStale(this.staleTimeout);
    for (const nodeId of removed) {
      const socket = this.peerConnections.get(nodeId);
      if (socket) {
        socket.destroy();
        this.peerConnections.delete(nodeId);
      }
    }
  }

  _connectPeers() {
    for (const peer of this.peerTable.rows()) {
      if (this.peerConnections.has(peer.node_id)) continue;
      const socket = net.createConnection({ host: peer.ip, port: peer.tcp_port });
      socket.on("connect", () => {
        this.peerConnections.set(peer.node_id, socket);
        socket.write(
          encodeTLV(TYPE_PING, {
            ts: Math.floor(Date.now() / 1000),
            node_id: this.nodeId,
          })
        );
      });
      socket.on("error", () => {
        this.peerConnections.delete(peer.node_id);
      });
      socket.on("close", () => {
        this.peerConnections.delete(peer.node_id);
      });
    }
  }

  _printPeerTable() {
    console.log("\n[peer-table]");
    const rows = this.peerTable.rows();
    if (rows.length === 0) {
      console.log("  (empty)");
      return;
    }
    const now = Date.now();
    for (const p of rows) {
      const age = Math.floor((now - p.last_seen) / 1000);
      console.log(
        `  ${p.node_id.slice(0, 12)}... ${p.ip}:${p.tcp_port} last_seen=${age}s rep=${p.reputation.toFixed(1)}`
      );
    }
  }
}

function parseArgs(argv) {
  const args = {
    tcpPort: 7777,
    pubkey: null,
    helloInterval: 30,
    staleTimeout: 90,
    keepaliveSeconds: 15,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--tcp-port" && v) args.tcpPort = Number(v);
    if (k === "--pubkey" && v) args.pubkey = v;
    if (k === "--hello-interval" && v) args.helloInterval = Number(v);
    if (k === "--stale-timeout" && v) args.staleTimeout = Number(v);
    if (k === "--keepalive-seconds" && v) args.keepaliveSeconds = Number(v);
  }
  return args;
}

function loadNodeId(pubkeyPath) {
  if (pubkeyPath && fs.existsSync(pubkeyPath)) {
    const data = fs.readFileSync(pubkeyPath);
    return crypto.createHash("sha256").update(data).digest("hex");
  }
  const seed = `node-${process.pid}-${Date.now()}`;
  return crypto.createHash("sha256").update(seed).digest("hex");
}

function runFromCli() {
  const args = parseArgs(process.argv);
  const node = new Node({
    tcpPort: args.tcpPort,
    nodeId: loadNodeId(args.pubkey),
    helloInterval: args.helloInterval,
    staleTimeout: args.staleTimeout,
    keepaliveSeconds: args.keepaliveSeconds,
  });
  node.start();
}

module.exports = { Node, runFromCli };

