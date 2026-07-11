# Implementation Plan: F05. Usage History Store and Query

**Prerequisites:** F01 (service foundation, `usage_history` schema) and F02 (token assignment, overflow eviction, and the durable history writer) are already implemented. F02 already owns and completes the write path (`src/services/historyWriter.ts`) — this plan covers only the read/query side.

### Stage 1: Query Service

**1. History Query Service** - Add the read-only service that checks a token's existence against the registry and returns its `usage_history` rows in chronological order, mapped to the public response shape. Reference the spec's Component Overview and Data Model sections for the exact fields, ordering, and existence-check approach.

### Stage 2: API Wiring

**2. Token History Route** - Extend the existing token resource router with the history endpoint, including path-parameter UUID validation and delegation to the query service. Reference the spec's API Contracts section for the route, request/response shapes, and error codes.

**3. Dependency Wiring** - Thread the database handle through the app factory, base router, and entrypoint so the history query service can be constructed alongside the existing assignment service. Reference the spec's Architecture Impact section for the affected files and data flow.
