# Archipel H24

## Sprint 0 - Bootstrap & Architecture

Ce document couvre le **Livrable S0**:
- stack choisie;
- schéma d'architecture;
- format de paquet;
- types de messages;
- génération des clés PKI (Ed25519).

## 1) Choix technologique

- Langage principal: **Python 3.12+**
- Transport local:
  - **UDP multicast** pour la découverte (`HELLO`, `PEER_LIST`)
  - **TCP** pour les transferts (`CHUNK_REQ`, `CHUNK_DATA`, `ACK`)

Justification:
- développement rapide (contraintes hackathon);
- modules standards Python pour réseau + sécurité (`socket`, `struct`, `hmac`, `hashlib`);
- séparation claire découverte vs transfert.

## 2) Architecture (ASCII)

```text
                     LAN
      +---------------------------------------+
      |      UDP Multicast (Discovery)        |
      +---------------------------------------+
           ^                           ^
           | HELLO / PEER_LIST         | HELLO / PEER_LIST
           |                           |
+-------------------+         +-------------------+
| Node A            |         | Node B            |
| - Discovery svc   |         | - Discovery svc   |
| - Transfer svc    |<------->| - Transfer svc    |
| - Manifest store  |   TCP   | - Manifest store  |
| - Chunk store     | chunks  | - Chunk store     |
+-------------------+         +-------------------+
          |                              |
          +--------- HMAC-SHA256 --------+
```

## 3) Format de paquet Archipel (v1)

Header binaire fixe:
- `MAGIC`: 4 bytes (ex: `0x41524348` = "ARCH")
- `TYPE`: 1 byte
- `NODE_ID`: 32 bytes
- `PAYLOAD_LEN`: 4 bytes unsigned big-endian

Corps:
- `PAYLOAD`: longueur variable (`PAYLOAD_LEN`)
- `HMAC_SHA256`: 32 bytes (sur `header + payload`)

Ordre sérialisation:
1. header (`MAGIC`, `TYPE`, `NODE_ID`, `PAYLOAD_LEN`)
2. payload
3. hmac

## 4) Types de messages

- `0x01 HELLO`: annonce de présence locale.
- `0x02 PEER_LIST`: réponse avec nœuds connus.
- `0x03 MSG`: message chiffré applicatif.
- `0x04 CHUNK_REQ`: requête d'un chunk.
- `0x05 CHUNK_DATA`: envoi d'un chunk.
- `0x06 MANIFEST`: métadonnées fichier (hash, taille, nombre de chunks).
- `0x07 ACK`: accusé de réception.

## 5) Arborescence minimale (S0)

```text
archipel-h24/
  README.md
  scripts/
    generate_keys.ps1
  pki/
    .gitkeep
```

## 6) Génération des clés PKI (Ed25519)

Prérequis:
- OpenSSH (`ssh-keygen`) disponible sous Windows.

Commande:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate_keys.ps1
```

Résultat attendu:
- `pki/node-a_ed25519` et `pki/node-a_ed25519.pub`
- `pki/node-b_ed25519` et `pki/node-b_ed25519.pub`

## 7) Validation Livrable S0

Checklist:
- [x] Stack choisie et justifiée.
- [x] Schéma architecture ASCII.
- [x] Format paquet documenté.
- [x] Types de messages listés.
- [ ] Clés PKI générées localement.
- [ ] Commit + tag `sprint/0`.

## Sprint 1 - Node Discovery and Routing

Implemented:
- UDP multicast discovery on `239.255.42.99:6000` (`HELLO`);
- peer table with `node_id`, `ip`, `tcp_port`, `last_seen`, `shared_files`, `reputation`;
- stale peer eviction after timeout;
- TCP server (default `7777`) using TLV framing;
- keepalive `PING/PONG` every 15s on established TCP connections.
- Sprint 1 runtime language: **Node.js** (built-in modules only).

Run one node:

```powershell
node run_node.js --tcp-port 7777 --hello-interval 30 --stale-timeout 90
```

Sprint 1 local demo (3 nodes):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\demo_sprint1.ps1
```

Expected result:
- 3 nodes discover each other in < 60s;
- peer table is printed every 10s in each console.
