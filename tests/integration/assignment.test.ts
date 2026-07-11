import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../../src/index";
import { TokenRegistry } from "../../src/registry/tokenRegistry";
import { tokens, usageHistory } from "../../src/db/schema";
import { countRows, setupTestDb, truncateAll, TEST_DATABASE_URL } from "../helpers/db";
import type { DbHandle } from "../../src/db/client";
import type { StartedService } from "../../src/index";

let handle: DbHandle;
const started: StartedService[] = [];
const ORIGINAL_ENV = { ...process.env };

async function boot(): Promise<StartedService> {
  process.env = { ...ORIGINAL_ENV, DATABASE_URL: TEST_DATABASE_URL, PORT: "0" };
  const svc = await start(new TokenRegistry());
  started.push(svc);
  return svc;
}

/** Rows in usage_history that are still open (active hold) for a token. */
async function openRows(tokenId: string) {
  return handle.db
    .select()
    .from(usageHistory)
    .where(and(eq(usageHistory.tokenId, tokenId), isNull(usageHistory.releasedAt)));
}

async function health(svc: StartedService) {
  const res = await request(svc.server).get("/health");
  return res.body as { available: number; active: number };
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

describe("POST /api/tokens — assignment (F02)", () => {
  it("assigns a token for a valid userId and returns the hold", async () => {
    const svc = await boot();
    const userId = randomUUID();

    const res = await request(svc.server).post("/api/tokens").send({ userId });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(res.body.tokenId).toBeTypeOf("string");
    expect(new Date(res.body.activatedAt).toString()).not.toBe("Invalid Date");
    // The token is one of the fixed pool and is now active.
    expect(svc.registry.has(res.body.tokenId)).toBe(true);
    expect(svc.registry.getState(res.body.tokenId)).toBe("active");
  });

  it("transitions the assigned token from available to active", async () => {
    const svc = await boot();
    const before = await health(svc);
    expect(before).toMatchObject({ available: 100, active: 0 });

    await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });

    const after = await health(svc);
    expect(after.available).toBe(99);
    expect(after.active).toBe(1);
    expect(after.available + after.active).toBe(100);
  });

  it("rejects a missing or non-UUID userId with 400 and changes no state", async () => {
    const svc = await boot();

    const missing = await request(svc.server).post("/api/tokens").send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");

    const bad = await request(svc.server).post("/api/tokens").send({ userId: "not-a-uuid" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");

    expect(svc.registry.active).toBe(0);
    expect(await countRows(handle, "usage_history")).toBe(0);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const svc = await boot();
    const res = await request(svc.server)
      .post("/api/tokens")
      .set("Content-Type", "application/json")
      .send("{ not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("records exactly one history entry per assignment", async () => {
    const svc = await boot();
    const n = 5;
    for (let i = 0; i < n; i++) {
      await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
    }
    // n distinct available tokens assigned → n rows, all open (no eviction yet).
    expect(await countRows(handle, "usage_history")).toBe(n);
    const open = await handle.db
      .select()
      .from(usageHistory)
      .where(isNull(usageHistory.releasedAt));
    expect(open).toHaveLength(n);
  });

  it("evicts the oldest token at a full pool and still returns a token", async () => {
    const svc = await boot();

    // Fill the pool; the first assignment holds the oldest token.
    const tokenIdsInOrder: string[] = [];
    for (let i = 0; i < 100; i++) {
      const res = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
      tokenIdsInOrder.push(res.body.tokenId);
    }
    expect(svc.registry.active).toBe(100);
    const oldestTokenId = tokenIdsInOrder[0]!;

    // The 101st assignment must evict the oldest and reuse it.
    const evictingUser = randomUUID();
    const res = await request(svc.server).post("/api/tokens").send({ userId: evictingUser });

    expect(res.status).toBe(200);
    expect(res.body.tokenId).toBe(oldestTokenId);
    expect(svc.registry.active).toBe(100); // still capped at 100

    // The evicted token's first hold is closed with reason 'eviction'; a new hold is open.
    const rows = await handle.db
      .select()
      .from(usageHistory)
      .where(eq(usageHistory.tokenId, oldestTokenId))
      .orderBy(asc(usageHistory.startedAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.releasedAt).not.toBeNull();
    expect(rows[0]!.releaseReason).toBe("eviction");
    expect(rows[1]!.releasedAt).toBeNull();
    expect(rows[1]!.userId).toBe(evictingUser);
  });

  it("holds the 100-cap under 500 concurrent assignments with no double-assignment", async () => {
    const svc = await boot();

    const results = await Promise.all(
      Array.from({ length: 500 }, () =>
        request(svc.server).post("/api/tokens").send({ userId: randomUUID() }),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(svc.registry.active).toBe(100);

    const afterHealth = await health(svc);
    expect(afterHealth.active).toBe(100);
    expect(afterHealth.available).toBe(0);

    // No token may hold two open history rows at once (no double-assignment).
    const dupes = await handle.db.execute<{ token_id: string; c: number }>(sql`
      SELECT token_id, count(*)::int AS c
      FROM usage_history
      WHERE released_at IS NULL
      GROUP BY token_id
      HAVING count(*) > 1
    `);
    expect(dupes.rows).toHaveLength(0);
  });
});

describe("cross-feature integration (F02)", () => {
  it("draws only from the seeded pool (F01↔F02)", async () => {
    const svc = await boot();
    const seeded = new Set(
      (await handle.db.select({ id: tokens.id }).from(tokens)).map((r) => r.id),
    );

    for (let i = 0; i < 20; i++) {
      const res = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
      expect(seeded.has(res.body.tokenId)).toBe(true);
    }
  });

  it("produces a durable history record for every assignment (F02↔F05)", async () => {
    const svc = await boot();
    const userId = randomUUID();
    const res = await request(svc.server).post("/api/tokens").send({ userId });

    const rows = await openRows(res.body.tokenId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userId);
    expect(rows[0]!.startedAt).toBeInstanceOf(Date);
  });

  it("sets a TTL-ready activation timestamp (F02↔F03)", async () => {
    const svc = await boot();
    const res = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });

    const info = svc.registry.getActiveInfo(res.body.tokenId);
    expect(info).not.toBeNull();
    // Wall-clock (reporting) and monotonic (TTL reference) are both set.
    expect(new Date(res.body.activatedAt).getTime()).toBe(info!.activatedAt.getTime());
    expect(info!.activatedAtMonotonic).toBeTypeOf("number");
  });
});
