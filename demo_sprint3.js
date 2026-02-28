// demo_sprint3.js — Démo jury Sprint 3
const path = require('path');
const { chunkFile }             = require('./src/transfer/chunker');
const { generateManifest,
        validateManifest }      = require('./src/transfer/manifest');
const { initStorage,
        saveChunk }             = require('./src/transfer/storage');
const { downloadFile }          = require('./src/transfer/download-manager');
const { TransferServer }        = require('./src/transfer/transfer-server');
const { loadOrCreateIdentity }  = require('./src/crypto/identity');

// ── Configuration ────────────────────────────────────────────────────────────
const PORT       = parseInt(process.argv[2]) || 7777;
const MODE       = process.argv[3] || 'source';  // 'source' ou 'receiver'
const FILE_PATH  = process.argv[4] || './test50mo.bin';
const SOURCE_IP  = process.argv[5] || '127.0.0.1';

async function runSource() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   ARCHIPEL Sprint 3 — Nœud SOURCE            ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  initStorage();
  const identity = loadOrCreateIdentity('./identity.json');

  // 1. Découper le fichier
  console.log('─── ÉTAPE 1 : Découpage du fichier ─────────────');
  const fileInfo = chunkFile(FILE_PATH);

  // 2. Générer le manifest
  console.log('\n─── ÉTAPE 2 : Génération du MANIFEST ───────────');
  const manifest = generateManifest(fileInfo, identity);

  // 3. Stocker tous les chunks localement (le source les a tous)
  console.log('\n─── ÉTAPE 3 : Stockage local des chunks ─────────');
  for (const chunk of fileInfo.chunks) {
    saveChunk(manifest.file_id, chunk.index, chunk.data, chunk.hash);
  }
  console.log(`[source] ✅ ${fileInfo.chunks.length} chunks stockés`);

  // 4. Démarrer le serveur de transfert
  console.log('\n─── ÉTAPE 4 : Démarrage serveur de transfert ────');
  const server = new TransferServer(PORT);
  server.registerManifest(manifest);
  try {
    await server.start();
  } catch (err) {
    console.error('[source] ❌ Impossible de démarrer le serveur de transfert', err.message);
    process.exit(1);
  }
  // on ferme proprement quand l'utilisateur presse Ctrl‑C
  process.on('SIGINT', () => {
    server.stop();
    process.exit();
  });

  // 5. Afficher les infos pour les receivers
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   SOURCE PRÊT — Infos pour les receivers     ║');
  console.log(`║   Port transfert : ${PORT + 1000}                      ║`);
  console.log(`║   file_id : ${manifest.file_id.slice(0,20)}...  ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('\nCommande receiver :');
  console.log(
    `  node demo_sprint3.js 7778 receiver ` +
    `./recu.bin 127.0.0.1 ${manifest.file_id}`
  );

  console.log('\n[source] En attente de requêtes...');
}

async function runReceiver() {
  const fileId = process.argv[6];
  // optional 7th argument is the source's base port (default to receiverPort-1)
  const receiverPort = parseInt(process.argv[2]);
  const sourcePortArg = process.argv[7];
  const sourceBasePort = sourcePortArg ? parseInt(sourcePortArg) : (receiverPort - 1);

  if (!fileId) {
    console.error('Usage: node demo_sprint3.js <port> receiver <output> <sourceIp> <fileId> [<sourcePort>]');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   ARCHIPEL Sprint 3 — Nœud RECEIVER          ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  initStorage();

  // 1. Récupérer le manifest depuis la source
  console.log('─── ÉTAPE 1 : Récupération du MANIFEST ──────────');
  const manifest = await fetchManifest(SOURCE_IP, sourceBasePort, fileId);

  if (!manifest) {
    console.error('[receiver] ❌ Impossible de récupérer le manifest');
    process.exit(1);
  }

  // 2. Valider la signature
  if (!validateManifest(manifest)) {
    console.error('[receiver] ❌ Manifest invalide — abandon');
    process.exit(1);
  }

  // 3. Démarrer son propre serveur de transfert
  //    (pour partager les chunks reçus avec d'autres peers)
  const server = new TransferServer(PORT);
  server.registerManifest(manifest);
  try {
    await server.start();
  } catch (err) {
    console.error('[receiver] ❌ Impossible de démarrer le serveur de transfert', err.message);
    process.exit(1);
  }

  // 4. Télécharger
  console.log('\n─── ÉTAPE 2 : Téléchargement ────────────────────');
  const startTime = Date.now();

  const peers = [{
    nodeId    : manifest.sender_id,
    ip        : SOURCE_IP,
    // use the sourceBasePort defined earlier (plus 1000)
    port      : sourceBasePort + 1000,
    reputation: 1.0,
  }];

  const outputPath = FILE_PATH;
  try {
    await downloadFile(manifest, peers, outputPath);
  } catch (err) {
    console.error('[receiver] ❌ Erreur pendant le téléchargement', err);
    server.stop();
    process.exit(1);
  } finally {
    // always stop the server once we're done (success or failure)
    server.stop();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[receiver] ⏱️  Temps total : ${elapsed} secondes`);
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║          Sprint 3 : SUCCÈS ✅                 ║');
  console.log('╚══════════════════════════════════════════════╝\n');
}

// ── Récupérer le manifest depuis la source via TCP ──────────────────────────
function fetchManifest(ip, sourcePort, fileId) {
  return new Promise((resolve) => {
    const transferPort = sourcePort + 1000;
    const socket = net.createConnection({ host: ip, port: transferPort }, () => {
      socket.write(JSON.stringify({
        type   : 'MANIFEST_REQ',
        file_id: fileId,
      }) + '\n');
    });

    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'MANIFEST') {
            socket.destroy();
            resolve(msg.manifest);
          }
        } catch (_) {}
      }
    });

    socket.setTimeout(5000, () => { socket.destroy(); resolve(null); });
    socket.on('error', () => resolve(null));
  });
}

const net = require('net');

// ── Point d'entrée ───────────────────────────────────────────────────────────
if (MODE === 'source')   runSource().catch(console.error);
if (MODE === 'receiver') runReceiver().catch(console.error);