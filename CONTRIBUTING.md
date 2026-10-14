# Contributing

Read [AGENTS.md](AGENTS.md), the [current setup](docs/current-setup.md) and [roadmap](docs/roadmap.md). Preserve local work; update behavioral documentation with code changes. Standard reference/profile changes require versioning and traceable interpretation, not edits to pinned files.

Use `.nvmrc`, `npm ci` and the [verification gates](docs/testing.md). `npm run verify` runs lint, typecheck, tests and build; the tracked pre-push hook runs the fast subset. CI also checks coverage, dependencies and PostgreSQL/recovery contracts. Required live evidence cannot be replaced with mocks.

Describe the concrete resulting behavior, validation and remaining external dependencies in commits/PRs. Keep credentials and private artifacts outside Git. Public/private authorized HTTP targets are supported through the actual admission policy; avoid documentation that incorrectly bans supported workflows or claims unimplemented integrations.
