# Implementation Plan: F03. Automatic TTL Release

**Prerequisites:**
- F02 implemented and running: synchronous `TokenRegistry` with `release(tokenId)` (already idempotent) and `snapshot()`, and `ActiveInfo.activatedAtMonotonic` populated on every assignment.
- F01 implemented: Zod-validated config exposing `TOKEN_TTL_SECONDS` (default 120), and the `usage_history` schema with `ReleaseReason.TTL` already reserved.
- Node.js (LTS), TypeScript, Express, Drizzle ORM, Vitest + supertest (all already in the project) — no new dependencies.
- A reachable PostgreSQL via `DATABASE_URL` for the durable history close and for integration tests.
- No new environment variables — `TOKEN_TTL_SECONDS` already exists; only `src/index.ts` changes to read and wire it into the new sweeper.

### Stage 1: Durable History Close Path

**1. History writer close operation** - Extend the durable history writer with a new operation that closes a token's already-open hold without opening a new one, distinct from its existing open-then-close-on-eviction path, reusing its per-token ordering guarantee and retry/backoff buffer so the close is never lost and never races a later reassignment for the same token. See the spec's Technical Decisions and Data Model.

### Stage 2: Periodic Sweep and Lifecycle Wiring

**2. TTL sweep service** - Build the background component that periodically scans the in-memory registry for active tokens whose elapsed time, measured via monotonic time, has reached the configured TTL, releases each due token through the registry's existing release operation, and routes its history closure through the writer — isolating any single-tick failure so the sweep keeps running on schedule. Refer to the spec's Architecture Impact and Component Overview.

**3. Startup and shutdown wiring** - Construct and start the sweep service during service bootstrap, after the registry and history writer are ready, and stop it as part of the graceful shutdown sequence alongside the existing history-writer flush. See the spec's Component Overview.
