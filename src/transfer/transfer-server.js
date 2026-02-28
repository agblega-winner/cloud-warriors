// src/transfer/transfer-server.js
const net  = require('net');
const { loadChunk, hasChunk, getOwnedChunks } = require('./storage');

class TransferServer {
  constructor(port) {
    this.port   = port;
    this.server = null;
    // Manifests connus : file_id → manifest
    this.manifests = new Map();
  }

  // Enregistrer un manifest (pour pouvoir servir ses chunks)
  registerManifest(manifest) {
    this.manifests.set(manifest.file_id, manifest);
    console.log(
      `[transfer-server] Manifest enregistré : ${manifest.filename}`
    );
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const peer = `${socket.remoteAddress}:${socket.remotePort}`;
        let buffer = '';

        socket.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              this._handleMessage(msg, socket);
            } catch (_) {}
          }
        });

        socket.on('error', () => {});
        socket.on('close', () => {});
      });

      // handle listen errors (EADDRINUSE etc.) so the caller can catch them
      this.server.once('error', (err) => {
        reject(err);
      });

      this.server.listen(this.port + 1000, '0.0.0.0', () => {
        console.log(
          `[transfer-server] ✅ Écoute sur le port ${this.port + 1000}`
        );
        resolve();
      });
    });
  }

  _handleMessage(msg, socket) {
    if (msg.type === 'CHUNK_REQ') {
      this._handleChunkReq(msg, socket);
    } else if (msg.type === 'MANIFEST_REQ') {
      this._handleManifestReq(msg, socket);
    }
  }

  _handleChunkReq(msg, socket) {
    const { file_id, chunk_index } = msg;

    console.log(
      `[transfer-server] CHUNK_REQ reçu — ` +
      `file: ${file_id.slice(0,16)}... chunk: ${chunk_index}`
    );

    if (!hasChunk(file_id, chunk_index)) {
      // On n'a pas ce chunk
      const ack = JSON.stringify({
        type       : 'ACK',
        chunk_index: chunk_index,
        status     : 0x02, // NOT_FOUND
      }) + '\n';
      socket.write(ack);
      return;
    }

    // Lire et envoyer le chunk
    const chunkData = loadChunk(file_id, chunk_index);
    if (!chunkData) {
      const ack = JSON.stringify({
        type       : 'ACK',
        chunk_index: chunk_index,
        status     : 0x02,
      }) + '\n';
      socket.write(ack);
      return;
    }

    const response = JSON.stringify({
      type       : 'CHUNK_DATA',
      file_id    : file_id,
      chunk_index: chunk_index,
      data       : chunkData.toString('base64'),
    }) + '\n';

    socket.write(response);
    console.log(
      `[transfer-server] ✅ Chunk ${chunk_index} envoyé` +
      ` (${chunkData.length} bytes)`
    );
  }

  _handleManifestReq(msg, socket) {
    const manifest = this.manifests.get(msg.file_id);
    if (!manifest) {
      socket.write(JSON.stringify({ type: 'ERROR', reason: 'NOT_FOUND' }) + '\n');
      return;
    }
    socket.write(JSON.stringify({ type: 'MANIFEST', manifest }) + '\n');
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { TransferServer };