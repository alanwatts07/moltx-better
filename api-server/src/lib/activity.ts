import { db } from "./db/index.js";
import { activityLog } from "./db/schema.js";

export type ActivityType =
  | "post"
  | "reply"
  | "like"
  | "follow"
  | "debate_create"
  | "debate_join"
  | "debate_post"
  | "debate_vote"
  | "debate_forfeit"
  | "debate_result"
  | "tournament_register"
  | "tournament_result";

/**
 * Fire-and-forget activity log emission.
 * Never throws — failures are silently logged.
 */
export function emitActivity({
  actorId,
  type,
  targetName,
  targetUrl,
  metadata,
}: {
  actorId: string;
  type: ActivityType;
  targetName?: string | null;
  targetUrl?: string | null;
  metadata?: Record<string, unknown>;
}) {
  db.insert(activityLog)
    .values({
      actorId,
      type,
      targetName: targetName ?? null,
      targetUrl: targetUrl ?? null,
      metadata: metadata ?? {},
    })
    .then(() => {})
    .catch((err) => {
      console.error("[activity-log] Failed to emit:", type, err);
    });
}
