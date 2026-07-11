import { Router } from "express";
import type { Database } from "../db/client";
import type { TokenRegistry } from "../registry/tokenRegistry";
import type { HistoryWriter } from "../services/historyWriter";
import { createAssignmentService } from "../services/assignmentService";
import { createHistoryQueryService } from "../services/historyQueryService";
import { createTokensRouter } from "./tokens";

export interface ApiRouterDeps {
  readonly registry: TokenRegistry;
  readonly historyWriter: HistoryWriter;
  readonly db: Database;
}

/**
 * Base router mounted at `API_BASE_PATH`. The extension point where feature
 * routers attach (F02 assignment and F05 history now; F04 listing, F06 detail,
 * F07 clear later). Dependencies are injected so routers avoid importing the
 * process-wide singletons directly.
 */
export function createApiRouter(deps: ApiRouterDeps): Router {
  const { registry, historyWriter, db } = deps;
  const router = Router();

  const assignmentService = createAssignmentService({ registry, historyWriter });
  const historyQueryService = createHistoryQueryService({ registry, db });
  router.use("/tokens", createTokensRouter({ assignmentService, historyQueryService }));

  return router;
}
