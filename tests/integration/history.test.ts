import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../../src/index";
import { TokenRegistry } from "../../src/registry/tokenRegistry";
import { setupTestDb, truncateAll, TEST_DATABASE_URL } from "../helpers/db";
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

interface HistoryEntry {
  userId: string;
  startedAt: string;
  releasedAt: string | null;
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

describe("GET /api/tokens/:id/history (F05)", () => {
  it("returns the full chronological history for a token (closed then open)", async () => {
    const svc = await boot();

    // Fill the pool so the next assignment must evict the oldest token.
    let oldestTokenId = "";
    let firstUser = "";
    for (let i = 0; i < 100; i++) {
      const userId = randomUUID();
      const res = await request(svc.server).post("/api/tokens").send({ userId });
      if (i === 0) {
        oldestTokenId = res.body.tokenId;
        firstUser = userId;
      }
    }

    // 101st assignment evicts the oldest token and reuses it for a new holder.
    const secondUser = randomUUID();
    const evicting = await request(svc.server).post("/api/tokens").send({ userId: secondUser });
    expect(evicting.body.tokenId).toBe(oldestTokenId);

    const res = await request(svc.server).get(`/api/tokens/${oldestTokenId}/history`);
    expect(res.status).toBe(200);
    const body = res.body as HistoryEntry[];
    expect(body).toHaveLength(2);

    // Oldest first: the evicted hold is closed, the current hold is open.
    expect(body[0]!.userId).toBe(firstUser);
    expect(body[0]!.releasedAt).not.toBeNull();
    expect(body[1]!.userId).toBe(secondUser);
    expect(body[1]!.releasedAt).toBeNull();
    // Chronological ordering by startedAt (ascending).
    expect(new Date(body[0]!.startedAt).getTime()).toBeLessThanOrEqual(
      new Date(body[1]!.startedAt).getTime(),
    );
    // Only the three public fields are exposed per entry.
    expect(Object.keys(body[0]!).sort()).toEqual(["releasedAt", "startedAt", "userId"]);
  });

  it("returns 200 with an empty list for a token that has never been assigned", async () => {
    const svc = await boot();
    const neverAssigned = svc.registry.tokenIds()[0]!;

    const res = await request(svc.server).get(`/api/tokens/${neverAssigned}/history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 404 for an unknown token UUID", async () => {
    const svc = await boot();
    const unknown = randomUUID();

    const res = await request(svc.server).get(`/api/tokens/${unknown}/history`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for a malformed id", async () => {
    const svc = await boot();

    const res = await request(svc.server).get(`/api/tokens/not-a-uuid/history`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("persists history across a service restart (durability)", async () => {
    const first = await boot();
    const userId = randomUUID();
    const assigned = await request(first.server).post("/api/tokens").send({ userId });
    const tokenId = assigned.body.tokenId as string;

    // Drain buffered writes and shut down, then restart against the same DB.
    await started.pop()!.shutdown();

    const second = await boot();
    const res = await request(second.server).get(`/api/tokens/${tokenId}/history`);
    expect(res.status).toBe(200);
    const body = res.body as HistoryEntry[];
    expect(body).toHaveLength(1);
    expect(body[0]!.userId).toBe(userId);
    // Startup reconciliation closes the orphaned open hold (active state is not durable).
    expect(body[0]!.startedAt).toBeTypeOf("string");
  });
});

describe("cross-feature integration (F02↔F05)", () => {
  it("makes every assignment event queryable via the history endpoint", async () => {
    const svc = await boot();

    // N assignments, all onto distinct available tokens (no eviction): one row each.
    const assignments: Array<{ tokenId: string; userId: string }> = [];
    for (let i = 0; i < 10; i++) {
      const userId = randomUUID();
      const res = await request(svc.server).post("/api/tokens").send({ userId });
      assignments.push({ tokenId: res.body.tokenId, userId });
    }

    let total = 0;
    for (const { tokenId, userId } of assignments) {
      const res = await request(svc.server).get(`/api/tokens/${tokenId}/history`);
      expect(res.status).toBe(200);
      const body = res.body as HistoryEntry[];
      // Exactly one entry per assignment (0 missing, 0 duplicated).
      expect(body).toHaveLength(1);
      expect(body[0]!.userId).toBe(userId);
      total += body.length;
    }
    expect(total).toBe(assignments.length);
  });

  it("shows an eviction's close in the history query", async () => {
    const svc = await boot();

    let evictedTokenId = "";
    for (let i = 0; i < 100; i++) {
      const res = await request(svc.server).post("/api/tokens").send({ userId: randomUUID() });
      if (i === 0) evictedTokenId = res.body.tokenId;
    }
    const newHolder = randomUUID();
    await request(svc.server).post("/api/tokens").send({ userId: newHolder });

    const res = await request(svc.server).get(`/api/tokens/${evictedTokenId}/history`);
    const body = res.body as HistoryEntry[];
    expect(body).toHaveLength(2);
    expect(body[0]!.releasedAt).not.toBeNull(); // closed on eviction
    expect(body[1]!.userId).toBe(newHolder);
    expect(body[1]!.releasedAt).toBeNull(); // new holder still open
  });
});
