// src/transfer/chunker.js
const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');

const CHUNK_SIZE = 512 * 1024; // 512 KB

// ── Découper un fichier en chunks et calculer leurs hashes ──────────────────
function chunkFile(filePath) {
  console.log(`[chunker] Lecture de ${filePath}...`);

  const buffer   = fs.readFileSync(filePath);
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const chunks   = [];

  for (let i = 0; i * CHUNK_SIZE < buffer.length; i++) {
    const start = i * CHUNK_SIZE;
    const end   = Math.min(start + CHUNK_SIZE, buffer.length);
    const data  = buffer.slice(start, end);
    const hash  = crypto.createHash('sha256').update(data).digest('hex');

    chunks.push({
      index : i,
      hash  : hash,
      size  : data.length,
      data  : data,          // Buffer brut — sera chiffré à l'envoi
    });
  }

  console.log(`[chunker] ✅ ${chunks.length} chunks de ${CHUNK_SIZE/1024}KB`);
  console.log(`[chunker] SHA-256 fichier : ${fileHash.slice(0,32)}...`);

  return {
    file_id   : fileHash,
    filename  : path.basename(filePath),
    size      : buffer.length,
    chunk_size: CHUNK_SIZE,
    nb_chunks : chunks.length,
    chunks    : chunks,
  };
}

// ── Réassembler les chunks dans l'ordre et vérifier le hash final ───────────
function reassembleFile(fileId, nbChunks, outputPath, storageDir) {
  console.log(`[chunker] Réassemblage de ${nbChunks} chunks...`);

  const parts = [];

  for (let i = 0; i < nbChunks; i++) {
    const chunkPath = `${storageDir}/${fileId}_${i}.chunk`;
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`Chunk manquant : index ${i}`);
    }
    parts.push(fs.readFileSync(chunkPath));
  }

  const finalBuffer = Buffer.concat(parts);
  const finalHash   = crypto.createHash('sha256').update(finalBuffer).digest('hex');

  fs.writeFileSync(outputPath, finalBuffer);

  console.log(`[chunker] Fichier réassemblé : ${outputPath}`);
  console.log(`[chunker] SHA-256 final : ${finalHash.slice(0,32)}...`);

  return finalHash;
}

module.exports = { chunkFile, reassembleFile, CHUNK_SIZE };