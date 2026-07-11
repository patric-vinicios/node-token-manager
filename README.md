# Token Management Service

A standalone Node.js (TypeScript) HTTP/JSON service that governs concurrent
access to a limited resource through a fixed pool of exactly **100** pre-generated
UUID tokens. See [`token-management-service-prd.md`](token-management-service-prd.md)
for the full product spec.

This repository currently implements **F01 — Service Foundation and Token Pool
Initialization**: the scaffolding, configuration, PostgreSQL persistence, the
in-memory token registry, startup orchestration, and the `GET /health` endpoint
that every later feature (F02–F07) builds on.

## Stack

TypeScript · Express · PostgreSQL · Drizzle ORM + drizzle-kit · Zod · Vitest

## Prerequisites

- Node.js 20+ and npm
- A PostgreSQL instance (a `docker-compose.yml` is provided for local use)

## Setup

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL if needed
docker compose up -d          # starts Postgres on localhost:5432
npm run db:generate           # (already committed; regenerate only if schema changes)
npm run dev                   # start the service with reload
```

On boot the service loads config, connects and migrates the database, seeds the
100-token pool on first run (reloads the same identity set thereafter),
reconciles any orphaned history, and only then binds the HTTP port. If any step
fails it aborts before listening — the service never serves traffic in a degraded
state.

## Configuration

All configuration comes from environment variables, validated at startup:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `PORT` | no | `3000` | HTTP port (`0` = OS-assigned ephemeral port) |
| `API_BASE_PATH` | no | `/api` | Base path for business routes (F02+) |
| `POOL_SIZE` | no | `100` | Fixed pool size; immutable for the process lifetime |
| `TOKEN_TTL_SECONDS` | no | `120` | Active-token TTL (consumed by F03) |

## Endpoints

### `GET /health`

Readiness signal. Returns live pool counts, where `available + active` always
equals `POOL_SIZE`.

```json
{ "status": "ok", "available": 100, "active": 0 }
```

All errors use the standard envelope established here and reused by later
features:

```json
{ "status": "error", "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with reload (tsx) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the Vitest suite (needs Postgres running) |
| `npm run typecheck` | Type-check without emitting |
| `npm run db:generate` | Generate a Drizzle migration from the schema |
| `npm run db:migrate` | Apply migrations against `DATABASE_URL` |

## Tests

Unit tests cover the config module and the in-memory registry. Integration
tests run against a real PostgreSQL (from `docker compose up -d`) to exercise
migrations, seed-or-load, startup reconciliation, the `tokens ⇄ usage_history`
foreign key, and `GET /health` end-to-end.

```bash
docker compose up -d
npm test
```

## Project layout

```
src/
  index.ts                  Startup orchestration + server bootstrap
  app.ts                    Express app factory
  config/index.ts           Zod-validated environment config
  db/schema.ts              Drizzle schema: tokens, usage_history
  db/client.ts              pg Pool + Drizzle instance
  db/migrate.ts             Startup migration runner
  registry/tokenRegistry.ts In-memory active-state registry
  services/poolInitializer.ts  Seed-or-load pool + reconcile history
  routes/health.ts          GET /health
  routes/index.ts           Base router (mount point for F02+)
  middleware/               errorHandler, notFound (standard envelope)
  lib/                      logger, errors
drizzle/                    Generated SQL migrations
tests/                      unit + integration suites
```
