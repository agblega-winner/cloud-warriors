// demo_sprint2.js — Lance ça pour montrer que tout fonctionne
const { loadOrCreateIdentity }              = require('./src/crypto/identity');
const { createHello, createHelloReply,
        computeSessionKey, createAuth,
        verifyAuth }                         = require('./src/crypto/handshake');
const { registerSession,
        sendMessage, receiveMessage }        = require('./src/crypto/messenger');
const { trustOrVerify }                     = require('./src/crypto/trust');

async function demo() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   ARCHIPEL — Démo Sprint 2 : Chiffrement  ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ── Créer les identités Alice et Bob ────────────────────────────────────
  const alice = loadOrCreateIdentity('./alice-identity.json');
  const bob   = loadOrCreateIdentity('./bob-identity.json');

  console.log(`Alice  nodeId : ${alice.nodeId}`);
  console.log(`Bob    nodeId : ${bob.nodeId}\n`);

  // ── HANDSHAKE COMPLET ────────────────────────────────────────────────────
  console.log('─── ÉTAPE 1 : Alice envoie HELLO ───────────────');
  const { hello, myEphemeralPrivKey: aliceEphPriv } = createHello(alice.nodeId);
  console.log('Alice → HELLO envoyé :', {
    ephemeralPubKey: hello.ephemeralPubKey.slice(0, 20) + '...',
    nodeId         : hello.nodeId,
  });

  console.log('\n─── ÉTAPE 2 : Bob répond HELLO_REPLY ───────────');
  const { reply, sessionKey: bobSessionKey } = createHelloReply(hello, bob);
  console.log('Bob → HELLO_REPLY envoyé');

  console.log('\n─── ÉTAPE 3 : Alice calcule la session key ─────');
  const aliceSessionKey = computeSessionKey(aliceEphPriv, reply.ephemeralPubKey);
  console.log('Alice sessionKey (hex) :', aliceSessionKey.toString('hex').slice(0, 32) + '...');
  console.log('Bob   sessionKey (hex) :', bobSessionKey.toString('hex').slice(0, 32) + '...');

  // Vérifier que les deux session keys sont identiques
  const keysMatch = aliceSessionKey.equals(bobSessionKey);
  console.log(`\n✅ Session keys identiques : ${keysMatch}`);

  console.log('\n─── ÉTAPE 4 : Alice envoie AUTH ────────────────');
  const auth    = createAuth(aliceSessionKey, alice);
  const authOk  = verifyAuth(auth, bobSessionKey);
  console.log('Bob vérifie AUTH :', authOk ? '✅ AUTH_OK' : '❌ REFUSÉ');

  if (!authOk) {
    console.error('Handshake échoué — arrêt');
    process.exit(1);
  }

  // ── TRUST (TOFU) ─────────────────────────────────────────────────────────
  console.log('\n─── TOFU : Enregistrement des pairs ────────────');
  trustOrVerify(bob.nodeId,   bob.publicKey);
  trustOrVerify(alice.nodeId, alice.publicKey);

  // ── Enregistrer les sessions ─────────────────────────────────────────────
  registerSession(bob.nodeId,   aliceSessionKey); // session d'Alice vers Bob
  registerSession(alice.nodeId, bobSessionKey);   // session de Bob vers Alice

  // ── ENVOYER UN MESSAGE CHIFFRÉ ───────────────────────────────────────────
  console.log('\n─── ÉTAPE 5 : Alice envoie un message chiffré ──');
  const texte  = 'Bonjour Bob ! Ceci est un message ultra-secret 🔐';
  const packet = sendMessage(bob.nodeId, texte, alice);

  console.log('\nPacket sur le réseau (ce que Wireshark voit) :');
  console.log('  payload.encrypted :', packet.payload.encrypted.slice(0, 40) + '...');
  console.log('  payload.nonce     :', packet.payload.nonce);
  console.log('  signature         :', packet.signature.slice(0, 40) + '...');
  console.log('  → Aucun texte lisible ✅');

  console.log('\n─── ÉTAPE 6 : Bob déchiffre le message ─────────');
  const recu = receiveMessage(packet, alice.publicKey);
  console.log(`Message reçu et déchiffré : "${recu}"`);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║          Sprint 2 : SUCCÈS ✅              ║');
  console.log('╚══════════════════════════════════════════╝\n');
}

demo().catch(console.error);