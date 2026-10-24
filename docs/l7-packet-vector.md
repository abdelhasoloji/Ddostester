# L7 — le vecteur paquet comme mission de premier rang

**État au 24 octobre 2026.** Décisions et points d'insertion, pour que la suite soit
mécanique.

## Ce qui est livré (PR #303)

| Élément                                                                                                     | Fichier                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bornes : `maxPps`, `packetPorts`                                                                            | `backend/src/config/limits.ts` (`FLEET_LIMITS`)                                                 |
| Validation d'une demande de mission paquet                                                                  | `validatePacketMission` dans `backend/src/modules/fleet/contract.ts`                            |
| Assignation signée v3                                                                                       | `PacketAssignment`, `packetAssignmentHash`, `validatePacketAssignment`, `buildPacketAssignment` |
| Route : 409 limité au HTTP legacy, mission paquet validée, assignation produite (`202`, `delivered: false`) | `backend/src/routes/fleet-mission-routes.ts`                                                    |
| Agent d'exécution                                                                                           | `scripts/fleet/packet-agent.mjs`                                                                |

## Ce qui reste

1. **Distribution.** La voie existante passe par deux tables : `fleet_missions_v1` (la
   mission) et `fleet_shards_v1` (l'assignation par agent). Un agent retire sa mission via
   `action=claim`, qui appelle `coordinator.claim`. Pour le paquet, il faut écrire une ligne
   de mission et un shard portant l'assignation v3, puis laisser l'agent réclamer.
   Point d'attention : `coordinator.claim` valide probablement avec `validateAssignment`
   (v1/v2). Il doit router vers `validatePacketAssignment` sur `schema ===
'ddostester.fleet.assignment/v3'`, sinon il rejettera l'assignation.
2. **Agent dans l'image.** `scripts/fleet/packet-agent.mjs` doit être copié dans l'image et
   déclenché par le worker, avec `PACKET_GENERATOR` pointant sur le binaire.
3. **Compteur cible.** `packetsReceived` vient de l'orchestrateur (nftables côté cible).
   Sans lui l'agent rend `null` et `accepted: false` — c'est voulu.
4. **Campagne de niveau 1 par l'API de production** : dépend des trois précédents.

## Règle de conception

Un succès n'est déclaré que si les paquets reçus atteignent 99 % des émis. Une émission
seule ne prouve rien : c'est le compteur de la cible qui fait foi.
