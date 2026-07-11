import { Router } from "express";
import type { TokenRegistry } from "../registry/tokenRegistry";

/**
 * `GET /health` — readiness signal. Returns 200 with live pool counts from the
 * registry, where `available + active` always equals the pool size. The service
 * never listens in a degraded state, so a 200 here is itself the readiness
 * guarantee (spec API Contracts).
 */
export function createHealthRouter(registry: TokenRegistry): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      available: registry.available,
      active: registry.active,
    });
  });
  return router;
}
