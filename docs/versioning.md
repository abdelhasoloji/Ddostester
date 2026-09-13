# Versioning & releases

WEDOS ShieldTest uses **Semantic Versioning** with **Conventional Commits**, a
generated **CHANGELOG**, and **tag-driven GitHub Releases**.

## The version, end to end

- The single source of truth is `version` in the root `package.json` (SemVer
  `MAJOR.MINOR.PATCH`).
- `scripts/build-info.mjs` stamps `dist/build-info.json` at build time with the
  version, a monotonic build number (`git rev-list --count HEAD`), the short
  commit, and the build timestamp.
- `backend/src/version.ts` (`getBuildInfo`) reads both and exposes them on
  `GET /health` (`version.version` / `.build` / `.commit` / `.builtAt`); the UI
  footer shows `version+build · commit`.

## When to bump (SemVer)

- **PATCH** (`0.2.0 → 0.2.1`): a fix with no behaviour change for existing
  campaigns (bug fix, measurement correction, UI fix).
- **MINOR** (`0.2.0 → 0.3.0`): a backward-compatible feature (a new load lever, a
  new engine capability, a new page).
- **MAJOR** (`0.x → 1.0`, then `1 → 2`): a breaking change to the API, the WRS
  contract, the RBAC model, or the safety caps. Treat any cap/boundary change as
  at least MINOR and review it as a security change (see `safeguards.md`).

## Commit convention

Commits follow `type(scope): subject` (e.g. `feat(engine): cache-busting`), with
a `!` after the type for a breaking change. Types drive the changelog grouping:
`feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `ci`, `build`, `chore`.

## Cutting a release

1. Bump `version` in `package.json`.
2. Regenerate the changelog: `npm run changelog -- --write` (prepends the new
   version's section, grouped by commit type, since the last tag).
3. Merge to `main`.
4. `.github/workflows/release.yml` sees the version change, creates the git tag
   `vX.Y.Z` (if absent), and publishes a **GitHub Release** whose body is that
   version's CHANGELOG section. The deploy pipeline (`deploy.yml`) is unaffected —
   it runs independently on CI success, as before.

`npm run changelog` (no `--write`) prints the pending section to stdout for a
preview.
