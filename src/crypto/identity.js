// src/crypto/identity.js
const nacl    = require('tweetnacl');
const { encodeBase64, decodeBase64 } = require('tweetnacl-util');
const crypto  = require('crypto');
const fs      = require('fs');

// ── Générer une nouvelle identité Ed25519 ────────────────────────────────────
function generateIdentity() {
  // Ed25519 : paire de clés pour SIGNER et VÉRIFIER
  // - privateKey : 64 bytes — ne JAMAIS partager
  // - publicKey  : 32 bytes — c'est ton NODE_ID, tu le partages
  const keyPair = nacl.sign.keyPair();

  return {
    publicKey : encodeBase64(keyPair.publicKey),   // ton identité publique
    privateKey: encodeBase64(keyPair.secretKey),   // ton secret absolu
    nodeId    : crypto
                  .createHash('sha256')
                  .update(keyPair.publicKey)
                  .digest('hex')
                  .slice(0, 16),                   // ID court pour les logs
  };
}

// ── Sauvegarder l'identité sur disque ───────────────────────────────────────
function saveIdentity(identity, path = './identity.json') {
  fs.writeFileSync(path, JSON.stringify(identity, null, 2));
  console.log(`[identity] ✅ Identité sauvegardée dans ${path}`);
}

// ── Charger ou créer l'identité ─────────────────────────────────────────────
function loadOrCreateIdentity(path = './identity.json') {
  if (fs.existsSync(path)) {
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    console.log(`[identity] ✅ Identité chargée — nodeId: ${data.nodeId}`);
    return data;
  }
  const identity = generateIdentity();
  saveIdentity(identity, path);
  return identity;
}

// ── Signer un message avec ta clé privée Ed25519 ────────────────────────────
function sign(message, privateKeyBase64) {
  const privateKey = decodeBase64(privateKeyBase64);
  const msgBuf     = Buffer.isBuffer(message)
                     ? message
                     : Buffer.from(message, 'utf8');
  // nacl.sign() retourne : signature(64 bytes) + message
  const signed = nacl.sign(msgBuf, privateKey);
  // On garde uniquement la signature (les 64 premiers bytes)
  return encodeBase64(signed.slice(0, 64));
}

// ── Vérifier une signature Ed25519 ──────────────────────────────────────────
function verify(message, signatureBase64, publicKeyBase64) {
  try {
    const publicKey  = decodeBase64(publicKeyBase64);
    const signature  = decodeBase64(signatureBase64);
    const msgBuf     = Buffer.isBuffer(message)
                       ? message
                       : Buffer.from(message, 'utf8');

    // Reconstruire le message signé pour vérification
    const signedMsg = new Uint8Array(64 + msgBuf.length);
    signedMsg.set(signature, 0);
    signedMsg.set(msgBuf, 64);

    const opened = nacl.sign.open(signedMsg, publicKey);
    return opened !== null; // null = signature invalide
  } catch (_) {
    return false;
  }
}

module.exports = { generateIdentity, saveIdentity, loadOrCreateIdentity, sign, verify };