const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const { DiscoveryService } = require('./src/archipel/discovery');
const { loadOrCreateIdentity, generateIdentity } = require('./src/crypto/identity');
const {
  createHello,
  createHelloReply,
  computeSessionKey,
  createAuth,
  verifyAuth,
} = require('./src/crypto/handshake');
const {
  registerSession,
  sendMessage,
  receiveMessage,
} = require('./src/crypto/messenger');
const { trustOrVerify, increaseTrust, revoke } = require('./src/crypto/trust');

const { TransferServer } = require('./src/transfer/transfer-server');
const { chunkFile } = require('./src/transfer/chunker');
const { generateManifest, validateManifest } = require('./src/transfer/manifest');
const {
  initStorage,
  saveChunk,
  getMissingChunks,
} = require('./src/transfer/storage');
const { downloadFile } = require('./src/transfer/download-manager');

const TRUST_STORE_FILE = path.resolve(process.cwd(), 'trust-store.json');

function shortId(value) {
  return value ? `${value.slice(0, 8)}...` : 'n/a';
}

class NodeController extends EventEmitter {
  constructor(port = 7777) {
    super();
    this.port = port;
    this.basePort = port;
    this.peerTable = new Map();
    const identityPath = process.env.ARCHIPEL_IDENTITY_PATH
      ? path.resolve(process.env.ARCHIPEL_IDENTITY_PATH)
      : path.join(__dirname, 'identity.json');
    this.identity = loadOrCreateIdentity(identityPath);

    this.discoveryService = null;
    this.transferServer = null;

    this.peerIdentities = new Map();
    this.activeSessions = new Map();

    this.messageLog = [];
    this.transferHistory = [];
    this.manifests = new Map();

    initStorage();
  }

