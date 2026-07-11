import { Router } from "express";
import type { TokenRegistry } from "../registry/tokenRegistry";
import type { HistoryWriter } from "../services/historyWriter";
import { createAssignmentService } from "../services/assignmentService";
import { createTokensRouter } from "./tokens";

export interface ApiRouterDeps {
  readonly registry: TokenRegistry;
  readonly historyWriter: HistoryWriter;
}

/**
 * Base router mounted at `API_BASE_PATH`. The extension point where feature
 * routers attach (F02 assignment now; F04 listing, F05 history, F06 detail,
 * F07 clear later). Dependencies are injected so routers avoid importing the
 * process-wide singletons directly.
 */
export function createApiRouter(deps: ApiRouterDeps): Router {
  const { registry, historyWriter } = deps;
  const router = Router();

  const assignmentService = createAssignmentService({ registry, historyWriter });
  router.use("/tokens", createTokensRouter(assignmentService));

  return router;
}
