import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHistoryQueryService } from "../../src/services/historyQueryService";
import { NotFoundError } from "../../src/lib/errors";
import { TokenRegistry } from "../../src/registry/tokenRegistry";
import type { Database } from "../../src/db/client";

/**
 * Minimal stand-in for the Drizzle read chain used by the query service:
 * `select(cols).from(t).where(cond).orderBy(order)` resolving to a row array.
 * The fake records that a query was issued so the "no DB query on 404" path can
 * be asserted, and returns the rows it was constructed with.
 */
function fakeDb(rows: Array<Record<string, unknown>>) {
  const queried = { called: false };
  const db = {
    select() {
      queried.called = true;
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, queried };
}

function registryWith(tokenId: string): TokenRegistry {
  const registry = new TokenRegistry();
  registry.init([tokenId]);
  return registry;
}

describe("historyQueryService", () => {
  it("returns entries ordered chronologically (oldest first)", async () => {
    const tokenId = randomUUID();
    // The service delegates ordering to `ORDER BY started_at ASC`; the fake
    // returns rows already in that order and the service preserves it.
    const older = { userId: randomUUID(), startedAt: new Date("2026-07-08T12:00:00Z"), releasedAt: new Date("2026-07-08T12:02:00Z") };
    const newer = { userId: randomUUID(), startedAt: new Date("2026-07-08T12:02:00Z"), releasedAt: null };
    const { db } = fakeDb([older, newer]);
    const service = createHistoryQueryService({ registry: registryWith(tokenId), db });

    const result = await service.getHistory(tokenId);

    expect(result).toHaveLength(2);
    expect(result[0]!.startedAt.getTime()).toBeLessThan(result[1]!.startedAt.getTime());
    expect(result[0]).toEqual(older);
  });

  it("returns an empty array for a known token with no history", async () => {
    const tokenId = randomUUID();
    const { db } = fakeDb([]);
    const service = createHistoryQueryService({ registry: registryWith(tokenId), db });

    await expect(service.getHistory(tokenId)).resolves.toEqual([]);
  });

  it("maps rows to the { userId, startedAt, releasedAt } shape", async () => {
    const tokenId = randomUUID();
    const closed = { userId: randomUUID(), startedAt: new Date("2026-07-08T12:00:00Z"), releasedAt: new Date("2026-07-08T12:02:00Z") };
    const open = { userId: randomUUID(), startedAt: new Date("2026-07-08T12:02:00Z"), releasedAt: null };
    const { db } = fakeDb([closed, open]);
    const service = createHistoryQueryService({ registry: registryWith(tokenId), db });

    const [first, second] = await service.getHistory(tokenId);

    expect(Object.keys(first!).sort()).toEqual(["releasedAt", "startedAt", "userId"]);
    expect(first!.releasedAt).toBeInstanceOf(Date);
    expect(second!.releasedAt).toBeNull();
    // Internal columns never leak into the response shape.
    const shape = first as unknown as Record<string, unknown>;
    expect(shape).not.toHaveProperty("id");
    expect(shape).not.toHaveProperty("tokenId");
    expect(shape).not.toHaveProperty("releaseReason");
  });

  it("throws NotFoundError for an unknown token id and issues no DB query", async () => {
    const seeded = randomUUID();
    const unknown = randomUUID();
    const { db, queried } = fakeDb([]);
    const selectSpy = vi.spyOn(db, "select");
    const service = createHistoryQueryService({ registry: registryWith(seeded), db });

    await expect(service.getHistory(unknown)).rejects.toBeInstanceOf(NotFoundError);
    expect(queried.called).toBe(false);
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
