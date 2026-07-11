import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { TokenRegistry } from "../../src/registry/tokenRegistry";
import type { Database } from "../../src/db/client";
import type { HistoryWriter } from "../../src/services/historyWriter";

/** No-op writer: /health and error-envelope tests never touch history. */
const noopHistoryWriter: HistoryWriter = {
  record: async () => undefined,
  flush: async () => undefined,
  stop: async () => undefined,
};

/** Stub db: these suites never exercise the history read route, so it is unused. */
const stubDb = {} as unknown as Database;

function appWithPool(size: number) {
  const registry = new TokenRegistry();
  registry.init(Array.from({ length: size }, () => randomUUID()));
  const app = createApp({
    registry,
    apiBasePath: "/api",
    historyWriter: noopHistoryWriter,
    db: stubDb,
  });
  return { app, registry };
}

describe("GET /health", () => {
  it("returns ok with counts summing to the pool size", async () => {
    const { app } = appWithPool(100);
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.available).toBe(100);
    expect(res.body.active).toBe(0);
    expect(res.body.available + res.body.active).toBe(100);
  });

  it("reflects active tokens in the counts (still summing to 100)", async () => {
    const { app, registry } = appWithPool(100);
    registry.activate(registry.tokenIds()[0]!, {
      userId: randomUUID(),
      activatedAt: new Date(),
      activatedAtMonotonic: 0,
    });

    const res = await request(app).get("/health");
    expect(res.body.available).toBe(99);
    expect(res.body.active).toBe(1);
    expect(res.body.available + res.body.active).toBe(100);
  });

  it("returns the standard NOT_FOUND envelope for unknown routes", async () => {
    const { app } = appWithPool(100);
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: "error",
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  it("returns a VALIDATION_ERROR envelope for malformed JSON", async () => {
    const { app } = appWithPool(100);
    const res = await request(app)
      .post("/api/anything")
      .set("Content-Type", "application/json")
      .send("{ not valid json");
    // Body parser rejects before routing; central handler maps it to 400.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
