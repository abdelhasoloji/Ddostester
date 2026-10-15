# Operations and release identity

[Current setup](current-setup.md) is the dated observation of running hosts and services. Repository main, source archive identity, UI bundle and deployed release are separate facts.

## Install and develop

Use `.nvmrc`, npm workspaces and PostgreSQL for default single mode. Configure `.env.example` privately, keep `HOST=127.0.0.1`, a strong JWT secret and an authorized target allowlist. Build, preview/apply the explicit account migration, then start the API/UI as described in [README](../README.md) and [single-user setup](single-user.md). Memory fallback is for legacy team-mode fixtures, not the current deployment.

`deploy/setup.sh` provides initial systemd setup; Compose is an optional deployment model. Certificate material stays outside Git. Remote access can use the existing HTTPS/mTLS proxy on a public host or an SSH tunnel. The backend's loopback bind is not a restriction on an authorized HTTP target being public.

## Observe before changing

```sh
systemctl is-active ddostester
systemctl show ddostester -p WorkingDirectory
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/ready
```

Inspect only required non-secret fields. Do not print protected environment files. Health describes provider configuration, not complete DRS evidence or target health under load. Use fresh Fleet status for mission eligibility.

The Linux lab currently runs K3s in k3d; use the bundled client inside its server container or a matching explicitly scoped kubeconfig. Check namespace Pods/quota without deploying. [Kubernetes instructions](kubernetes-iot-lab.md) distinguish rendered resources from applied live resources.

## CI and promotion

`.github/workflows/ci.yml` defines quality/audit, frontend and backend coverage/build, required PostgreSQL and recovery checks. E2E and SLO workflows have their own explicit triggers/fixtures. `.github/workflows/deploy.yml` follows successful main push CI or manual dispatch on the self-hosted `vps1` runner.

The deploy workflow refuses local source changes, fetches the exact successful CI commit and extracts its versioned deployment script before executing it. It does not trust the older script present in the server checkout or reset that checkout.

`deploy/update.sh` requires a clean source checkout, fetches the expected commit, archives an immutable release, stamps API/UI builds with the full verified Git SHA, installs dependencies, runs verification and creates a release manifest. It promotes through a systemd drop-in only after verification, then checks API/UI readiness and source identity. Failure restores the previous service definition. It does not reset dirty source work or rewrite runtime secrets. Automatic promotion currently supports systemd; versioned containers require their own verified procedure.

Production's build-463 drop-in includes Fleet/catalogue environment overrides. The promotion script retains existing Environment/EnvironmentFile directives, including continuations, while replacing release paths. An updated WorkingDirectory alone does not establish equivalent configuration. Do not overwrite protected Secrets, account state, PVCs or the source-06 laboratory provenance with a production release.

## Backup, rollback and identity

Back up PostgreSQL and protected runtime configuration before migration/promotion. Operations scripts and systemd timer templates live in `scripts/operations/` and `deploy/operations/`. Validate encrypted restore into a disposable isolated database, including authentication and audit continuity. A backup file's existence is not a restore proof.

Retain the prior immutable release and drop-in; rollback selects that release, reloads/restarts systemd and verifies health, API/UI identity and required flags. Do not roll back by resetting local work or blindly replacing the database.

Source archives identify dirty work precisely but do not replace Git review/CI. See [source snapshots](source-snapshots.md), [testing](testing.md), [versioning](versioning.md) and [remaining qualification work](roadmap.md).
