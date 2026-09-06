# CI/CD

GitHub Actions workflows drive integration, deployment and the resilience gate.

| Workflow | File                             | Trigger                             | Purpose                          |
| -------- | -------------------------------- | ----------------------------------- | -------------------------------- |
| CI       | `.github/workflows/ci.yml`       | push to `main`, every pull request  | lint → typecheck → test → build  |
| E2E      | `.github/workflows/e2e.yml`      | push / PR                           | Playwright browser smoke         |
| Deploy   | `.github/workflows/deploy.yml`   | after CI succeeds on `main`; manual | update the service on the server |
| SLO gate | `.github/workflows/slo-gate.yml` | manual dispatch (lab target)        | bounded campaign → SLO pass/fail |

## SLO gate (EPIC C)

Makes resilience a delivery criterion instead of an after-the-fact report. The
job starts the control plane with `ALLOWED_TARGETS` scoped to just the dispatch
target, runs **one bounded campaign** against it through the normal
allowlist/caps/approval path, and applies the gate
(`backend/src/modules/campaigns/slogate.ts`): it fails if a configured SLO is
missed or if WRS regressed beyond the tolerance band vs. the previous run.

- **Decision logic is pure and unit-tested**; the CLI (`npm run slogate -w
backend`) only orchestrates a run and applies it.
- **Safeguards:** the target must be allowlisted (the server rejects anything
  else), the load is well under `HARD_CAPS`, and the job carries an absolute
  `timeout-minutes`. No attack vector is added.
- **Thresholds** are env-driven (`SLO_MIN_WRS`, `SLO_MAX_P95_MS`,
  `SLO_MAX_ERROR_RATE_PCT`, `SLO_MIN_AVAILABILITY_PCT`,
  `SLO_MAX_ASSERTION_FAILURE_PCT`, `SLO_REGRESSION_TOLERANCE_PTS`).

It is **manual-dispatch only** until a lab target is reachable from CI; uncomment
the `schedule` in the workflow to run it nightly.

## Flow

```
push / PR ──► CI (lint, typecheck, test, build)
                     │ success on main
                     ▼
              Deploy ──► self-hosted runner on the server:
                         deploy/update.sh
                         (fetch main, npm ci, build, test, restart)
```

Deploy runs **only** when CI is green on `main`, so a red build never reaches the
server. It can also be started manually from the Actions tab (**Run workflow**),
optionally choosing a branch to deploy (rollback). Once set up, **no manual
deploy commands are needed** — every green push to `main` deploys itself.

## Deployment model: self-hosted runner

Deploy runs on a **self-hosted GitHub Actions runner installed on the WEDOS
server**. The runner polls GitHub outbound (HTTPS 443), so:

- no inbound SSH and no firewall changes — the app stays loopback-only,
- no SSH key or deploy secrets stored in GitHub,
- the deploy runs locally, updating the existing `~/ddostester` clone in place.

The job runs `deploy/update.sh` in the service repo (default `~/ddostester`,
override with the `DDOSTESTER_DIR` env var on the runner).

## Provisioning vs update

- **`deploy/setup.sh`** — one-time provisioning, run by hand on the server. Writes
  the systemd unit and the runtime secrets (`/etc/ddostester.env`).
- **`deploy/update.sh`** — what CD runs on every deploy. Fetches the branch,
  `npm ci`, build, test, restarts the service. It **never** touches the systemd
  unit or the secrets file, so automated deploys can't erase your configuration.

## One-time server setup

Run as the deploy user (the one that owns `~/ddostester` and runs the service,
e.g. `at264`).

**1. Passwordless sudo for the restart** (`update.sh` runs `sudo -n systemctl restart ddostester`):

```bash
echo "$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart ddostester" \
  | sudo tee /etc/sudoers.d/ddostester-deploy
sudo chmod 440 /etc/sudoers.d/ddostester-deploy
```

**2. Install the self-hosted runner.** In GitHub: **repo → Settings → Actions →
Runners → New self-hosted runner** (Linux x64). Copy the exact download + token
commands it shows (the token is single-use), which look like:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/download/vX.Y.Z/actions-runner-linux-x64-X.Y.Z.tar.gz
tar xzf runner.tar.gz
./config.sh --url https://github.com/abdelhasoloji/Ddostester --token <TOKEN> --unattended
```

Then install it as a service so it survives reboots and runs as the deploy user:

```bash
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
```

The runner needs `git`, `node`/`npm` and `bash` on its PATH (already present from
the standard server setup). That's it — no secrets to add in GitHub.

## Rollback

- **Redeploy a previous commit:** Actions → Deploy → **Run workflow**, set the
  branch/ref to deploy.
- **On the server directly:** `git -C ~/ddostester reset --hard <good-sha> && bash deploy/update.sh`.

## Security notes

- Least privilege: `permissions: contents: read`, and no inbound network exposure
  (the runner dials out to GitHub; nothing dials into the server).
- No SSH keys or deploy secrets are stored in GitHub.
- Passwordless sudo is scoped to exactly one command (`systemctl restart ddostester`).
- A `concurrency` group serializes deploys so two never overlap.

## Alternative: SSH from a GitHub-hosted runner

If you prefer not to run a self-hosted runner and the server's SSH is reachable
from GitHub's IP ranges, the deploy job can instead SSH in from a GitHub-hosted
runner (`runs-on: ubuntu-latest`) using `DEPLOY_HOST` / `DEPLOY_USER` /
`DEPLOY_SSH_KEY` secrets and running `deploy/update.sh` over SSH. The self-hosted
model above is recommended for this internal, loopback-only tool.
