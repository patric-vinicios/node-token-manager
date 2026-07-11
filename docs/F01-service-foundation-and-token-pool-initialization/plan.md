# Implementation Plan: F01. Service Foundation and Token Pool Initialization

**Prerequisites:**
- Node.js (LTS) and npm.
- TypeScript, Express, Zod.
- PostgreSQL instance reachable via `DATABASE_URL`.
- Drizzle ORM + drizzle-kit.
- Vitest (with supertest for HTTP integration tests).
- Environment variables: `DATABASE_URL` (required), `PORT`, `POOL_SIZE` (default 100), `TOKEN_TTL_SECONDS` (default 120), `API_BASE_PATH`.

## Stage 1: Project Scaffolding and Configuration

**1. Project setup** - Initialize the TypeScript Node project with Express, Drizzle, Zod, and Vitest, and lay out the source folder structure and build/test scripts described in the spec's Component Overview.

**2. Typed configuration module** - Build the configuration module that reads environment variables with defaults and validates them at startup, exposing pool size, TTL, port, base path, and the database URL. Refer to the spec for fields and fail-fast behavior.

**3. Shared utilities** - Add the logger and the typed error classes / error-code constants that establish the standard JSON error envelope reused by later features, as defined in the spec's API Contracts and Component Overview.

## Stage 2: Persistence Layer

**4. Database schema** - Define the Drizzle schema for the durable pool identity and audit tables, including columns, indexes, and constraints. See the spec's Data Model for the exact structure.

**5. Migrations and drizzle-kit config** - Configure drizzle-kit and generate the initial migration that creates the durable store. Reference the spec's Data Model migration example.

**6. Database client and migration runner** - Implement the pooled database client and the startup migration runner, with a connectivity check and a fail-fast error that identifies the store when connection or migration fails, per the spec's Technical Decisions.

## Stage 3: Pool Initialization and Registry

**7. In-memory token registry** - Create the process-local registry that tracks each token's active state, starts all-available, and exposes the available/active counts and the interface later features consume. See the spec's Component Overview.

**8. Pool initializer** - Implement the seed-or-load routine that seeds exactly 100 unique tokens on first boot and reloads the same identity set afterward, aborting on an inconsistent pool and retrying on duplicate UUIDs, as specified in the spec's Decisions and Data Model.

**9. Startup reconciliation** - Add the startup step that closes any orphaned open history entries left by a prior crash or restart, following the reconciliation decision in the spec.

## Stage 4: HTTP Surface and Startup Orchestration

**10. Express app factory** - Assemble the Express application with JSON body parsing, the base-path router mount point for future features, the not-found handler, and the central error-handling middleware, per the spec's Architecture and API Contracts.

**11. Health endpoint** - Implement the `GET /health` route that returns the service status with the current available and active counts from the registry, as defined in the spec's API Contracts.

**12. Startup orchestration and server bootstrap** - Wire the entrypoint to run the full startup sequence — load config, connect and migrate the database, seed or load the pool, initialize the registry, reconcile history, then bind the HTTP port — with fail-fast handling for a port already in use and the initialization log line described in the spec.
