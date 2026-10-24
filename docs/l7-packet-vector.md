# L7 — le vecteur paquet comme mission de premier rang

**État au 24 octobre 2026.** Décisions, points d'insertion et contrat de mesure.

## Ce qui est livré (PR #303)

| Élément                                                                                                     | Fichier                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bornes : `maxPps`, `packetPorts`                                                                            | `backend/src/config/limits.ts` (`FLEET_LIMITS`)                                                 |
| Validation d'une demande de mission paquet                                                                  | `validatePacketMission` dans `backend/src/modules/fleet/contract.ts`                            |
| Assignation signée v3                                                                                       | `PacketAssignment`, `packetAssignmentHash`, `validatePacketAssignment`, `buildPacketAssignment` |
| Route : 409 limité au HTTP legacy, mission paquet validée, assignation produite (`202`, `delivered: false`) | `backend/src/routes/fleet-mission-routes.ts`                                                    |
| Cible paquet nommée par l'opérateur (`FLEET_PACKET_TARGET`), jamais déduite du premier hôte autorisé        | `backend/src/routes/fleet-mission-routes.ts`                                                    |
| Distribution : mission, run et shard écrits, claim routé v1/v2 vs v3                                        | `coordinator.ts`, `fleet-mission-routes.ts`                                                     |
| Capacité v2 déclarée par le claim du runtime qui exécute, jamais par un heartbeat externe                   | `fleet-mission-routes.ts`, `scripts/fleet/mission-agent.mjs`                                    |
| Agent d'exécution et générateur compilé dans l'image                                                        | `scripts/fleet/packet-agent.mjs`, `scripts/fleet/pktgen.c`, `backend/Dockerfile`                |
| Compteur cible lu avant et après l'émission, remis à l'agent en `PACKET_RECEIVED`                           | `backend/src/modules/fleet/packet-counter.ts`, `agent.ts`                                       |

## Comment la cible est mesurée

Un chiffre d'émission ne prouve rien : seul le compteur de la cible fait foi.

1. L'orchestrateur lit le compteur **avant** toute émission. Si le lecteur manque
   ou échoue, la mission est refusée : aucun paquet ne part sans mesure possible.
2. L'orchestrateur lance l'agent, qui exécute le générateur pour la durée de
   l'assignation.
3. Le générateur terminé, l'agent signale `packet.emitted`. L'orchestrateur lit
   alors le compteur **après** l'émission et remet le delta à l'agent
   (`PACKET_RECEIVED`) par IPC.
4. L'agent ne déclare `accepted: true` que si le delta atteint 99 % des paquets
   émis. Un compteur illisible, un compteur qui recule ou un delta absent
   produisent un échec, jamais un succès supposé.

L'orchestrateur retire `PACKET_RECEIVED` de l'environnement de l'agent : cette
variable ne sert qu'à un lancement autonome, hors mesure orchestrée. Il exige
aussi que le delta ait effectivement été remis avant de conclure au succès.

Contrat d'environnement du processus qui exécute l'agent :

- `PACKET_COUNTER_CMD` : tableau JSON argv du lecteur, exécuté sans shell. Exemple
  vers une cible dont le compteur est local :
  `["nft","list","counter","inet","drs_lab","syn_rx"]`. Pour une cible distante,
  l'argv peut être une commande `ssh` explicite (clé et hôte en arguments).
- `PACKET_SOURCE_IP` : adresse IPv4 réelle de l'agent, obligatoire. Le générateur
  forge l'en-tête IP ; une source forgée est filtrée par l'hébergeur en sortie.
- `PACKET_COUNTER_SETTLE_MS` : délai entre la fin de l'émission et la lecture
  « après », 0 à 5000 ms (défaut 0).
- `FLEET_PACKET_TARGET` (côté API) : hôte de la cible paquet, qui doit figurer
  dans l'allowlist effective.

Sans `PACKET_COUNTER_CMD`, une mission paquet échoue avec un motif explicite
avant l'émission — c'est volontaire, et c'est le comportement des agents qui
n'ont pas de lecteur configuré.

## Ce qui reste

1. **Campagne de niveau 1 par l'API de production.** Elle exige, sur le site
   d'exécution : un agent `fleet-mission-agent/v2` enrôlé, un lecteur
   `PACKET_COUNTER_CMD` vers la cible, et la cible dans `ALLOWED_TARGETS`.
2. Consigner la preuve : paquets émis, delta cible, horodatage et identité de
   l'agent dans le reçu de mission.

## Règle de conception

Un succès n'est déclaré que si les paquets reçus atteignent 99 % des émis. Une
émission seule ne prouve rien : c'est le compteur de la cible qui fait foi.