  log(message) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const line = `[${timestamp}] ${message}`;
    console.log(line);
    this.emit('log', line);
  }

  _emitError(err) {
    const message = err instanceof Error ? err.message : String(err);
    this.emit('error', message);
    return message;
  }

  _buildPeerIdentity(peerId) {
    if (this.peerIdentities.has(peerId)) {
      return this.peerIdentities.get(peerId);
    }

    const generated = generateIdentity();
    generated.nodeId = peerId;
    this.peerIdentities.set(peerId, generated);
    return generated;
  }

  _normalizePeer(input) {
    const peer = { ...input };

    if (!peer.nodeId && peer.publicKey) {
      peer.nodeId = crypto
        .createHash('sha256')
        .update(Buffer.from(peer.publicKey, 'base64'))
        .digest('hex')
        .slice(0, 16);
    }

    if (!peer.nodeId) {
      throw new Error('nodeId requis pour enregistrer un pair');
    }

    peer.ip = peer.ip || '127.0.0.1';
    peer.port = Number(peer.port || this.basePort);
    peer.apiPort = Number(peer.apiPort || 3000);
    peer.reputation = Number.isFinite(peer.reputation) ? Number(peer.reputation) : 1;
    peer.lastSeen = Date.now();

    return peer;
  }

  _upsertPeer(input) {
    const normalized = this._normalizePeer(input);
    const current = this.peerTable.get(normalized.nodeId) || {};

    if (normalized.publicKey) {
      const trustResult = trustOrVerify(normalized.nodeId, normalized.publicKey);
      if (!trustResult.trusted) {
        throw new Error(`Pair ${shortId(normalized.nodeId)} rejeté: ${trustResult.reason || 'non fiable'}`);
      }
    }

    const peer = {
      ...current,
      ...normalized,
    };

    this.peerTable.set(peer.nodeId, peer);
    this.emit('peers-updated', this.getPeerTable());
    return peer;
  }

  addPeer(input) {
    const peer = this._upsertPeer(input);
    this.log(`➕ Pair enregistré: ${shortId(peer.nodeId)} @ ${peer.ip}:${peer.port}`);
    return peer;
  }

  removePeer(nodeId) {
    const removed = this.peerTable.delete(nodeId);
    if (removed) {
      this.emit('peers-updated', this.getPeerTable());
      this.log(`🗑️ Pair supprimé: ${shortId(nodeId)}`);
    }
    return removed;
  }

  async startDiscovery(options = {}) {
    const port = Number(options.port || this.basePort);
    const waitMs = Number(options.waitMs || 1800);

    try {
      if (this.discoveryService) {
        this.discoveryService.stop();
      }

      this.discoveryService = new DiscoveryService({
        nodeId: this.identity.nodeId,
        tcpPort: port,
      });

      this.discoveryService.start((nodeId, ip, tcpPort) => {
        try {
          this._upsertPeer({ nodeId, ip, port: tcpPort, apiPort: 3000 });
        } catch (err) {
          this._emitError(err);
        }
      });

      this.log(`🔍 Découverte UDP active sur 239.255.42.99:6000 (TCP ${port})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.log(`✅ Découverte terminée: ${this.peerTable.size} pair(s)`);

      return this.getPeerTable();
    } catch (err) {
      this.log(`❌ Erreur découverte: ${err.message}`);
      this._emitError(err);
      throw err;
    }
  }

  _deriveDeterministicSessionKey(peerPublicKey) {
    const mine = Buffer.from(this.identity.publicKey, 'base64');
    const theirs = Buffer.from(peerPublicKey, 'base64');
    const sorted = [mine, theirs].sort(Buffer.compare);
    const seed = Buffer.concat(sorted);
    return crypto.createHash('sha256').update(seed).digest();
  }

  _ensureSession(peerId, options = {}) {
    if (this.activeSessions.has(peerId)) {
      return this.activeSessions.get(peerId);
    }

    const peer = this.peerTable.get(peerId);
    if (!peer) {
      throw new Error(`Pair ${shortId(peerId)} inconnu`);
    }

    let mode = 'handshake-local';
    const peerIdentity = this._buildPeerIdentity(peerId);
    if (!peer.publicKey && options.peerPublicKey) {
      peer.publicKey = options.peerPublicKey;
    }
    if (!peer.publicKey) {
      peer.publicKey = peerIdentity.publicKey;
      this.peerTable.set(peerId, peer);
      trustOrVerify(peerId, peer.publicKey);
    }

    let sessionKey;
    if (peer.publicKey) {
      mode = 'deterministic-lan';
      sessionKey = this._deriveDeterministicSessionKey(peer.publicKey);
    } else {
      const { hello, myEphemeralPrivKey } = createHello(this.identity.nodeId);
      const { reply, sessionKey: peerSessionKey } = createHelloReply(hello, peerIdentity);
      const mySessionKey = computeSessionKey(myEphemeralPrivKey, reply.ephemeralPubKey);
      const auth = createAuth(mySessionKey, this.identity);
      const authResult = verifyAuth(auth, peerSessionKey);

      if (!authResult) {
        throw new Error(`Handshake échoué avec ${shortId(peerId)}`);
      }
      sessionKey = mySessionKey;
    }

    registerSession(peerId, sessionKey);
    registerSession(this.identity.nodeId, sessionKey);

    const session = {
      peerId,
      establishedAt: Date.now(),
      mode,
      cipher: 'AES-256-GCM',
      kex: 'X25519',
      signature: 'Ed25519',
    };

    this.activeSessions.set(peerId, session);
    this.log(`🔐 Session sécurisée établie avec ${shortId(peerId)}`);
    return session;
  }

  async sendEncryptedMessage(peerId, content) {
    try {
      const peer = this.peerTable.get(peerId);
      if (!peer) {
        throw new Error(`Pair ${shortId(peerId)} inconnu`);
      }

      this._ensureSession(peerId);
      const packet = sendMessage(peerId, content, this.identity);

      if (!packet) {
        throw new Error('Création du paquet chiffré échouée');
      }

      const msg = {
        id: `${packet.from}-${packet.seq}`,
        from: packet.from,
        to: packet.to,
        content,
        encryptedPreview: packet.payload.encrypted.slice(0, 42),
        timestamp: new Date(packet.timestamp).toISOString(),
        status: 'sent',
      };

      this.messageLog.push(msg);
      this.emit('message-sent', msg);
      this.log(`📤 Message chiffré envoyé vers ${shortId(peerId)}`);

      if (peer.apiPort && peer.ip && peer.nodeId !== this.identity.nodeId) {
        try {
          await this._postJson(
            `http://${peer.ip}:${peer.apiPort}/api/incoming-packet`,
            {
              packet,
              senderPublicKey: this.identity.publicKey,
              senderNodeId: this.identity.nodeId,
              senderTcpPort: this.basePort,
            }
          );
          msg.delivery = 'network-ok';
          this.log(`🌐 Livraison inter-PC réussie vers ${peer.ip}:${peer.apiPort}`);
        } catch (netErr) {
          msg.delivery = `network-failed: ${netErr.message}`;
          this.log(`⚠️ Livraison inter-PC échouée vers ${peer.ip}:${peer.apiPort}: ${netErr.message}`);
        }
      } else {
        msg.delivery = 'local-only';
      }

      return msg;
    } catch (err) {
      this.log(`❌ Erreur message: ${err.message}`);
      this._emitError(err);
      throw err;
    }
  }

  receiveMessage(fromPeerId, content) {
    try {
      this._ensureSession(fromPeerId);
      const peerIdentity = this._buildPeerIdentity(fromPeerId);

      const incomingPacket = sendMessage(this.identity.nodeId, content, peerIdentity);
      if (!incomingPacket) {
        throw new Error('Impossible de simuler la réception du paquet');
      }

      const plaintext = receiveMessage(incomingPacket, peerIdentity.publicKey);
      if (!plaintext) {
        throw new Error('Déchiffrement ou vérification du message échoué');
      }

      const msg = {
        id: `${incomingPacket.from}-${incomingPacket.seq}`,
        from: fromPeerId,
        to: this.identity.nodeId,
        content: plaintext,
        timestamp: new Date(incomingPacket.timestamp).toISOString(),
        status: 'received',
      };

      this.messageLog.push(msg);
      this.emit('message-received', msg);
      this.log(`📨 Message reçu de ${shortId(fromPeerId)}`);
      return msg;
    } catch (err) {
      this.log(`❌ Erreur réception: ${err.message}`);
      this._emitError(err);
      throw err;
    }
  }

  receiveNetworkPacket(packet, senderPublicKey, senderMeta = {}) {
    try {
      if (!packet || !packet.from || !senderPublicKey) {
        throw new Error('Paquet réseau invalide');
      }

      const trust = trustOrVerify(packet.from, senderPublicKey);
      if (!trust.trusted) {
        throw new Error(`Pair non fiable (${trust.reason || 'trust failed'})`);
      }

      this._upsertPeer({
        nodeId: packet.from,
        publicKey: senderPublicKey,
        ip: senderMeta.ip || this.peerTable.get(packet.from)?.ip || '127.0.0.1',
        port: senderMeta.tcpPort || this.peerTable.get(packet.from)?.port || this.basePort,
        apiPort: senderMeta.apiPort || this.peerTable.get(packet.from)?.apiPort || 3000,
      });

      this._ensureSession(packet.from, { peerPublicKey: senderPublicKey });
      const plaintext = receiveMessage(packet, senderPublicKey);
      if (!plaintext) {
        throw new Error('Vérification cryptographique échouée');
      }

      const msg = {
        id: `${packet.from}-${packet.seq}`,
        from: packet.from,
        to: this.identity.nodeId,
        content: plaintext,
        timestamp: new Date(packet.timestamp).toISOString(),
        status: 'received-network',
      };

      this.messageLog.push(msg);
      this.emit('message-received', msg);
      this.log(`📨 Message réseau reçu de ${shortId(packet.from)}`);
      return msg;
    } catch (err) {
      this.log(`❌ Erreur paquet réseau: ${err.message}`);
      this._emitError(err);
      throw err;
    }
  }

  getMessageLog() {
    return this.messageLog;
  }

  _postJson(target, payload, timeoutMs = 6000) {
    const url = new URL(target);
    const body = JSON.stringify(payload);
    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString('utf8');
          });
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (_) {
              resolve({});
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('Timeout HTTP'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async startTransferServer(options = {}) {
    try {
      const port = Number(options.port || this.basePort);

      if (this.transferServer) {
        return { port: port + 1000 };
      }

      this.transferServer = new TransferServer(port);
      await this.transferServer.start();

      const info = { port: port + 1000 };
      this.emit('transfer-server-started', info);
      this.log(`📡 Serveur transfert actif sur ${info.port}`);
      return info;
    } catch (err) {
      this.log(`❌ Erreur serveur transfert: ${err.message}`);
      this._emitError(err);
      throw err;
    }
  }

  async startFileTransfer(filePath, peerId) {
    try {
      const peer = this.peerTable.get(peerId);
      if (!peer) {
        throw new Error(`Pair ${shortId(peerId)} inconnu`);
      }
      if (!fs.existsSync(filePath)) {
        throw new Error(`Fichier non trouvé: ${filePath}`);
      }

      await this.startTransferServer({ port: this.basePort });

      const fileInfo = chunkFile(filePath);
      const manifest = generateManifest(fileInfo, this.identity);
      if (!validateManifest(manifest)) {
        throw new Error('Manifest local invalide après signature');
      }

      const transfer = {
        id: manifest.file_id.slice(0, 12),
        fileName: manifest.filename,
        filePath,
        fileId: manifest.file_id,
        peerId,
        fileSize: manifest.size,
        transferred: 0,
        percent: 0,
        status: 'in-progress',
        startTime: Date.now(),
      };

      this.transferHistory.push(transfer);
      this.emit('transfer-started', transfer);

      for (const chunk of fileInfo.chunks) {
        saveChunk(manifest.file_id, chunk.index, chunk.data, chunk.hash);
        transfer.transferred += chunk.size;
        transfer.percent = Math.min(100, Math.floor((transfer.transferred / transfer.fileSize) * 100));
        this.emit('transfer-progress', { ...transfer });
      }

      this.transferServer.registerManifest(manifest);
      this.manifests.set(manifest.file_id, manifest);

      transfer.status = 'ready';
      transfer.percent = 100;
      transfer.endTime = Date.now();
      this.emit('transfer-completed', transfer);
      this.log(`📦 Transfert préparé: ${manifest.filename} (${manifest.nb_chunks} chunks)`);

      return { transfer, manifest };
    } catch (err) {
      this.log(`❌ Erreur transfert: ${err.message}`);
      this._emitError(err);
      throw err;
    }
  }

  fetchManifestFromPeer(peerId, fileId) {
    const peer = this.peerTable.get(peerId);
    if (!peer) {
      throw new Error(`Pair ${shortId(peerId)} inconnu`);
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(
        { host: peer.ip, port: peer.port + 1000 },
        () => {
          socket.write(JSON.stringify({ type: 'MANIFEST_REQ', file_id: fileId }) + '\n');
        }
      );

      let buffer = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Timeout récupération manifest'));
      }, 5000);

      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'MANIFEST') {
              clearTimeout(timeout);
              socket.destroy();
              resolve(msg.manifest);
              return;
            }
          } catch (_) {}
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async downloadFromPeer(peerId, fileId, outputPath) {
    try {
      const peer = this.peerTable.get(peerId);
      if (!peer) {
        throw new Error(`Pair ${shortId(peerId)} inconnu`);
      }

      const manifest = await this.fetchManifestFromPeer(peerId, fileId);
      if (!manifest || !validateManifest(manifest)) {
        throw new Error('Manifest reçu invalide');
      }

      const transfer = {
        id: manifest.file_id.slice(0, 12),
        fileName: manifest.filename,
        filePath: outputPath,
        fileId: manifest.file_id,
        peerId,
        fileSize: manifest.size,
        transferred: 0,
        percent: 0,
        status: 'downloading',
        startTime: Date.now(),
      };

      this.transferHistory.push(transfer);
      this.emit('transfer-started', transfer);

      const poll = setInterval(() => {
        const missing = getMissingChunks(manifest.file_id, manifest.nb_chunks).length;
        const received = manifest.nb_chunks - missing;
        transfer.percent = Math.min(100, Math.floor((received / manifest.nb_chunks) * 100));
        transfer.transferred = Math.floor((transfer.percent / 100) * transfer.fileSize);
        this.emit('transfer-progress', { ...transfer });
      }, 300);

      await downloadFile(
        manifest,
        [{ nodeId: manifest.sender_id, ip: peer.ip, port: peer.port + 1000, reputation: peer.reputation || 1 }],
        outputPath
      );

      clearInterval(poll);
      transfer.status = 'completed';
      transfer.percent = 100;
      transfer.transferred = transfer.fileSize;
      transfer.endTime = Date.now();
      this.emit('transfer-completed', transfer);
      this.log(`✅ Téléchargement terminé: ${outputPath}`);
      return { transfer, manifest };
    } catch (err) {
      this.log(`❌ Erreur téléchargement: ${err.message}`);
      this._emitError(err);
      throw err;
    }
  }

  getTransferHistory() {
    return this.transferHistory;
  }

  getManifests() {
    return Array.from(this.manifests.values());
  }

  getPeerTable() {
    return Array.from(this.peerTable.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  getTrustStore() {
    try {
      if (!fs.existsSync(TRUST_STORE_FILE)) {
        return [];
      }

      const data = JSON.parse(fs.readFileSync(TRUST_STORE_FILE, 'utf8'));
      return Object.entries(data).map(([nodeId, entry]) => ({ nodeId, ...entry }));
    } catch (err) {
      this._emitError(err);
      return [];
    }
  }

  certifyPeer(nodeId) {
    increaseTrust(nodeId, 0.2);
    const peer = this.peerTable.get(nodeId);
    if (peer) {
      peer.reputation = Math.min(2, (peer.reputation || 1) + 0.2);
      this.peerTable.set(nodeId, peer);
      this.emit('peers-updated', this.getPeerTable());
    }
    this.log(`✅ Pair certifié: ${shortId(nodeId)}`);
    return this.getTrustStore();
  }

  revokePeer(nodeId) {
    revoke(nodeId);
    const peer = this.peerTable.get(nodeId);
    if (peer) {
      peer.reputation = 0;
      this.peerTable.set(nodeId, peer);
      this.emit('peers-updated', this.getPeerTable());
    }
    this.log(`🔴 Pair révoqué: ${shortId(nodeId)}`);
    return this.getTrustStore();
  }

  getCryptoState() {
    return {
      identity: this.getIdentity(),
      sessions: Array.from(this.activeSessions.values()),
      trust: this.getTrustStore(),
      algorithms: {
        cipher: 'AES-256-GCM',
        keyExchange: 'X25519',
        signature: 'Ed25519',
        integrity: 'HMAC-SHA256',
      },
    };
  }

  getIdentity() {
    if (!this.identity) return null;

    return {
      nodeId: this.identity.nodeId,
      publicKey: this.identity.publicKey,
      publicKeyPreview: `${this.identity.publicKey.slice(0, 32)}...`,
    };
  }

  async stopAll() {
    try {
      if (this.transferServer) {
        this.transferServer.stop();
        this.transferServer = null;
      }

      if (this.discoveryService) {
        this.discoveryService.stop();
        this.discoveryService = null;
      }

      this.emit('shutdown');
    } catch (err) {
      this._emitError(err);
    }
  }
}

module.exports = { NodeController };
