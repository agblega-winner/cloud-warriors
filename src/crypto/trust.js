// src/crypto/trust.js
const crypto = require('crypto');
const fs     = require('fs');

const TRUST_FILE = './trust-store.json';

// ── Charger le trust store ────────────────────────────────────────────────────
function loadTrustStore() {
  if (fs.existsSync(TRUST_FILE)) {
    return JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8'));
  }
  return {}; // store vide au premier démarrage
}

// ── Sauvegarder le trust store ────────────────────────────────────────────────
function saveTrustStore(store) {
  fs.writeFileSync(TRUST_FILE, JSON.stringify(store, null, 2));
}

// ── Calculer l'empreinte (fingerprint) d'une clé publique ────────────────────
function fingerprint(publicKeyBase64) {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(publicKeyBase64, 'base64'))
    .digest('hex')
    .slice(0, 32); // 32 chars suffisent pour affichage
}

// ── TOFU : Trust On First Use ─────────────────────────────────────────────────
// Première rencontre avec un nodeId → on sauvegarde sa clé publique
// Reconnexion suivante → on vérifie que c'est bien la même clé
function trustOrVerify(nodeId, publicKeyBase64) {
  const store = loadTrustStore();

  if (!store[nodeId]) {
    // Première fois qu'on voit ce nœud → on fait confiance (TOFU)
    store[nodeId] = {
      publicKey  : publicKeyBase64,
      fingerprint: fingerprint(publicKeyBase64),
      firstSeen  : Date.now(),
      trusted    : true,
      trustScore : 1.0,
    };
    saveTrustStore(store);
    console.log(`[trust] ✅ Nouveau pair enregistré : ${nodeId}`);
    console.log(`[trust]    Fingerprint : ${store[nodeId].fingerprint}`);
    return { trusted: true, isNew: true };
  }

  // Reconnexion : vérifier que la clé n'a pas changé
  if (store[nodeId].publicKey !== publicKeyBase64) {
    console.error(`[trust] 🚨 ALERTE MITM ! Clé différente pour ${nodeId}`);
    console.error(`[trust]    Attendue  : ${store[nodeId].fingerprint}`);
    console.error(`[trust]    Reçue     : ${fingerprint(publicKeyBase64)}`);
    return { trusted: false, isNew: false, reason: 'MITM_DETECTED' };
  }

  console.log(`[trust] ✅ Pair vérifié : ${nodeId}`);
  return { trusted: true, isNew: false };
}

// ── Augmenter le score de confiance d'un pair ─────────────────────────────────
function increaseTrust(nodeId, amount = 0.1) {
  const store = loadTrustStore();
  if (store[nodeId]) {
    store[nodeId].trustScore = Math.min(1.0, store[nodeId].trustScore + amount);
    saveTrustStore(store);
  }
}

// ── Révoquer un pair ──────────────────────────────────────────────────────────
function revoke(nodeId) {
  const store = loadTrustStore();
  if (store[nodeId]) {
    store[nodeId].trusted    = false;
    store[nodeId].revokedAt  = Date.now();
    store[nodeId].trustScore = 0.0;
    saveTrustStore(store);
    console.log(`[trust] 🔴 Pair révoqué : ${nodeId}`);
  }
}

module.exports = { trustOrVerify, increaseTrust, revoke, fingerprint };