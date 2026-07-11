import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import type { AssignmentService } from "../services/assignmentService";

/**
 * Token resource router, mounted at `<API_BASE_PATH>/tokens`. F02 adds
 * `POST /` (assign a token); the sibling read/clear endpoints (F04–F07) attach
 * here later.
 */

const assignBodySchema = z.object({
  userId: z
    .string({ required_error: "userId is required" })
    .uuid("userId must be a valid UUID"),
});

export function createTokensRouter(service: AssignmentService): Router {
  const router = Router();

  // POST /api/tokens — register utilization: validate userId, assign (or evict
  // + reuse the oldest), and return the hold. Never fails for lack of capacity.
  router.post("/", (req, res, next) => {
    const parsed = assignBodySchema.safeParse(req.body);
    if (!parsed.success) {
      next(new ValidationError(parsed.error.issues[0]?.message ?? "Invalid request body"));
      return;
    }

    service
      .assign(parsed.data.userId)
      .then((result) => res.status(200).json(result))
      .catch(next);
  });

  return router;
}
