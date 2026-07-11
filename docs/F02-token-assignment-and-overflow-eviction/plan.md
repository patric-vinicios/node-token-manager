# Implementation Plan: F02. Token Assignment and Overflow Eviction

**Prerequisites:**
- F01 implemented and running: Express app factory, typed config, `TokenRegistry`, Drizzle `usage_history` schema, and the standard error envelope.
- Node.js (LTS), TypeScript, Express, Zod, Drizzle ORM (all already in the project).
- A reachable PostgreSQL via `DATABASE_URL` for durable history writes and integration tests.
- Vitest + supertest for tests.
- No new environment variables (`API_BASE_PATH`, `POOL_SIZE`, `TOKEN_TTL_SECONDS` are already defined by F01).

## Stage 1: Registry Acquisition and Eviction

**1. Registry acquire method** - Extend the in-memory token registry with a single synchronous acquisition operation that selects an available token, or — when none is available — evicts the oldest active token and reuses it, then activates it for the new holder. It must complete without yielding the event loop so the 100-token cap holds under concurrency, and it must report the evicted prior holder so history can be closed. See the spec's Technical Decisions and Component Overview.

## Stage 2: Durable History Writer

**2. History writer** - Create the service that durably records each assignment in the existing history store: open a new hold on assignment and, on eviction, close the evicted token's open entry with the eviction reason and open the new one atomically. Refer to the spec's Data Model for the write patterns.

**3. Retry buffer and shutdown flush** - Add the in-memory retry-with-backoff buffer so a history-store failure never blocks or fails an assignment, and a flush hook that drains pending events during graceful shutdown, as described in the spec's Technical Decisions.

## Stage 3: HTTP Endpoint and Wiring

**4. Request validation** - Validate the incoming `{ userId }` body as a UUID and reject a missing or malformed value with the standard 400 validation error, reusing the F01 error conventions. See the spec's API Contracts.

**5. Assignment service and route** - Implement the assignment endpoint and the service that builds the activation timestamps, invokes the registry acquisition, and records history — returning a successful response regardless of the history store's outcome. Mount the route under the base path per the spec's API Contracts.

**6. Application wiring** - Thread the history writer through the app factory and base router, construct it with the database handle at startup, and flush it on shutdown, following the spec's Architecture Impact and Component Overview.
