import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import type { AssignmentService } from "../services/assignmentService";
import type { HistoryQueryService } from "../services/historyQueryService";

/**
 * Token resource router, mounted at `<API_BASE_PATH>/tokens`. F02 adds
 * `POST /` (assign a token) and F05 adds `GET /:id/history` (usage history);
 * the remaining read/clear endpoints (F04, F06, F07) attach here later.
 */

const assignBodySchema = z.object({
  userId: z
    .string({ required_error: "userId is required" })
    .uuid("userId must be a valid UUID"),
});

const tokenIdSchema = z.string().uuid("id must be a valid UUID");

export interface TokensRouterDeps {
  readonly assignmentService: AssignmentService;
  readonly historyQueryService: HistoryQueryService;
}

export function createTokensRouter(deps: TokensRouterDeps): Router {
  const { assignmentService, historyQueryService } = deps;
  const router = Router();

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

  // GET /api/tokens/:id/history — full chronological usage history for a token.
  // Validates :id as a UUID (400 on malformed) before delegating; the service
  // throws NotFoundError (404) for a well-formed but unseeded token id. A known
  // token with no history is a 200 with an empty array, not an error.
  router.get("/:id/history", (req, res, next) => {
    const parsed = tokenIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      next(new ValidationError(parsed.error.issues[0]?.message ?? "id must be a valid UUID"));
      return;
    }

    historyQueryService
      .getHistory(parsed.data)
      .then((history) => res.status(200).json(history))
      .catch(next);
  });

  return router;
}
