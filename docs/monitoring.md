# Monitoring (Prometheus + Grafana)

Le control plane expose des métriques Prometheus sur **`GET /metrics`**
(campagnes par statut, total des exécutions, dernier WRS par cible).

## Stack prête à l'emploi

Une pile Prometheus + Grafana est fournie en **profil Docker** (optionnel) :

```bash
POSTGRES_PASSWORD=... GRAFANA_PASSWORD=... \
  docker compose --profile monitoring up -d --build
```

- **Prometheus** scrape `api:8080/metrics` (réseau interne, non exposé).
- **Grafana** sur `127.0.0.1:3000` (accès via tunnel SSH), avec datasource et
  dashboard « WEDOS ShieldTest » auto-provisionnés :
  - Exécutions (total)
  - Campagnes par statut
  - Dernier WRS par cible (seuils couleur : 50 / 70 / 85)

```bash
# depuis le poste :
ssh -L 3000:127.0.0.1:3000 user@serveur   # puis http://localhost:3000 (admin / GRAFANA_PASSWORD)
```

## Sans Docker

Pointer un Prometheus existant sur `http://<hôte-loopback>:8080/metrics` et
importer `deploy/monitoring/grafana/dashboards/shieldtest.json` dans Grafana.
