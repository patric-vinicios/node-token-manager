import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import type { AssignmentService } from "../services/assignmentService";
import type { ListingService } from "../services/listingService";

/**
 * Token resource router, mounted at `<API_BASE_PATH>/tokens`. F02 adds
 * `POST /` (assign a token); F04 adds `GET /` (list the pool). The remaining
 * read/clear endpoints (F06–F07) attach here later.
 */

const assignBodySchema = z.object({
  userId: z
    .string({ required_error: "userId is required" })
    .uuid("userId must be a valid UUID"),
});

export interface TokensRouterDeps {
  readonly assignmentService: AssignmentService;
  readonly listingService: ListingService;
}

export function createTokensRouter(deps: TokensRouterDeps): Router {
  const { assignmentService, listingService } = deps;
  const router = Router();

  // GET /api/tokens — full pool snapshot (F04). No parameters in Core Scope, so
  // every well-formed request succeeds; unexpected read errors go to the central
  // error handler.
  router.get("/", (_req, res, next) => {
    try {
      res.status(200).json(listingService.list());
    } catch (err) {
      next(err);
    }
  });

  // POST /api/tokens — register utilization: validate userId, assign (or evict
  // + reuse the oldest), and return the hold. Never fails for lack of capacity.
  router.post("/", (req, res, next) => {
    const parsed = assignBodySchema.safeParse(req.body);
    if (!parsed.success) {
      next(new ValidationError(parsed.error.issues[0]?.message ?? "Invalid request body"));
      return;
    }

    assignmentService
      .assign(parsed.data.userId)
      .then((result) => res.status(200).json(result))
      .catch(next);
  });

  return router;
}
