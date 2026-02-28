// src/transfer/storage.js
const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');

const STORAGE_DIR = '.archipel/chunks';
const INDEX_FILE  = '.archipel/index.json';

// ── Initialiser le dossier de stockage ─────────────────────────────────────
function initStorage() {
  if (!fs.existsSync('.archipel'))        fs.mkdirSync('.archipel');
  if (!fs.existsSync(STORAGE_DIR))        fs.mkdirSync(STORAGE_DIR);
  if (!fs.existsSync(INDEX_FILE))         fs.writeFileSync(INDEX_FILE, '{}');
}

// ── Charger l'index local ───────────────────────────────────────────────────
function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

// ── Sauvegarder l'index local ──────────────────────────────────────────────
function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

// ── Sauvegarder un chunk reçu sur disque ───────────────────────────────────
function saveChunk(fileId, chunkIndex, data, expectedHash) {
  // Vérifier l'intégrité AVANT de sauvegarder
  const actualHash = crypto.createHash('sha256').update(data).digest('hex');

  if (actualHash !== expectedHash) {
    console.error(
      `[storage] ❌ HASH MISMATCH chunk ${chunkIndex}` +
      ` — attendu: ${expectedHash.slice(0,16)}...` +
      ` reçu: ${actualHash.slice(0,16)}...`
    );
    return false;
  }

  const chunkPath = path.join(STORAGE_DIR, `${fileId}_${chunkIndex}.chunk`);
  fs.writeFileSync(chunkPath, data);

  // Mettre à jour l'index
  const index = loadIndex();
  if (!index[fileId]) index[fileId] = {};
  index[fileId][chunkIndex] = { hash: actualHash, size: data.length };
  saveIndex(index);

  return true;
}

// ── Lire un chunk depuis le disque ─────────────────────────────────────────
function loadChunk(fileId, chunkIndex) {
  const chunkPath = path.join(STORAGE_DIR, `${fileId}_${chunkIndex}.chunk`);
  if (!fs.existsSync(chunkPath)) return null;
  return fs.readFileSync(chunkPath);
}

// ── Vérifier si on possède un chunk ────────────────────────────────────────
function hasChunk(fileId, chunkIndex) {
  const index = loadIndex();
  return !!(index[fileId] && index[fileId][chunkIndex]);
}

// ── Lister les chunks qu'on possède pour un fichier ────────────────────────
function getOwnedChunks(fileId) {
  const index = loadIndex();
  if (!index[fileId]) return [];
  return Object.keys(index[fileId]).map(Number);
}

// ── Compter les chunks manquants ────────────────────────────────────────────
function getMissingChunks(fileId, nbChunks) {
  const owned   = new Set(getOwnedChunks(fileId));
  const missing = [];
  for (let i = 0; i < nbChunks; i++) {
    if (!owned.has(i)) missing.push(i);
  }
  return missing;
}

module.exports = {
  initStorage, loadIndex, saveIndex,
  saveChunk, loadChunk, hasChunk,
  getOwnedChunks, getMissingChunks,
  STORAGE_DIR, INDEX_FILE,
};