const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { NodeController } = require('./node-controller');

const PORT = Number(process.env.PORT || 3000);
const argv = process.argv.slice(2);
const NODE_PORT = Number(argv.find((arg) => /^\d+$/.test(arg)) || 7777);
const AI_DISABLED = argv.includes('--no-ai') || process.env.ARCHIPEL_NO_AI === '1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const nodeController = new NodeController(NODE_PORT);

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'archipel-dashboard.html'));
});

[
  'peers-updated',
  'message-sent',
  'message-received',
  'transfer-started',
  'transfer-progress',
  'transfer-completed',
  'transfer-server-started',
  'log',
  'error',
].forEach((eventName) => {
  nodeController.on(eventName, (data) => broadcastWS(eventName, data));
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    nodePort: NODE_PORT,
    identity: nodeController.getIdentity(),
    peers: nodeController.getPeerTable(),
    messages: nodeController.getMessageLog().length,
    transfers: nodeController.getTransferHistory().length,
    manifests: nodeController.getManifests().length,
    sessions: nodeController.getCryptoState().sessions.length,
    ai: {
      enabled: !AI_DISABLED,
      configured: !!GEMINI_API_KEY,
      model: GEMINI_MODEL,
    },
  });
});

app.get('/api/identity', (req, res) => {
  res.json(nodeController.getIdentity());
});

