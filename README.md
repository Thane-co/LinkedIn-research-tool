# Viral Post Research Tool

Single-user, fully-local research tool for finding viral social posts (LinkedIn + Twitter/X).
Scrapes via Apify → stores in local SQLite → enriches with embeddings + an x-factor score →
filterable UI with on-demand image grouping and content clustering. BYO API keys.

- **Source of truth:** [docs/prd-research-tool.md](docs/prd-research-tool.md)
- **Working rules & invariants:** [CLAUDE.md](CLAUDE.md)

## Status: scaffold

The directory tree, tooling, and declarative spec files (`lib/config.ts`, `lib/types.ts`,
`lib/db/schema.sql`) are in place. Everything with behavior is a **stub that throws
`Not implemented`** — implement it test-first, bottom-up by dependency layer (PRD §12):

```
Layer 0  lib/pure/*        pure logic (100% coverage)
Layer 1  lib/config.ts, lib/types.ts
Layer 2  lib/db/*, lib/apify.ts, lib/voyage.ts, lib/anthropic.ts, lib/settings.ts
Layer 3  jobs/*
Layer 4  app/api/*
Layer 5  app/*.tsx
```

Do not start a layer until the one below it is green.

## Commands

```bash
npm install            # first, to resolve types (next/react/better-sqlite3/vitest)
npm run dev            # run locally; DB auto-migrates on first run
npm test               # full Vitest suite
npm test -- <path>     # one file, e.g. tests/unit/pure/x-factor.test.ts
npm run test:coverage  # coverage (>=80% global, 100% on lib/pure/*)
npm run typecheck      # tsc --noEmit (strict, no any)
```

## Setup

BYO keys are entered in-app (Settings), never in code. `.env.local` holds only `DB_PATH`.
