// src/crypto/cipher.js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

// ── Chiffrer un message ──────────────────────────────────────────────────────
function encrypt(plaintext, sessionKey) {
  // ⚠️ RÈGLE ABSOLUE : nonce UNIQUE à chaque message
  // Un nonce réutilisé avec la même clé = tout le chiffrement cassé
  // (un attaquant peut XOR les deux chiffrés et récupérer le texte clair)
  const nonce = crypto.randomBytes(12); // 96 bits = standard GCM

  const cipher = crypto.createCipheriv(ALGORITHM, sessionKey, nonce);

  const encrypted = Buffer.concat([
    cipher.update(
      Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8')
    ),
    cipher.final()
  ]);

  // Auth tag : 16 bytes qui garantissent l'intégrité du chiffré
  // Si quelqu'un modifie le chiffré → le tag ne correspond plus → rejeté
  const authTag = cipher.getAuthTag();

  return {
    nonce    : nonce.toString('base64'),       // 12 bytes
    encrypted: encrypted.toString('base64'),   // longueur variable
    authTag  : authTag.toString('base64'),     // 16 bytes
  };
}

// ── Déchiffrer un message ────────────────────────────────────────────────────
function decrypt(encryptedObj, sessionKey) {
  try {
    const nonce     = Buffer.from(encryptedObj.nonce,     'base64');
    const encrypted = Buffer.from(encryptedObj.encrypted, 'base64');
    const authTag   = Buffer.from(encryptedObj.authTag,   'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, sessionKey, nonce);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final() // ← lance une exception si authTag invalide
    ]);

    return decrypted.toString('utf8');

  } catch (err) {
    // Deux cas possibles :
    // 1. Message corrompu sur le réseau
    // 2. Tentative de falsification (attaque)
    console.error('[cipher] ❌ Déchiffrement échoué :', err.message);
    return null;
  }
}

// ── HMAC-SHA256 : intégrité du paquet réseau entier ──────────────────────────
function computeHmac(data, sessionKey) {
  return crypto
    .createHmac('sha256', sessionKey)
    .update(typeof data === 'string' ? data : JSON.stringify(data))
    .digest('base64');
}

function verifyHmac(data, hmac, sessionKey) {
  const expected = computeHmac(data, sessionKey);
  // Comparaison en temps constant (évite les timing attacks)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac,     'base64'),
      Buffer.from(expected, 'base64')
    );
  } catch (_) {
    return false;
  }
}

module.exports = { encrypt, decrypt, computeHmac, verifyHmac };