class PeerTable {
  constructor() {
    this.peers = new Map();
  }

  upsert(nodeId, ip, tcpPort) {
    const now = Date.now();
    const current = this.peers.get(nodeId);
    if (!current) {
      this.peers.set(nodeId, {
        node_id: nodeId,
        ip,
        tcp_port: tcpPort,
        last_seen: now,
        shared_files: [],
        reputation: 1.0,
      });
      return;
    }
    current.ip = ip;
    current.tcp_port = tcpPort;
    current.last_seen = now;
  }

  removeStale(timeoutSeconds) {
    const removed = [];
    const now = Date.now();
    for (const [nodeId, peer] of this.peers.entries()) {
      if ((now - peer.last_seen) / 1000 > timeoutSeconds) {
        removed.push(nodeId);
        this.peers.delete(nodeId);
      }
    }
    return removed;
  }

  rows() {
    return Array.from(this.peers.values()).sort((a, b) =>
      a.node_id.localeCompare(b.node_id)
    );
  }
}

module.exports = { PeerTable };

