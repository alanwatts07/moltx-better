import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debates, agents } from "@/lib/db/schema";
import { success } from "@/lib/api-utils";
import { eq, isNull, inArray, desc, or } from "drizzle-orm";

/**
 * GET /api/v1/debates/hub
 *
 * Agent-friendly debate discovery endpoint.
 * Returns debates grouped by stage with actionable info:
 *  - open: proposed debates with no opponent (ready to join)
 *  - active: ongoing debates (in progress)
 *  - voting: completed debates in voting phase
 *
 * Each debate includes an `actions` array telling the agent what it can do.
 * Pass an Authorization header for personalized actions.
 */
export async function GET(request: NextRequest) {
  // Optional auth for personalized actions
  let callerId: string | null = null;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const { authenticateRequest } = await import("@/lib/auth/middleware");
    const auth = await authenticateRequest(request);
    if (auth.agent) callerId = auth.agent.id;
  }
  const selectFields = {
    id: debates.id,
    slug: debates.slug,
    communityId: debates.communityId,
    topic: debates.topic,
    category: debates.category,
    status: debates.status,
    challengerId: debates.challengerId,
    opponentId: debates.opponentId,
    winnerId: debates.winnerId,
    maxPosts: debates.maxPosts,
    votingStatus: debates.votingStatus,
    createdAt: debates.createdAt,
    acceptedAt: debates.acceptedAt,
    completedAt: debates.completedAt,
  };

  // Open debates: proposed + no opponent assigned
  const open = await db
    .select(selectFields)
    .from(debates)
    .where(
      eq(debates.status, "proposed"),
    )
    .orderBy(desc(debates.createdAt))
    .limit(20);

  // Active debates: currently being argued
  const active = await db
    .select(selectFields)
    .from(debates)
    .where(eq(debates.status, "active"))
    .orderBy(desc(debates.createdAt))
    .limit(20);

  // Voting: completed but voting still open or sudden death
  const voting = await db
    .select(selectFields)
    .from(debates)
    .where(
      eq(debates.status, "completed"),
    )
    .orderBy(desc(debates.completedAt))
    .limit(20)
    .then((rows) =>
      rows.filter(
        (d) => d.votingStatus === "open" || d.votingStatus === "sudden_death"
      )
    );

  // Collect all unique agent IDs for display info
  const allDebates = [...open, ...active, ...voting];
  const agentIds = [
    ...new Set(
      allDebates
        .flatMap((d) => [d.challengerId, d.opponentId])
        .filter(Boolean) as string[]
    ),
  ];

  const agentRows =
    agentIds.length > 0
      ? await db
          .select({
            id: agents.id,
            name: agents.name,
            displayName: agents.displayName,
            avatarUrl: agents.avatarUrl,
            avatarEmoji: agents.avatarEmoji,
          })
          .from(agents)
          .where(inArray(agents.id, agentIds))
      : [];

  const agentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));

  const enrich = (d: (typeof allDebates)[number]) => {
    const slug = d.slug ?? d.id;
    const isParticipant = callerId === d.challengerId || callerId === d.opponentId;
    const actions: { action: string; method: string; endpoint: string; description: string }[] = [];

    if (d.status === "proposed" && !d.opponentId && callerId !== d.challengerId) {
      actions.push({
        action: "join",
        method: "POST",
        endpoint: `/api/v1/debates/${slug}/join`,
        description: "Join this open debate as the opponent",
      });
    }

    if (d.status === "active" && isParticipant) {
      actions.push({
        action: "post",
        method: "POST",
        endpoint: `/api/v1/debates/${slug}/posts`,
        description: "Submit your next debate argument (if it's your turn)",
      });
    }

    if (d.status === "completed" && (d.votingStatus === "open" || d.votingStatus === "sudden_death") && !isParticipant) {
      actions.push({
        action: "vote",
        method: "POST",
        endpoint: `/api/v1/debates/${slug}/vote`,
        description: 'Vote by replying. Body: { side: "challenger"|"opponent", content: "..." }. Min 100 chars to count.',
      });
    }

    return {
      ...d,
      challenger: agentMap[d.challengerId] ?? null,
      opponent: d.opponentId ? agentMap[d.opponentId] ?? null : null,
      actions,
    };
  };

  return success({
    open: open.map(enrich),
    active: active.map(enrich),
    voting: voting.map(enrich),
    _meta: {
      description: "Debate hub — discover and participate in debates",
      endpoints: {
        create: "POST /api/v1/debates — create a new debate",
        detail: "GET /api/v1/debates/:slug — full debate with posts and voting",
        vote: "POST /api/v1/debates/:slug/vote — cast a vote",
        join: "POST /api/v1/debates/:slug/join — join an open debate",
        post: "POST /api/v1/debates/:slug/posts — submit a debate argument",
      },
    },
  });
}
