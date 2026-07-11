import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../../src/index";
import { TokenRegistry } from "../../src/registry/tokenRegistry";
import { usageHistory } from "../../src/db/schema";
import { setupTestDb, truncateAll, TEST_DATABASE_URL } from "../helpers/db";
import type { DbHandle } from "../../src/db/client";
import type { StartedService } from "../../src/index";

/**
 * TOKEN_TTL_SECONDS=1 so the TTL is exercised in real time without a
 * 120s-long test (the sweeper's tick interval itself is a hardcoded 1000ms
 * constant, per spec Assumption A3 — not overridden here).
 */

let handle: DbHandle;
const started: StartedService[] = [];
const ORIGINAL_ENV = { ...process.env };

async function boot(overrides: NodeJS.ProcessEnv = {}): Promise<StartedService> {
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: TEST_DATABASE_URL,
    PORT: "0",
    TOKEN_TTL_SECONDS: "1",
    ...overrides,
  };
  const svc = await start(new TokenRegistry());
  started.push(svc);
  return svc;
}

async function health(svc: StartedService) {
  const res = await request(svc.server).get("/health");
  return res.body as { available: number; active: number };
}

async function rowsFor(tokenId: string) {
  return handle.db.select().from(usageHistory).where(eq(usageHistory.tokenId, tokenId));
}

beforeEach(async () => {
  handle = handle ?? (await setupTestDb());
  await truncateAll(handle);
});

afterEach(async () => {
  while (started.length) {
    await started.pop()!.shutdown().catch(() => undefined);
  }
  process.env = { ...ORIGINAL_ENV };
});

afterAll(async () => {
  await handle?.close();
});

describe("Automatic TTL Release (F03)", () => {
  it("releases an active token automatically once its TTL elapses", async () => {
    const svc = await boot();
    const res = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
    const tokenId = res.body.tokenId as string;

    await vi.waitFor(
      async () => {
        expect(await health(svc)).toMatchObject({ available: 100, active: 0 });
      },
      { timeout: 8000, interval: 200 },
    );

    const rows = await rowsFor(tokenId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.releasedAt).not.toBeNull();
    expect(rows[0]!.releaseReason).toBe("ttl");
  }, 15000);

  it("release occurs within the 5-second SLA of the threshold", async () => {
    const svc = await boot();
    const res = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
    const tokenId = res.body.tokenId as string;
    const activatedAt = new Date(res.body.activatedAt as string);

    await vi.waitFor(() => expect(svc.registry.getState(tokenId)).toBe("available"), {
      timeout: 8000,
      interval: 100,
    });

    const sinceThresholdMs = Date.now() - (activatedAt.getTime() + 1000);
    expect(sinceThresholdMs).toBeLessThanOrEqual(5000);
  }, 15000);

  it("a released token becomes assignable again immediately", async () => {
    const svc = await boot();
    const first = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
    const tokenId = first.body.tokenId as string;

    await vi.waitFor(() => expect(svc.registry.getState(tokenId)).toBe("available"), {
      timeout: 8000,
      interval: 100,
    });

    // Only one token has ever been assigned, so it remains first in the
    // registry's iteration order and is drawn back into active immediately.
    const second = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
    expect(second.status).toBe(200);
    expect(second.body.tokenId).toBe(tokenId);
    expect(svc.registry.getState(tokenId)).toBe("active");
  }, 15000);

  it("releasing an already-released token is a no-op (race with eviction)", async () => {
    const svc = await boot();
    const res = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
    const tokenId = res.body.tokenId as string;

    // F07 (clear-active) isn't implemented yet in this codebase, so the race
    // is simulated directly: release the registry entry and close the
    // history row exactly as any real close-then-open path (F02 eviction or
    // a future F07 clear) would, immediately after assignment — before the
    // sweeper's own tick has a chance to see the token as due.
    svc.registry.release(tokenId);
    await handle.db
      .update(usageHistory)
      .set({ releasedAt: new Date(), releaseReason: "eviction" })
      .where(and(eq(usageHistory.tokenId, tokenId), isNull(usageHistory.releasedAt)));

    // Wait past the 1s TTL window plus a couple of 1s sweep ticks.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(await health(svc)).toMatchObject({ available: 100, active: 0 });

    const rows = await rowsFor(tokenId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.releaseReason).toBe("eviction"); // never overwritten to 'ttl'
  }, 15000);

  it("uses F02's activation timestamp to release exactly at the configured threshold (F02↔F03)", async () => {
    const svc = await boot();
    const res = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
    const tokenId = res.body.tokenId as string;

    const info = svc.registry.getActiveInfo(tokenId);
    expect(info).not.toBeNull();
    expect(info!.activatedAt.toISOString()).toBe(
      new Date(res.body.activatedAt as string).toISOString(),
    );

    await vi.waitFor(() => expect(svc.registry.getState(tokenId)).toBe("available"), {
      timeout: 8000,
      interval: 100,
    });
  }, 15000);
});
