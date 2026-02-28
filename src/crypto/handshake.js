// src/crypto/handshake.js
const nacl   = require('tweetnacl');
const { encodeBase64, decodeBase64 } = require('tweetnacl-util');
const crypto = require('crypto');

// ── ÉTAPE 1 (Alice) : générer sa paire éphémère et préparer le HELLO ────────
function createHello(myNodeId) {
  // X25519 : paire de clés ÉPHÉMÈRE — nouvelle à chaque connexion
  // C'est ce qui garantit le Forward Secrecy
  const ephemeralKeyPair = nacl.box.keyPair();

  return {
    // Ce qu'on envoie à Bob
    hello: {
      type          : 'HELLO',
      ephemeralPubKey: encodeBase64(ephemeralKeyPair.publicKey),
      nodeId        : myNodeId,
      timestamp     : Date.now(),
    },
    // Ce qu'on garde en local (JAMAIS envoyé)
    myEphemeralPrivKey: encodeBase64(ephemeralKeyPair.secretKey),
  };
}

// ── ÉTAPE 2 (Bob) : répondre avec sa clé éphémère et une signature ──────────
function createHelloReply(helloMsg, myIdentity) {
  // Bob génère aussi une paire éphémère
  const ephemeralKeyPair = nacl.box.keyPair();

  // Bob calcule le secret partagé immédiatement
  const theirEphemeralPub = decodeBase64(helloMsg.ephemeralPubKey);
  const sharedSecret      = nacl.scalarMult(
    ephemeralKeyPair.secretKey,
    theirEphemeralPub
  );

  // Dériver la session key depuis le secret partagé
  const sessionKey = deriveSessionKey(sharedSecret);

  // Bob signe sa clé publique éphémère pour prouver son identité
  const { sign } = require('./identity');
  const signature = sign(
    Buffer.from(ephemeralKeyPair.publicKey),
    myIdentity.privateKey
  );

  return {
    // Ce qu'on envoie à Alice
    reply: {
      type           : 'HELLO_REPLY',
      ephemeralPubKey: encodeBase64(ephemeralKeyPair.publicKey),
      nodeId         : myIdentity.nodeId,
      publicKey      : myIdentity.publicKey,
      signature      : signature,
      timestamp      : Date.now(),
    },
    // La session key calculée (Bob l'a déjà)
    sessionKey,
  };
}

// ── ÉTAPE 3 (Alice) : calculer la session key après réception du REPLY ───────
function computeSessionKey(myEphemeralPrivKeyBase64, theirEphemeralPubKeyBase64) {
  const myPriv   = decodeBase64(myEphemeralPrivKeyBase64);
  const theirPub = decodeBase64(theirEphemeralPubKeyBase64);

  // X25519 : même secret des deux côtés
  // X25519(Alice_priv, Bob_pub) === X25519(Bob_priv, Alice_pub)
  const sharedSecret = nacl.scalarMult(myPriv, theirPub);

  return deriveSessionKey(sharedSecret);
}

// ── HKDF-SHA256 : transformer le secret brut en clé de chiffrement ──────────
function deriveSessionKey(sharedSecret) {
  // HKDF extrait une clé propre depuis un secret potentiellement biaisé
  // "archipel-v1" = contexte d'application (évite les conflits inter-protocoles)
  const ikm  = Buffer.from(sharedSecret);
  const salt  = Buffer.from('archipel-v1-salt');
  const info  = Buffer.from('archipel-v1');

  // HKDF-Extract
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();

  // HKDF-Expand
  const sessionKey = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest(); // 32 bytes = 256 bits parfait pour AES-256

  return sessionKey; // Buffer de 32 bytes
}

// ── ÉTAPE 4 (Alice) : créer le paquet AUTH ──────────────────────────────────
function createAuth(sessionKey, myIdentity) {
  const { sign } = require('./identity');

  // Alice signe le hash de la session key pour prouver qu'elle a bien
  // calculé le même secret que Bob (sans le révéler)
  const sessionKeyHash = crypto
    .createHash('sha256')
    .update(sessionKey)
    .digest();

  const signature = sign(sessionKeyHash, myIdentity.privateKey);

  return {
    type      : 'AUTH',
    nodeId    : myIdentity.nodeId,
    publicKey : myIdentity.publicKey,
    signature : signature,
    timestamp : Date.now(),
  };
}

// ── ÉTAPE 5 (Bob) : vérifier AUTH et confirmer ──────────────────────────────
function verifyAuth(authMsg, sessionKey) {
  const { verify } = require('./identity');

  const sessionKeyHash = crypto
    .createHash('sha256')
    .update(sessionKey)
    .digest();

  const isValid = verify(sessionKeyHash, authMsg.signature, authMsg.publicKey);

  if (isValid) {
    console.log(`[handshake] ✅ AUTH vérifié — tunnel sécurisé avec ${authMsg.nodeId}`);
    return { type: 'AUTH_OK', nodeId: authMsg.nodeId, timestamp: Date.now() };
  } else {
    console.error('[handshake] ❌ AUTH INVALIDE — possible attaque MITM !');
    return null;
  }
}

module.exports = {
  createHello,
  createHelloReply,
  computeSessionKey,
  createAuth,
  verifyAuth,
  deriveSessionKey,
};