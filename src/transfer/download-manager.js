// src/transfer/download-manager.js
const net    = require('net');
const crypto = require('crypto');
const { saveChunk, getMissingChunks,
        getOwnedChunks, hasChunk }  = require('./storage');
const { reassembleFile }            = require('./chunker');
const { STORAGE_DIR }               = require('./storage');

const PARALLEL_CONNECTIONS = 3;   // connexions TCP simultanées
const CHUNK_TIMEOUT_MS     = 8000; // 8s avant de considérer un chunk perdu
const MAX_RETRIES          = 3;    // tentatives max par chunk

// ── Télécharger un fichier depuis les pairs disponibles ─────────────────────
async function downloadFile(manifest, peers, outputPath) {
  console.log(`\n[download] 🚀 Début téléchargement : ${manifest.filename}`);
  console.log(`[download]    ${manifest.nb_chunks} chunks depuis ${peers.length} pairs`);

  // État global du téléchargement
  const needed      = new Set(getMissingChunks(manifest.file_id, manifest.nb_chunks));
  const inProgress  = new Map(); // chunkIdx → { peer, startTime, retries }
  const chunkPeers  = buildChunkPeerMap(manifest, peers);

  let downloaded = 0;
  const total    = manifest.nb_chunks;

  return new Promise((resolve, reject) => {
    // ── Lancer N workers parallèles ─────────────────────────────────────────
    const workers = Array.from(
      { length: PARALLEL_CONNECTIONS },
      (_, i) => runWorker(i, manifest, peers, chunkPeers, needed,
                          inProgress, () => {
                            downloaded++;
                            printProgress(downloaded, total, manifest.filename);
                          })
    );

    // ── Surveiller la complétion ─────────────────────────────────────────────
    const checkDone = setInterval(async () => {
      // Gérer les timeouts — chunks en cours depuis trop longtemps
      const now = Date.now();
      for (const [chunkIdx, info] of inProgress.entries()) {
        if (now - info.startTime > CHUNK_TIMEOUT_MS) {
          console.warn(`[download] ⏱️  Timeout chunk ${chunkIdx} — re-planifié`);
          inProgress.delete(chunkIdx);
          if (info.retries < MAX_RETRIES) {
            needed.add(chunkIdx); // remettre dans la file
          } else {
            console.error(`[download] ❌ Chunk ${chunkIdx} abandonné après ${MAX_RETRIES} tentatives`);
          }
        }
      }

      // Vérifier si tout est téléchargé
      const missing = getMissingChunks(manifest.file_id, manifest.nb_chunks);
      if (missing.length === 0 && inProgress.size === 0) {
        clearInterval(checkDone);

        console.log(`\n[download] ✅ Tous les chunks reçus — réassemblage...`);
        try {
          const finalHash = reassembleFile(
            manifest.file_id,
            manifest.nb_chunks,
            outputPath,
            STORAGE_DIR
          );

          if (finalHash === manifest.file_id) {
            console.log(`[download] ✅ SHA-256 VÉRIFIÉ — fichier intègre`);
            console.log(`[download] 📁 Sauvegardé : ${outputPath}`);
            resolve(finalHash);
          } else {
            console.error(`[download] ❌ SHA-256 FINAL INCORRECT`);
            reject(new Error('Corruption fichier final'));
          }
        } catch (err) {
          reject(err);
        }
      }
    }, 500);
  });
}

// ── Worker : boucle de téléchargement d'un thread parallèle ─────────────────
async function runWorker(workerId, manifest, peers, chunkPeers,
                         needed, inProgress, onChunkDone) {
  while (true) {
    // Choisir le prochain chunk à télécharger (Rarest First)
    const chunkIdx = pickRarestChunk(needed, inProgress, chunkPeers);

    if (chunkIdx === null) {
      // Plus rien à faire pour l'instant
      await sleep(300);
      continue;
    }

    // Marquer comme en cours
    const retries = inProgress.has(chunkIdx)
      ? (inProgress.get(chunkIdx).retries || 0)
      : 0;

    // Choisir un pair qui a ce chunk
    const peer = choosePeer(chunkIdx, chunkPeers, peers);
    if (!peer) {
      await sleep(500);
      continue;
    }

    inProgress.set(chunkIdx, {
      peer,
      startTime: Date.now(),
      retries,
    });
    needed.delete(chunkIdx);

    // Télécharger le chunk
    try {
      const data = await requestChunkFromPeer(
        peer,
        manifest.file_id,
        chunkIdx,
        manifest.chunks[chunkIdx].hash
      );

      if (data) {
        inProgress.delete(chunkIdx);
        onChunkDone();
        // Ce nœud partage maintenant ce chunk aux autres
        addLocalChunkToPeerMap(chunkPeers, chunkIdx, 'local');
      } else {
        // Chunk corrompu ou refusé → re-tenter avec un autre pair
        console.warn(`[worker-${workerId}] ⚠️  Chunk ${chunkIdx} invalide → re-planifié`);
        inProgress.delete(chunkIdx);
        needed.add(chunkIdx);
      }
    } catch (err) {
      // Pair mort → le chunk retourne dans la file
      console.warn(`[worker-${workerId}] Pair ${peer.ip}:${peer.port} mort`);
      inProgress.delete(chunkIdx);
      needed.add(chunkIdx);
      // Retirer ce pair de la map pour ce chunk
      removeDeadPeer(chunkPeers, chunkIdx, peer);
    }
  }
}

