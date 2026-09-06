# Contributing

The whole workflow is one command. If it passes, CI passes.

## Setup (once)

```bash
nvm use            # picks the Node version from .nvmrc (>= 22)
npm install        # installs workspaces AND enables the git hooks
```

`npm install` runs the `prepare` script, which points git at `.githooks/`.
No husky, no extra tooling — just tracked hooks.

## Daily loop

```bash
npm run dev:api    # backend on :8080 (terminal 1)
npm run dev:web    # frontend on :5173, proxies /api to :8080 (terminal 2)
```

## Before you push

```bash
npm run verify     # lint + typecheck + test + build — exactly what CI runs
```

You don't have to remember it: the **pre-push hook** runs `verify:fast`
(lint + typecheck + test) automatically, so a red branch never reaches the
remote. Real emergency? `git push --no-verify` (CI still guards `main`).

## The single source of truth for "green"

| Where         | Command                                          |
| ------------- | ------------------------------------------------ |
| Local, full   | `npm run verify`                                 |
| Pre-push hook | `npm run verify:fast`                            |
| CI            | the same discrete steps + `npm ci` + `npm audit` |

There is only one definition of green. Change it in `package.json` and every
surface follows.

## Branch protection (repo admins, one-time)

On GitHub → Settings → Branches → protect `main`:

- Require the **CI** status check to pass before merging.
- Require branches to be up to date before merging.
- Disallow direct pushes (PRs only); prefer a linear history.

That turns the local hook (advisory) into an enforced gate no one can bypass.
