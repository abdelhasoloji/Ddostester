# CI/CD

Two GitHub Actions workflows drive integration and deployment.

| Workflow | File                           | Trigger                             | Purpose                           |
| -------- | ------------------------------ | ----------------------------------- | --------------------------------- |
| CI       | `.github/workflows/ci.yml`     | push to `main`, every pull request  | lint → typecheck → test → build   |
| Deploy   | `.github/workflows/deploy.yml` | after CI succeeds on `main`; manual | SSH into the server and update it |

## Flow

```
push / PR ──► CI (lint, typecheck, test, build)
                     │ success on main
                     ▼
              Deploy ──SSH──► server: deploy/update.sh
                                (fetch main, npm ci, build, test, restart)
```

Deploy runs **only** when CI is green on `main`, so a red build never reaches the
server. It can also be started manually from the Actions tab
(**Run workflow**), optionally choosing a branch to deploy (rollback).

## Provisioning vs update

- **`deploy/setup.sh`** — one-time provisioning, run by hand on the server. Writes
  the systemd unit and the runtime secrets (`/etc/ddostester.env`).
- **`deploy/update.sh`** — what CD runs on every deploy. Fetches the branch,
  `npm ci`, build, test, restarts the service. It **never** touches the systemd
  unit or the secrets file, so automated deploys can't erase your configuration.

## Required secrets

Add these under **Settings → Secrets and variables → Actions** (repository, or
scoped to a `production` environment for extra protection rules):

| Secret               | Required | Description                                                          |
| -------------------- | -------- | -------------------------------------------------------------------- |
| `DEPLOY_HOST`        | yes      | Server hostname or IP reachable over SSH                             |
| `DEPLOY_USER`        | yes      | SSH user (see sudo requirement below)                                |
| `DEPLOY_SSH_KEY`     | yes      | Private SSH key (PEM) whose public half is authorized on the server  |
| `DEPLOY_PORT`        | no       | SSH port (default `22`)                                              |
| `DEPLOY_PATH`        | no       | Repo clone path on the server (default `~/ddostester`)               |
| `DEPLOY_KNOWN_HOSTS` | no       | Server host key(s). If absent, the runner trusts on first use (TOFU) |

Get the host key for `DEPLOY_KNOWN_HOSTS` (pinned host verification, recommended):

```bash
ssh-keyscan -p 22 <server-host>
```

## Server prerequisites

1. **A dedicated deploy SSH key.** Generate a keypair, add the public key to the
   deploy user's `~/.ssh/authorized_keys`, and store the private key as
   `DEPLOY_SSH_KEY`.
2. **Passwordless sudo for the restart.** `deploy/update.sh` runs
   `sudo -n systemctl restart ddostester` non-interactively. Grant only that:

   ```bash
   # /etc/sudoers.d/ddostester-deploy  (edit with: sudo visudo -f ...)
   deployuser ALL=(root) NOPASSWD: /usr/bin/systemctl restart ddostester
   ```

3. **The clone can fetch `origin`.** The repo at `DEPLOY_PATH` must be able to
   `git fetch origin` (deploy key with read access — see `deployment.md`).
4. **Network reachability.** GitHub-hosted runners connect from GitHub's IP
   ranges. If the server's SSH is firewalled, either allow those ranges or use a
   [self-hosted runner](https://docs.github.com/actions/hosting-your-own-runners)
   inside the network. Only SSH is used — the app itself stays loopback-only.

## Rollback

- **Redeploy a previous commit:** Actions → Deploy → **Run workflow**, set the
  branch/ref to deploy.
- **On the server directly:** `git -C ~/ddostester reset --hard <good-sha> && bash deploy/update.sh`.

## Security notes

- The workflow uses least privilege (`permissions: contents: read`) and never
  prints secrets (they are passed via masked env vars, not interpolated into the
  script).
- The private key is written only to the runner's `~/.ssh` and removed after the
  run.
- A `concurrency` group serializes deploys so two never overlap.
- Prefer setting `DEPLOY_KNOWN_HOSTS` so the runner verifies the server's
  identity instead of trusting it on first use.
