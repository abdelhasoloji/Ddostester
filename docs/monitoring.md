# Monitoring (Prometheus + Grafana)

The control plane exposes Prometheus metrics on **`GET /metrics`** (campaigns by
status, total runs, last WRS per target).

## Ready-to-use stack

A Prometheus + Grafana stack is provided as a **Docker profile** (optional):

```bash
POSTGRES_PASSWORD=... GRAFANA_PASSWORD=... \
  docker compose --profile monitoring up -d --build
```

- **Prometheus** scrapes `api:8080/metrics` (internal network, not exposed).
- **Grafana** on `127.0.0.1:3000` (access via SSH tunnel), with an
  auto-provisioned datasource and “WEDOS ShieldTest” dashboard:
  - Runs (total)
  - Campaigns by status
  - Last WRS per target (color thresholds: 50 / 70 / 85)

```bash
# from the local machine:
ssh -L 3000:127.0.0.1:3000 user@server   # then http://localhost:3000 (admin / GRAFANA_PASSWORD)
```

## Without Docker

Point an existing Prometheus at `http://<loopback-host>:8080/metrics` and import
`deploy/monitoring/grafana/dashboards/shieldtest.json` into Grafana.
