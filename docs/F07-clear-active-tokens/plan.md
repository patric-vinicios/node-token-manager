# Implementation Plan: F07. Clear Active Tokens

**Prerequisites:**
- F01 implemented and running: Express app factory, typed config, `TokenRegistry`, Drizzle `usage_history` schema (including the reserved `ReleaseReason.CLEAR` value), and the standard error envelope.
- F02 implemented and running: the tokens router, the `historyWriter` with its `db.transaction`-based close pattern and per-token `tokenChains` write ordering, and the app-level wiring that injects `registry`/`historyWriter` into `createApiRouter`.
- Node.js (LTS), TypeScript, Express, Zod, Drizzle ORM (all already in the project).
- A reachable PostgreSQL via `DATABASE_URL` for durable history writes and integration tests.
- Vitest + supertest for tests.
- No new environment variables or schema migrations.

## Stage 1: Registry Bulk Release

**1. Registry releaseAll method** - Extend the in-memory token registry with a single synchronous bulk-release operation that captures every currently active token's holder information, returns each of them to available, and reports the full set of released tokens in one uninterrupted event-loop turn, preserving the same atomicity guarantee the existing acquisition method relies on. See the spec's Technical Decisions and Component Overview.

## Stage 2: Durable Clear and HTTP Endpoint

**2. History writer bulk clear** - Add the durable operation that closes the open history entry for every released token in a single atomic transaction, coordinating with the existing per-token write ordering so no in-flight write for one of those tokens can land after the close, and falling back to the established retry buffer on failure without ever blocking the caller. Refer to the spec's Data Model and Technical Decisions for the write pattern and the failure-handling trade-off.

**3. Clear service and endpoint** - Implement the orchestration that invokes the registry release, hands the result to the durable close without waiting on it, and returns the cleared count, exposed as a new endpoint mounted as a literal path segment ahead of any parameterized token route. Mount and contract details are in the spec's API Contracts and Architecture Impact.
