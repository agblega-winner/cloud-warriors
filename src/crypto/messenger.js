// src/crypto/messenger.js
const { encrypt, decrypt, computeHmac, verifyHmac } = require('./cipher');
const { sign, verify } = require('./identity');

// Sessions actives : nodeId → { sessionKey, ... }
const sessions = new Map();

// ── Enregistrer une session après handshake réussi ───────────────────────────
function registerSession(nodeId, sessionKey) {
  sessions.set(nodeId, {
    sessionKey,
    establishedAt: Date.now(),
    messageCount : 0,
  });
  console.log(`[messenger] 🔐 Session enregistrée avec ${nodeId}`);
}

// ── Envoyer un message chiffré ────────────────────────────────────────────────
function sendMessage(recipientNodeId, plaintext, myIdentity) {
  const session = sessions.get(recipientNodeId);
  if (!session) {
    console.error(`[messenger] ❌ Pas de session avec ${recipientNodeId}`);
    return null;
  }

  // 1. Chiffrer avec AES-256-GCM + nonce aléatoire unique
  const encryptedPayload = encrypt(plaintext, session.sessionKey);

  // 2. Construire le paquet
  const packet = {
    type     : 'MSG',
    from     : myIdentity.nodeId,
    to       : recipientNodeId,
    payload  : encryptedPayload,
    timestamp: Date.now(),
    seq      : session.messageCount++,
  };

  // 3. Signer le paquet entier avec Ed25519
  const packetStr = JSON.stringify(packet);
  packet.signature = sign(packetStr, myIdentity.privateKey);

  // 4. HMAC pour l'intégrité réseau
  packet.hmac = computeHmac(packetStr, session.sessionKey);

  console.log(`[messenger] 📨 Message chiffré envoyé à ${recipientNodeId}`);
  console.log(`[messenger]    Taille chiffré : ${encryptedPayload.encrypted.length} chars`);

  return packet;
}

// ── Recevoir et déchiffrer un message ────────────────────────────────────────
function receiveMessage(packet, senderPublicKey) {
  const session = sessions.get(packet.from);
  if (!session) {
    console.error(`[messenger] ❌ Pas de session avec ${packet.from}`);
    return null;
  }

  // 1. Vérifier HMAC (intégrité réseau)
  const { hmac, signature, ...packetWithoutMeta } = packet;
  const packetStr = JSON.stringify(packetWithoutMeta);

  if (!verifyHmac(packetStr, hmac, session.sessionKey)) {
    console.error('[messenger] ❌ HMAC invalide — paquet corrompu ou falsifié');
    return null;
  }

  // 2. Vérifier signature Ed25519 (authentification)
  if (!verify(packetStr, signature, senderPublicKey)) {
    console.error('[messenger] ❌ Signature invalide — identité non confirmée');
    return null;
  }

  // 3. Déchiffrer le payload AES-256-GCM
  const plaintext = decrypt(packet.payload, session.sessionKey);
  if (!plaintext) return null;

  console.log(`[messenger] ✅ Message reçu de ${packet.from} : "${plaintext}"`);
  return plaintext;
}

module.exports = { registerSession, sendMessage, receiveMessage };