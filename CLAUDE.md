# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted Stremio addon (Node.js/Express) that searches torrents via **Prowlarr/Jackett** and streams them through **TorrServer** (github.com/YouROK/TorrServer), which prioritizes pieces on demand so the player can seek anywhere without waiting for a full download. Deliberately narrow scope: no Real-Debrid/TorBox/StremThru/qBittorrent/pure-P2P support — just Prowlarr/Jackett for search, TorrServer for playback. Stray `QBIT_*`/`ENABLE_PURE_P2P`/`STREMTHRU_*` vars in `.env` are leftovers from an earlier architecture and are not read by any code in this repo.

## Commands

```bash
npm test                   # full test suite (node's built-in test runner, no extra deps)
npm run test:coverage      # node --test --experimental-test-coverage

docker compose -f docker-compose.local.yaml up -d   # local dev stack — hot-reloads, see below
```

There is no configured lint script (`eslint` is a devDependency but there's no `eslint.config.*` in the repo and no `lint` script in `package.json`).

## Git workflow

After finishing each discrete task, make a small, briefly descriptive commit, then push it right away — don't let finished work sit uncommitted, and don't batch several unrelated tasks into one commit.

**Multiple agents work in this repo concurrently.** Because of that, a commit must contain *only* the files that task actually touched:

- Never `git add -A`/`git add .`. Stage files explicitly by path.
- Before committing, run `git status` (and `git diff --staged` if unsure) and confirm every staged file was actually part of this task — not something another agent left modified in the working tree.
- If `git push` is rejected because another agent pushed first, `git pull --rebase` (or merge) and retry — never force-push to reconcile.

## Guides

Each file below covers one area in depth — the reasoning and trade-offs behind how it's built, not just a description of what it does. Read the relevant one before working in that area; they're written to stand alone.

- @.claude/docs/dev-workflow.md — Docker local dev, why/how it hot-reloads, when a rebuild is actually needed
- @.claude/docs/testing.md — test harness layout, env isolation, what's deliberately not covered
- @.claude/docs/persistence.md — the Postgres-or-file pattern shared by `configStore`/`accessKeys`/`catalogs`, and the `cfg_<hash>` config-identity scheme
- @.claude/docs/stream-pipeline.md — the full `/stream` → `/play` request flow, the module doing the heaviest lifting in this app
- @.claude/docs/auth.md — the three separate, unrelated auth mechanisms and what each one actually gates
- @.claude/docs/catalogs-and-rss.md — RSS "recently added" catalog vs. admin-curated catalogs — two different features; also why ~half the seeded IMDb IDs were fabricated, how `scripts/verifyCatalogs.js` audits them, and why seed files ≠ the live store
- @.claude/docs/naming.md — the prowjack/TorrStremio → TorrESMIN rebrand, now complete
- @.claude/docs/gotchas.md — known bugs/traps found while working in this codebase, not yet fixed