app.post('/api/discover', async (req, res) => {
  try {
    const peers = await nodeController.startDiscovery({
      port: NODE_PORT,
      waitMs: Number(req.body?.waitMs || 1800),
    });
    res.json({ status: 'ok', peers });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/peers', (req, res) => {
  res.json(nodeController.getPeerTable());
});

app.post('/api/peers', (req, res) => {
  try {
    const peer = nodeController.addPeer(req.body || {});
    res.json({ status: 'ok', peer });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/peers/:nodeId', (req, res) => {
  const removed = nodeController.removePeer(req.params.nodeId);
  res.json({ status: removed ? 'ok' : 'not-found' });
});

app.post('/api/send-message', async (req, res) => {
  const { peerId, content } = req.body || {};
  if (!peerId || !content) {
    return res.status(400).json({ status: 'error', message: 'peerId et content requis' });
  }

  try {
    const message = await nodeController.sendEncryptedMessage(peerId, content);
    res.json({ status: 'ok', message });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/receive-message', (req, res) => {
  const { peerId, content } = req.body || {};
  if (!peerId || !content) {
    return res.status(400).json({ status: 'error', message: 'peerId et content requis' });
  }

  try {
    const message = nodeController.receiveMessage(peerId, content);
    res.json({ status: 'ok', message });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/incoming-packet', (req, res) => {
  try {
    const { packet, senderPublicKey, senderNodeId, senderTcpPort, senderApiPort } = req.body || {};
    if (!packet || !senderPublicKey) {
      return res.status(400).json({ status: 'error', message: 'packet et senderPublicKey requis' });
    }

    const remoteIp = req.headers['x-forwarded-for']
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : req.socket.remoteAddress;

    const message = nodeController.receiveNetworkPacket(packet, senderPublicKey, {
      ip: remoteIp,
      nodeId: senderNodeId || packet.from,
      tcpPort: Number(senderTcpPort || 7777),
      apiPort: Number(senderApiPort || 3000),
    });

    res.json({ status: 'ok', message });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/messages', (req, res) => {
  res.json(nodeController.getMessageLog());
});

app.post('/api/ai/query', async (req, res) => {
  const { query, context = [] } = req.body || {};
  if (!query || !String(query).trim()) {
    return res.status(400).json({ status: 'error', message: 'query requis' });
  }

  if (AI_DISABLED) {
    return res.json({
      status: 'disabled',
      answer: 'Assistant IA désactivé (--no-ai / ARCHIPEL_NO_AI=1).',
      source: 'disabled',
    });
  }

  if (!GEMINI_API_KEY) {
    return res.json({
      status: 'fallback',
      source: 'missing-key',
      answer: 'GEMINI_API_KEY non configuree. Ajoute la cle API pour activer l assistant.',
    });
  }

  const safeContext = Array.isArray(context) ? context.slice(-10) : [];
  const prompt = [
    'Tu es l assistant technique du protocole Archipel.',
    'Reponds en francais, concise et actionnable.',
    'Contexte conversation:',
    ...safeContext.map((line, idx) => `${idx + 1}. ${String(line)}`),
    `Question utilisateur: ${String(query)}`,
  ].join('\n');

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini HTTP ${response.status}: ${text.slice(0, 140)}`);
    }

    const data = await response.json();
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!answer) {
      throw new Error('Reponse Gemini vide');
    }

    res.json({ status: 'ok', source: 'gemini', answer });
  } catch (err) {
    res.json({
      status: 'fallback',
      source: 'fallback',
      answer: `Gemini indisponible (${err.message}). Verifie la cle API et la connectivite.`,
    });
  }
});

app.get('/api/crypto', (req, res) => {
  res.json(nodeController.getCryptoState());
});

app.get('/api/trust', (req, res) => {
  res.json(nodeController.getTrustStore());
});

app.post('/api/trust/certify', (req, res) => {
  const { nodeId } = req.body || {};
  if (!nodeId) {
    return res.status(400).json({ status: 'error', message: 'nodeId requis' });
  }

  try {
    const trust = nodeController.certifyPeer(nodeId);
    res.json({ status: 'ok', trust });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/trust/revoke', (req, res) => {
  const { nodeId } = req.body || {};
  if (!nodeId) {
    return res.status(400).json({ status: 'error', message: 'nodeId requis' });
  }

  try {
    const trust = nodeController.revokePeer(nodeId);
    res.json({ status: 'ok', trust });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/start-transfer-server', async (req, res) => {
  try {
    const info = await nodeController.startTransferServer({ port: NODE_PORT });
    res.json({ status: 'ok', info });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/transfer', async (req, res) => {
  const { filePath, peerId } = req.body || {};
  if (!filePath || !peerId) {
    return res.status(400).json({ status: 'error', message: 'filePath et peerId requis' });
  }

  try {
    const data = await nodeController.startFileTransfer(filePath, peerId);
    res.json({ status: 'ok', ...data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/fetch-manifest', async (req, res) => {
  const { peerId, fileId } = req.body || {};
  if (!peerId || !fileId) {
    return res.status(400).json({ status: 'error', message: 'peerId et fileId requis' });
  }

  try {
    const manifest = await nodeController.fetchManifestFromPeer(peerId, fileId);
    res.json({ status: 'ok', manifest });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/download', async (req, res) => {
  const { peerId, fileId, outputPath } = req.body || {};
  if (!peerId || !fileId || !outputPath) {
    return res.status(400).json({ status: 'error', message: 'peerId, fileId et outputPath requis' });
  }

  try {
    const data = await nodeController.downloadFromPeer(peerId, fileId, outputPath);
    res.json({ status: 'ok', ...data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/manifests', (req, res) => {
  res.json(nodeController.getManifests());
});

app.get('/api/transfers', (req, res) => {
  res.json(nodeController.getTransferHistory());
});

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'init',
      data: {
        status: 'connected',
        nodePort: NODE_PORT,
        identity: nodeController.getIdentity(),
        peers: nodeController.getPeerTable(),
        crypto: nodeController.getCryptoState(),
      },
    })
  );

  ws.on('error', () => {});
});

function broadcastWS(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

server.listen(PORT, () => {
  console.log(`ARCHIPEL Dashboard actif: http://localhost:${PORT}`);
  console.log(`Node TCP de référence: ${NODE_PORT}`);
  console.log(`Gemini: ${AI_DISABLED ? 'désactivé' : GEMINI_API_KEY ? 'actif' : 'clé manquante'}`);
});

async function shutdown() {
  await nodeController.stopAll();
  wss.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