// ── Algorithme Rarest First ──────────────────────────────────────────────────
// Choisir le chunk disponible chez le moins de pairs
function pickRarestChunk(needed, inProgress, chunkPeers) {
  let rarestIdx   = null;
  let rarestCount = Infinity;

  for (const chunkIdx of needed) {
    if (inProgress.has(chunkIdx)) continue;

    const availablePeers = (chunkPeers.get(chunkIdx) || []).length;
    if (availablePeers > 0 && availablePeers < rarestCount) {
      rarestCount = availablePeers;
      rarestIdx   = chunkIdx;
    }
  }

  return rarestIdx;
}

// ── Choisir le meilleur pair pour un chunk ──────────────────────────────────
function choosePeer(chunkIdx, chunkPeers, peers) {
  const available = chunkPeers.get(chunkIdx) || [];
  if (available.length === 0) return null;

  // Choisir le pair avec la meilleure réputation
  const ranked = available
    .map(peerId => peers.find(p => p.nodeId === peerId))
    .filter(Boolean)
    .sort((a, b) => (b.reputation || 1) - (a.reputation || 1));

  return ranked[0] || null;
}

// ── Demander un chunk à un pair via TCP ─────────────────────────────────────
function requestChunkFromPeer(peer, fileId, chunkIndex, expectedHash) {
  return new Promise((resolve) => {
    const socket = net.createConnection(
      { host: peer.ip, port: peer.port },
      () => {
        // Envoyer CHUNK_REQ
        const req = JSON.stringify({
          type       : 'CHUNK_REQ',
          file_id    : fileId,
          chunk_index: chunkIndex,
        }) + '\n';

        socket.write(req);
      }
    );

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Les messages sont délimités par \n
      const lines = buffer.split('\n');
      buffer = lines.pop(); // garder le fragment incomplet

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          if (msg.type === 'CHUNK_DATA' && msg.chunk_index === chunkIndex) {
            socket.destroy();
            const chunkData = Buffer.from(msg.data, 'base64');

            // Vérifier SHA-256
            const actualHash = crypto
              .createHash('sha256')
              .update(chunkData)
              .digest('hex');

            if (actualHash !== expectedHash) {
              console.error(
                `[download] ❌ Hash mismatch chunk ${chunkIndex}`
              );
              resolve(null);
              return;
            }

            // Sauvegarder sur disque
            const ok = saveChunk(fileId, chunkIndex, chunkData, expectedHash);
            resolve(ok ? chunkData : null);
          }

          if (msg.type === 'ACK' && msg.status !== 0x00) {
            socket.destroy();
            resolve(null);
          }
        } catch (_) {}
      }
    });

    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
    socket.setTimeout(CHUNK_TIMEOUT_MS);
  });
}

// ── Construire la map chunkIdx → [nodeIds qui ont ce chunk] ─────────────────
function buildChunkPeerMap(manifest, peers) {
  const map = new Map();

  // Au départ : la source a TOUS les chunks
  for (let i = 0; i < manifest.nb_chunks; i++) {
    map.set(i, [manifest.sender_id]);
  }

  // Ajouter les chunks que nos pairs annoncent avoir
  for (const peer of peers) {
    if (peer.sharedFiles) {
      for (const chunkIdx of (peer.ownedChunks || [])) {
        if (!map.has(chunkIdx)) map.set(chunkIdx, []);
        map.get(chunkIdx).push(peer.nodeId);
      }
    }
  }

  return map;
}

function addLocalChunkToPeerMap(chunkPeers, chunkIdx, nodeId) {
  if (!chunkPeers.has(chunkIdx)) chunkPeers.set(chunkIdx, []);
  if (!chunkPeers.get(chunkIdx).includes(nodeId)) {
    chunkPeers.get(chunkIdx).push(nodeId);
  }
}

function removeDeadPeer(chunkPeers, chunkIdx, deadPeer) {
  if (!chunkPeers.has(chunkIdx)) return;
  const updated = chunkPeers.get(chunkIdx)
    .filter(id => id !== deadPeer.nodeId);
  chunkPeers.set(chunkIdx, updated);
}

// ── Barre de progression console ────────────────────────────────────────────
function printProgress(done, total, filename) {
  const pct    = Math.floor((done / total) * 100);
  const filled = Math.floor(pct / 5);
  const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
  process.stdout.write(
    `\r[download] ${bar} ${pct}% (${done}/${total} chunks) — ${filename}   `
  );
  if (done === total) process.stdout.write('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { downloadFile, printProgress, sleep };