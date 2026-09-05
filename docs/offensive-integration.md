# Intégration de la génération de charge (« offensif »)

Comment adresser la partie génération de trafic du TSD **de façon responsable**,
en gardant ShieldTest comme plan de contrôle et en déléguant l'émission de charge
à un outil dédié opéré par l'équipe.

## Principe : séparer gouverner/mesurer de générer

ShieldTest fournit autorisation, allowlist, plafonds, kill switch, sonde, WRS,
audit, conformité. Il **délègue** la production de charge à un **agent** via une
interface (`AttackAgent`). Aucun vecteur d'attaque n'est codé dans ce dépôt :

Sélection : `AGENT=builtin|k6|vegeta|locust` (défaut `builtin`). Tous produisent
une **charge HTTP bornée** ; les trois derniers délèguent à un outil externe
installé et opéré par l'équipe.

| Agent          | Outil                                       | Débit plafonné               | Multi-phases               | Sortie parsée       |
| -------------- | ------------------------------------------- | ---------------------------- | -------------------------- | ------------------- |
| `builtin-http` | intégré                                     | oui (fenêtre glissante)      | oui (phases)               | interne             |
| `k6`           | [k6](https://k6.io)                         | oui (arrival-rate)           | oui (ramping)              | `--summary-export`  |
| `vegeta`       | [Vegeta](https://github.com/tsenart/vegeta) | oui (`-rate`)                | oui (phases séquentielles) | `report -type=json` |
| `locust`       | [Locust](https://locust.io)                 | approché (`constant_pacing`) | non (→ k6/vegeta)          | `--csv`             |

Chaque adaptateur applique `validateConfig` (allowlist + plafonds), respecte le
kill switch, et renvoie **503** avec un message clair si l'outil externe est absent.

### Outils volontairement non scaffoldés

- **wrk / hey** : conçus pour le débit **maximal** (pas de plafond de débit
  simple) — contraires au modèle borné de ShieldTest.
- **Gatling / JMeter** : lourds (JVM/XML) ; intégrables via le même contrat
  `AttackAgent` si l'équipe le souhaite, mais non fournis par défaut.

## Prérequis de gouvernance (avant toute campagne)

1. **Autorisation écrite** interne + périmètre signé (Security Officer), fenêtre datée.
2. **Environnement isolé** (miroir UAT), jamais la production ni un tiers.
3. **Coordination amont** : hébergeur / opérateur réseau, et pour du volumétrique,
   le transit/upstream, afin d'éviter un incident ou le déclenchement de protections.
4. **Blast radius** : IP de test dédiées, trafic marqué (`X-WEDOS-TEST`), plan de rollback.

Ces prérequis sont la condition de légitimité — indépendamment de l'outil.

## Le contrat d'agent

```ts
interface AttackAgent {
  readonly name: string;
  available(): Promise<boolean>;
  run(config, allowedHosts, killSignal?, onProgress?): Promise<LoadTestResult>;
}
```

Un agent **doit** : valider la config (allowlist + plafonds via `validateConfig`),
respecter le `killSignal`, et ne produire que la charge décrite. L'agent hérite
ainsi automatiquement des garde-fous du control plane.

## Brancher k6

```bash
# 1) installer k6 sur l'hôte (doc officielle k6)
# 2) activer l'adaptateur
AGENT=k6 bash deploy/setup.sh      # ou AGENT=k6 dans l'environnement du service
```

`GET /health` renvoie l'agent actif (`"agent":"k6"`). Si le binaire k6 est absent,
l'exécution renvoie **503** avec un message explicite (pas de plantage).

## Charge volumétrique L3/L4

Hors périmètre applicatif : à réaliser par l'**équipe réseau** sur banc isolé
(générateurs de paquets de labo : TRex, MoonGen, pktgen), ou via un **prestataire
de simulation DDoS sous contrat**. ShieldTest peut orchestrer/mesurer/scorer le
résultat, mais **ne fournit pas** ces générateurs. Un nouvel agent peut être
ajouté en implémentant `AttackAgent` autour de l'outil retenu — le générateur
volumétrique vient alors de cet outil externe, jamais de ce dépôt.

## Ce qui n'est pas fourni

Aucun vecteur flood/amplification/épuisement. Voir [safeguards.md](./safeguards.md)
et [security-review.md](./security-review.md).
