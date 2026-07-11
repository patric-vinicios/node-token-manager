# Implementation Plan: F04. Token and Pool Listing

**Prerequisites:** F01 (Service Foundation and Token Pool Initialization) and F02 (Token Assignment and Overflow Eviction) implemented — `TokenRegistry.snapshot()`, `registry.available`/`registry.active`, and `ActiveInfo.activatedAtMonotonic` already exist and are populated by assignment.

### Stage 1: Listing Service

**1. Listing Service** - Add `src/services/listingService.ts` as a `createListingService(deps)` factory that reads `TokenRegistry.snapshot()` and the configured TTL, and produces the pool listing response (per-token state plus active-token user/activation/remaining-time fields, and the pool-wide available/active summary), following the spec's Component Overview and API Contracts.

### Stage 2: Route and Wiring

**2. Listing Route** - Extend `src/routes/tokens.ts` with a `GET /` handler that calls the listing service and returns its result as the response body, alongside the existing `POST /` assignment handler in the same router.

**3. Dependency Wiring** - Thread the configured TTL from startup through `src/index.ts`, `src/app.ts`, and `src/routes/index.ts` so the base router can construct the listing service and inject both it and the assignment service into the tokens router.
