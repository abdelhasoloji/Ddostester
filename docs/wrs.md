# WRS — WEDOS Resiliency Score

Score de résilience 0–100 calculé **à partir de métriques mesurées**. La fonction
est pure (`backend/src/modules/wrs/scoring.ts`) : elle ne génère aucun trafic.

## Formule

```
WRS = 0.20·D + 0.30·M + 0.30·A + 0.20·C
```

| Comp. | Nom | Calcul | Borné |
|-------|-----|--------|-------|
| D | Détection | `100 − détection_s / 2` | [0,100] |
| M | Mitigation | `100 − mitigation_s / 3` | [0,100] |
| A | Disponibilité | `succès_légitimes / total_légitimes × 100` | [0,100] |
| C | Dommages collatéraux | `100 − impact_services_adjacents` | [0,100] |

Exemple (TSD §5.4) : détection 10 s → D = 95 ; mitigation 30 s → M = 90 ;
99,5 % de dispo → A = 99,5 ; aucun impact → C = 100 → **WRS ≈ 95,85 (A+)**.

## Niveaux

| WRS | Niveau | Interprétation |
|-----|--------|----------------|
| 95–100 | A+ | résilience exceptionnelle |
| 85–94 | A | excellente |
| 70–84 | B | acceptable |
| 50–69 | C | faiblesses identifiées |
| 30–49 | D | insuffisante |
| 0–29 | F | non résilient |

## Origine des entrées

- **A** et **C** proviennent directement de la **sonde** (disponibilité mesurée
  sur la cible et les endpoints voisins).
- **D** et **M** : en l'absence d'intégration avec la protection, le runner
  dérive des estimations conservatrices depuis l'état du kill switch. Elles
  peuvent être remplacées par les temps réels de détection/mitigation remontés
  par WEDOS Protection (point d'extension du `runner.ts`).
