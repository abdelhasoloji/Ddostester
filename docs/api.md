# Référence API

Base : `http://127.0.0.1:8080` (via tunnel SSH). Réponses JSON, sauf le rapport
(HTML). Aucun trafic n'est émis vers une cible hors `ALLOWED_TARGETS`.

## `GET /health`
État du service et cibles autorisées.
```bash
curl -s localhost:8080/health
# {"status":"ok","allowedTargets":["127.0.0.1","localhost"]}
```

## `POST /api/campaigns`
Crée une campagne au statut `PENDING_APPROVAL`.

Corps :
| Champ | Type | Notes |
|-------|------|-------|
| `name` | string | requis |
| `createdBy` | string | requis (auteur) |
| `target` | string (URL) | doit être dans l'allowlist |
| `probeUrl` | string (URL) | endpoint sondé, dans l'allowlist |
| `vector` | `http-get` \| `http-post` | seuls vecteurs supportés |
| `body` | string | pour `http-post` |
| `headers` | objet | en-têtes additionnels |
| `maxRps` | number | > 0, ≤ 2000 |
| `concurrency` | number | 1..500 |
| `maxDurationSec` | number | 1..900 |
| `authorized` | bool | doit être `true` (attestation) |

```bash
curl -s -X POST localhost:8080/api/campaigns -H 'content-type: application/json' -d '{
  "name":"Résilience UAT",
  "createdBy":"eng@wedos",
  "target":"http://127.0.0.1:8080/health",
  "probeUrl":"http://127.0.0.1:8080/health",
  "vector":"http-get",
  "maxRps":20,"concurrency":5,"maxDurationSec":30,
  "authorized":true
}'
```

## `GET /api/campaigns` — liste
## `GET /api/campaigns/:id` — détail

## `POST /api/campaigns/:id/approval`
Approuve ou rejette (Security Officer). Séparation des rôles : `approvedBy` ≠ auteur.
```bash
curl -s -X POST localhost:8080/api/campaigns/<id>/approval -H 'content-type: application/json' \
  -d '{"approvedBy":"officer@wedos","decision":"APPROVED"}'
# rejet : {"approvedBy":"officer@wedos","decision":"REJECTED","reason":"hors fenêtre"}
```

## `POST /api/campaigns/:id/execute`
Exécute une campagne `APPROVED`. Renvoie le run (générateur + sonde + WRS).
```bash
curl -s -X POST localhost:8080/api/campaigns/<id>/execute
```

## `POST /api/campaigns/:id/kill`
Kill switch manuel (niveau 2) d'une campagne en cours.
```bash
curl -s -X POST localhost:8080/api/campaigns/<id>/kill
# {"status":"KILLED_MANUAL"}
```

## `GET /api/runs/:runId` — résultat brut d'exécution
## `GET /api/runs/:runId/report` — rapport HTML
```bash
curl -s localhost:8080/api/runs/<runId>/report -o rapport.html
```

## Codes d'erreur
| Code | Cause |
|------|-------|
| 400 | config invalide (attestation manquante, plafond dépassé, cible hors allowlist, transition interdite) |
| 404 | campagne / run introuvable |
| 500 | erreur interne |
