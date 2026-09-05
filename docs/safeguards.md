# Modèle de sécurité & périmètre

Cet outil est un **plan de contrôle défensif** pour tests de résilience internes.
Sa conception place des garde-fous à chaque étape et **exclut délibérément** toute
capacité offensive.

## Garde-fous techniques

| Garde-fou | Mécanisme | Où |
|-----------|-----------|-----|
| Liste blanche | Cible **et** sonde doivent être dans `ALLOWED_TARGETS` ; sinon refus | `campaigns/service.ts`, `engine/loadTest.ts` |
| Attestation | `authorized:true` obligatoire à la création | `campaigns/service.ts` |
| Plafonds durs | `maxRps ≤ 2000`, `concurrency ≤ 500`, `durée ≤ 900 s` | `HARD_CAPS` |
| Approbation | Workflow PENDING→APPROVED/REJECTED, **séparation des rôles**, validité 24 h, rejet motivé | `campaigns/service.ts` |
| Kill switch | Auto (>30 s indispo) / manuel / temporel | `probe/probe.ts`, `runner.ts` |
| Marquage | En-tête `X-WEDOS-TEST: <campaignId>:<ts>` sur chaque requête | `runner.ts` |
| Protocoles | `http`/`https` uniquement | validations d'URL |

## Garde-fous réseau / exploitation

- API/UI en **loopback uniquement** (`HOST=127.0.0.1`) ; accès par tunnel SSH.
- Aucune exposition publique ; pas d'authentification applicative → ne jamais
  binder sur `0.0.0.0`.
- Déploiement via clé de déploiement **en lecture seule**.

## Ce qui n'est PAS implémenté (volontairement)

Le **seul** vecteur de charge est un générateur **HTTP applicatif borné**
(GET/POST, débit plafonné, cible en liste blanche). Sont **hors périmètre** et
absents du code :

- **L3/L4 volumétrique** : UDP/ICMP/SYN/ACK/RST flood, fragmentation, GRE/DTLS
  flood, réflexion/amplification DNS/NTP/SSDP/CLDAP, Smurf.
- **L7 épuisement** : Slowloris, RUDY, cache-bypass, brute-force, WebSocket
  flood, GraphQL abuse, XML bomb, « browser botnet ».
- Toute génération à débit non borné ou vers une cible hors allowlist.

Ces techniques servent à **saturer** un service, pas à en **mesurer** la
résilience de façon maîtrisée. Une contribution qui les ajouterait sort du
périmètre de ce dépôt et ne doit pas être fusionnée.

## Responsabilité d'usage

L'allowlist et l'attestation sont des barrières techniques, pas une preuve
d'autorisation. L'opérateur reste responsable de ne viser que des systèmes
qu'il possède ou pour lesquels il détient un mandat écrit. Voir
[SECURITY.md](../SECURITY.md).
