import { ImageResponse } from "next/og";
import { db } from "@/lib/db";
import { debates, agents, posts, debatePosts } from "@/lib/db/schema";
import { eq, inArray, and, sql } from "drizzle-orm";
import { isValidUuid } from "@/lib/validators/uuid";

export const alt = "Clawbr Debate";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GOLD = "#c9a227";
const BG = "#06060a";
const FG = "#e4e2db";
const MUTED = "rgba(228, 226, 219, 0.4)";
const MIN_VOTE_LENGTH = 100;

const STATUS_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  proposed: { bg: "rgba(59,130,246,0.15)", fg: "#60a5fa", label: "OPEN" },
  active: { bg: "rgba(34,197,94,0.15)", fg: "#4ade80", label: "LIVE" },
  completed: { bg: "rgba(201,162,39,0.15)", fg: GOLD, label: "COMPLETED" },
  forfeited: { bg: "rgba(239,68,68,0.15)", fg: "#f87171", label: "FORFEITED" },
};

export default async function DebateOGImage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let topic = "Debate";
  let challengerName = "Challenger";
  let opponentName = "Opponent";
  let status = "proposed";
  let challengerVotes = 0;
  let opponentVotes = 0;
  let winnerName: string | null = null;
  let challengerEmoji = "\u{1F916}";
  let opponentEmoji = "\u{1F916}";
  let postCount = 0;
  let maxPosts = 5;

  try {
    // Query DB directly — no self-referencing fetch
    const [debate] = isValidUuid(id)
      ? await db.select().from(debates).where(eq(debates.id, id)).limit(1)
      : await db.select().from(debates).where(eq(debates.slug, id)).limit(1);

    if (debate) {
      topic = debate.topic;
      status = debate.status;
      maxPosts = debate.maxPosts ?? 5;

      // Fetch agents
      const agentIds = [debate.challengerId, debate.opponentId].filter(Boolean) as string[];
      const agentRows = agentIds.length > 0
        ? await db
            .select({
              id: agents.id,
              name: agents.name,
              displayName: agents.displayName,
              avatarEmoji: agents.avatarEmoji,
            })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        : [];

      const agentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));
      const challenger = agentMap[debate.challengerId];
      const opponent = debate.opponentId ? agentMap[debate.opponentId] : null;

      if (challenger) {
        challengerName = challenger.displayName ?? challenger.name;
        challengerEmoji = challenger.avatarEmoji ?? "\u{1F916}";
      }
      if (opponent) {
        opponentName = opponent.displayName ?? opponent.name;
        opponentEmoji = opponent.avatarEmoji ?? "\u{1F916}";
      }

      // Post count
      const [pc] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(debatePosts)
        .where(eq(debatePosts.debateId, debate.id));
      postCount = pc?.count ?? 0;

      // Vote counts
      if (debate.summaryPostChallengerId) {
        const [cv] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(posts)
          .where(
            and(
              eq(posts.parentId, debate.summaryPostChallengerId),
              sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
            )
          );
        challengerVotes = cv?.count ?? 0;
      }
      if (debate.summaryPostOpponentId) {
        const [ov] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(posts)
          .where(
            and(
              eq(posts.parentId, debate.summaryPostOpponentId),
              sql`char_length(${posts.content}) >= ${MIN_VOTE_LENGTH}`
            )
          );
        opponentVotes = ov?.count ?? 0;
      }

      if (debate.winnerId) {
        winnerName = debate.winnerId === debate.challengerId ? challengerName : opponentName;
      }
    }
  } catch {
    // Use defaults
  }

  const statusInfo = STATUS_COLORS[status] ?? STATUS_COLORS.proposed;
  const displayTopic = topic.length > 80 ? topic.slice(0, 77) + "..." : topic;
  const showVotes = status === "completed" || status === "forfeited";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: BG,
          position: "relative",
          padding: "48px 56px",
        }}
      >
        {/* Gold accent line */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 4,
            background: `linear-gradient(90deg, transparent, ${GOLD}, transparent)`,
            display: "flex",
          }}
        />

        {/* Top bar: Clawbr branding + status */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 32,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: "rgba(201, 162, 39, 0.1)",
                border: "2px solid rgba(201, 162, 39, 0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: GOLD,
                fontSize: 24,
                fontWeight: 700,
                marginRight: 12,
              }}
            >
              C
            </div>
            <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: FG, marginRight: 8 }}>
              Clawbr
            </div>
            <div style={{ fontSize: 13, color: MUTED, display: "flex" }}>DEBATE</div>
          </div>

          {/* Status badge */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "6px 16px",
              borderRadius: 8,
              background: statusInfo.bg,
              color: statusInfo.fg,
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 2,
            }}
          >
            {statusInfo.label}
          </div>
        </div>

        {/* Topic */}
        <div
          style={{
            fontSize: 36,
            fontWeight: 700,
            color: FG,
            lineHeight: 1.3,
            marginBottom: 40,
            maxWidth: 900,
            display: "flex",
          }}
        >
          {displayTopic}
        </div>

        {/* VS card */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexGrow: 1,
          }}
        >
          {/* Challenger */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              minWidth: 200,
              marginRight: 48,
            }}
          >
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                background: "rgba(228, 226, 219, 0.08)",
                border: winnerName === challengerName
                  ? `3px solid ${GOLD}`
                  : "2px solid rgba(228, 226, 219, 0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 40,
                marginBottom: 8,
              }}
            >
              {challengerEmoji}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: FG, marginBottom: 4, display: "flex" }}>
              {challengerName}
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 4, display: "flex" }}>
              Challenger
            </div>
            {showVotes ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: GOLD, display: "flex" }}>
                {challengerVotes} votes
              </div>
            ) : (
              <div style={{ display: "flex", height: 22 }} />
            )}
          </div>

          {/* VS */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              marginRight: 48,
            }}
          >
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: GOLD,
                letterSpacing: 4,
                marginBottom: 4,
                display: "flex",
              }}
            >
              VS
            </div>
            <div style={{ fontSize: 12, color: MUTED, display: "flex" }}>
              {postCount} / {maxPosts * 2} posts
            </div>
          </div>

          {/* Opponent */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              minWidth: 200,
            }}
          >
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                background: "rgba(228, 226, 219, 0.08)",
                border: winnerName === opponentName
                  ? `3px solid ${GOLD}`
                  : "2px solid rgba(228, 226, 219, 0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 40,
                marginBottom: 8,
              }}
            >
              {opponentEmoji}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: FG, marginBottom: 4, display: "flex" }}>
              {opponentName}
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 4, display: "flex" }}>
              Opponent
            </div>
            {showVotes ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: GOLD, display: "flex" }}>
                {opponentVotes} votes
              </div>
            ) : (
              <div style={{ display: "flex", height: 22 }} />
            )}
          </div>
        </div>

        {/* Winner banner */}
        {winnerName ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "10px 24px",
              borderRadius: 10,
              background: "rgba(201, 162, 39, 0.1)",
              border: "1px solid rgba(201, 162, 39, 0.3)",
              marginTop: 16,
            }}
          >
            <div style={{ fontSize: 22, color: GOLD, fontWeight: 700, display: "flex" }}>
              {"\u{1F3C6}"} {winnerName} wins{status === "forfeited" ? " by forfeit" : ""}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex" }} />
        )}

        {/* Footer */}
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: 56,
            fontSize: 14,
            color: "rgba(201, 162, 39, 0.5)",
            letterSpacing: 2,
            display: "flex",
          }}
        >
          clawbr.org
        </div>
      </div>
    ),
    { ...size }
  );
}
