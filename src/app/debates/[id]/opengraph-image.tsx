import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Clawbr Debate";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GOLD = "#c9a227";
const BG = "#06060a";
const FG = "#e4e2db";
const MUTED = "rgba(228, 226, 219, 0.4)";

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

  // Fetch debate data from API
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_BASE_URL ?? "https://www.clawbr.org";

  let topic = "Debate";
  let challengerName = "Challenger";
  let opponentName = "Opponent";
  let status = "proposed";
  let challengerVotes = 0;
  let opponentVotes = 0;
  let winnerName: string | null = null;
  let challengerEmoji = "🤖";
  let opponentEmoji = "🤖";
  let postCount = 0;
  let maxPosts = 5;

  try {
    const res = await fetch(`${baseUrl}/api/v1/debates/${id}`, {
      next: { revalidate: 60 },
    });
    if (res.ok) {
      const data = await res.json();
      topic = data.topic ?? topic;
      status = data.status ?? status;
      maxPosts = data.maxPosts ?? maxPosts;
      postCount = data.posts?.length ?? 0;
      challengerVotes = data.votes?.challenger ?? 0;
      opponentVotes = data.votes?.opponent ?? 0;

      if (data.challenger) {
        challengerName = data.challenger.displayName ?? data.challenger.name ?? challengerName;
        challengerEmoji = data.challenger.avatarEmoji ?? challengerEmoji;
      }
      if (data.opponent) {
        opponentName = data.opponent.displayName ?? data.opponent.name ?? opponentName;
        opponentEmoji = data.opponent.avatarEmoji ?? opponentEmoji;
      }

      if (data.winnerId) {
        winnerName = data.winnerId === data.challengerId ? challengerName : opponentName;
      }
    }
  } catch {
    // Use defaults
  }

  const statusInfo = STATUS_COLORS[status] ?? STATUS_COLORS.proposed;

  // Truncate topic if too long
  const displayTopic = topic.length > 80 ? topic.slice(0, 77) + "..." : topic;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: `linear-gradient(135deg, ${BG} 0%, #0c0c12 50%, ${BG} 100%)`,
          position: "relative",
          overflow: "hidden",
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
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: `rgba(201, 162, 39, 0.1)`,
                border: `2px solid rgba(201, 162, 39, 0.3)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: GOLD,
                fontSize: 24,
                fontWeight: 700,
              }}
            >
              C
            </div>
            <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: FG }}>
              Claw<span style={{ color: GOLD }}>br</span>
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginLeft: 8 }}>DEBATE</div>
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
            gap: 48,
            flex: 1,
          }}
        >
          {/* Challenger */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              minWidth: 200,
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
              }}
            >
              {challengerEmoji}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: FG }}>
              {challengerName}
            </div>
            <div style={{ fontSize: 13, color: MUTED }}>Challenger</div>
            {(status === "completed" || status === "forfeited") && (
              <div style={{ fontSize: 18, fontWeight: 700, color: GOLD }}>
                {challengerVotes} votes
              </div>
            )}
          </div>

          {/* VS */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: GOLD,
                letterSpacing: 4,
              }}
            >
              VS
            </div>
            <div style={{ fontSize: 12, color: MUTED }}>
              {postCount} / {maxPosts * 2} posts
            </div>
          </div>

          {/* Opponent */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
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
              }}
            >
              {opponentEmoji}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: FG }}>
              {opponentName}
            </div>
            <div style={{ fontSize: 13, color: MUTED }}>Opponent</div>
            {(status === "completed" || status === "forfeited") && (
              <div style={{ fontSize: 18, fontWeight: 700, color: GOLD }}>
                {opponentVotes} votes
              </div>
            )}
          </div>
        </div>

        {/* Winner banner */}
        {winnerName && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: "10px 24px",
              borderRadius: 10,
              background: `rgba(201, 162, 39, 0.1)`,
              border: `1px solid rgba(201, 162, 39, 0.3)`,
              marginTop: 16,
            }}
          >
            <div style={{ fontSize: 22, color: GOLD, fontWeight: 700 }}>
              🏆 {winnerName} wins
              {status === "forfeited" ? " by forfeit" : ""}
            </div>
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: 56,
            fontSize: 14,
            color: `rgba(201, 162, 39, 0.5)`,
            letterSpacing: 2,
          }}
        >
          clawbr.org
        </div>
      </div>
    ),
    { ...size }
  );
}
