// src/transfer/manifest.js
const crypto = require('crypto');

// ── Générer le MANIFEST signé ───────────────────────────────────────────────
function generateManifest(fileInfo, identity) {
  const { sign } = require('../crypto/identity');

  // Données du manifest SANS les chunks bruts (juste les métadonnées)
  const manifest = {
    type      : 'MANIFEST',
    file_id   : fileInfo.file_id,
    filename  : fileInfo.filename,
    size      : fileInfo.size,
    chunk_size: fileInfo.chunk_size,
    nb_chunks : fileInfo.nb_chunks,
    // Liste des chunks SANS les données binaires
    chunks    : fileInfo.chunks.map(c => ({
      index : c.index,
      hash  : c.hash,
      size  : c.size,
    })),
    sender_id : identity.nodeId,
    public_key: identity.publicKey,
    created_at: Date.now(),
  };

  // Signer le hash du manifest pour garantir l'authenticité
  const manifestStr  = JSON.stringify(manifest);
  const manifestHash = crypto.createHash('sha256')
                             .update(manifestStr)
                             .digest();
  manifest.signature = sign(manifestHash, identity.privateKey);

  console.log(`[manifest] ✅ MANIFEST généré pour ${manifest.filename}`);
  console.log(`[manifest]    file_id   : ${manifest.file_id.slice(0,32)}...`);
  console.log(`[manifest]    nb_chunks : ${manifest.nb_chunks}`);
  console.log(`[manifest]    taille    : ${(manifest.size / 1024 / 1024).toFixed(1)} Mo`);

  return manifest;
}

// ── Valider la signature d'un MANIFEST reçu ────────────────────────────────
function validateManifest(manifest) {
  const { verify } = require('../crypto/identity');

  // Reconstruire le manifest SANS la signature pour vérifier
  const { signature, ...manifestWithoutSig } = manifest;
  const manifestStr  = JSON.stringify(manifestWithoutSig);
  const manifestHash = crypto.createHash('sha256')
                             .update(manifestStr)
                             .digest();

  const isValid = verify(manifestHash, signature, manifest.public_key);

  if (isValid) {
    console.log(`[manifest] ✅ Signature valide — source : ${manifest.sender_id}`);
  } else {
    console.error('[manifest] ❌ Signature INVALIDE — manifest rejeté');
  }

  return isValid;
}

module.exports = { generateManifest, validateManifest };