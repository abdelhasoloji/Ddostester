# Changelog

All notable changes, grouped by Conventional-Commit type.

## v0.2.0 — 2026-09-13

### 🚀 Features

- **command-center**: "steps that floored the target" impact leaderboard (E16) (`d74e593`)
- **measurement**: breaking-point detection — the exact rps where the target broke (P5) (`0ad6848`)
- **k6**: correlation — authenticated journeys at high rate (P6) (`0367d6f`)
- **engine**: no-keep-alive mode — fresh connection per request (P3) (`694c41e`)
- **recon**: rank the surface by cost-to-origin, target dynamic paths first (P1) (`011b193`)
- **engine**: cache-busting — force GET floods through to the origin (P1/P2) (`4d1b528`)
- **suite**: live countdown timer on the recovery gate (`3cbccf5`)
- **rbac**: roles overhaul — ciso approves / engineer launches / admin administers / viewer views (`6974d59`)
- **alerts**: investigation-ready alerts (E10) + vector-aware protection message (E12) (`e809991`)
- **campaigns**: config-time delivery hint — predict engine routing & under-delivery (E13) (`9756abf`)
- **scenarios**: dedupe baselines at compose + a curated "Full review" playbook (`47d39b3`)
- route high-rate endpoint mixes to vegeta + bound the compose basket (`397dcc7`)
- **ui**: a self-service account space + de-scatter Settings (E3, E4, E9) (`b24b8d9`)

### 🐛 Fixes

- **measurement**: don't score a target that's SERVING as down — probe-contention correction (PF1) (`ef64398`)
- **ui**: timeline y-axis collapses to [0,1] hiding the rate line (`f00fdbc`)
- **ui**: timeline x-axis stuck at 1–2s — force the x-scale to the data extent (`c53b3de`)
- **rbac**: canonicalise legacy `officer` on the ENFORCEMENT path + rebase fixes (`db9545a`)
- **engines**: auto-route high-CONCURRENCY floods off the event loop + flag self-inflicted kills (`5da38ff`)
- **engines**: size vegeta workers to the rate + persist the runtime engine (`5087fe4`)
- **ui**: portal the notifications panel + clear timeline empty-state (`6a8596f`)
- **vegeta**: bound attack memory + cap the service so it can't OOM the host (`ac17b1f`)

### 📚 Docs

- consolidate the scattered docs into topic hubs, re-sourced (E6) (`dde972a`)
- lab état-des-lieux + engine strategy (E7, E8) (`baed5da`)
