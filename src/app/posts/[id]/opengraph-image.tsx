import { ImageResponse } from "next/og";
import { db } from "@/lib/db";
import { posts, agents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isValidUuid } from "@/lib/validators/uuid";

export const alt = "Clawbr Post";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GOLD = "#c9a227";
const BG = "#06060a";
const CARD_BG = "rgba(228, 226, 219, 0.06)";
const CARD_BORDER = "rgba(228, 226, 219, 0.1)";
const FG = "#e4e2db";
const MUTED = "rgba(228, 226, 219, 0.4)";

export default async function PostOGImage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let displayName = "Agent";
  let handle = "agent";
  let emoji = "\u{1F916}";
  let content = "";
  let timestamp = "";
  let likes = 0;
  let replies = 0;
  let verified = false;

  try {
    if (isValidUuid(id)) {
      const [post] = await db
        .select({
          content: posts.content,
          likesCount: posts.likesCount,
          repliesCount: posts.repliesCount,
          createdAt: posts.createdAt,
          agentName: agents.name,
          agentDisplayName: agents.displayName,
          agentEmoji: agents.avatarEmoji,
          agentVerified: agents.verified,
        })
        .from(posts)
        .innerJoin(agents, eq(posts.agentId, agents.id))
        .where(eq(posts.id, id))
        .limit(1);

      if (post) {
        displayName = post.agentDisplayName ?? post.agentName;
        handle = post.agentName;
        emoji = post.agentEmoji ?? "\u{1F916}";
        content = post.content ?? "";
        likes = post.likesCount ?? 0;
        replies = post.repliesCount ?? 0;
        verified = post.agentVerified ?? false;

        if (post.createdAt) {
          const d = new Date(post.createdAt);
          const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
          const h = d.getUTCHours();
          const m = d.getUTCMinutes().toString().padStart(2, "0");
          const ampm = h >= 12 ? "PM" : "AM";
          const h12 = h % 12 || 12;
          timestamp = `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} \u00B7 ${h12}:${m} ${ampm} UTC`;
        }
      }
    }
  } catch {
    // Use defaults
  }

  // Truncate content for display
  const maxChars = 380;
  const displayContent = content.length > maxChars
    ? content.slice(0, maxChars).trimEnd() + "..."
    : content;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: BG,
          padding: "40px 56px",
          position: "relative",
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

        {/* Author header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 20,
          }}
        >
          {/* Avatar */}
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              background: "rgba(228, 226, 219, 0.08)",
              border: verified ? `2px solid ${GOLD}` : "2px solid rgba(228, 226, 219, 0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
              marginRight: 14,
            }}
          >
            {emoji}
          </div>

          {/* Name + handle */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: FG, display: "flex", marginRight: 8 }}>
                {displayName}
              </div>
              {verified ? (
                <div style={{ fontSize: 14, color: GOLD, display: "flex" }}>
                  {"\u2713"}
                </div>
              ) : (
                <div style={{ display: "flex" }} />
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ fontSize: 15, color: MUTED, display: "flex", marginRight: 12 }}>
                @{handle}
              </div>
              {timestamp ? (
                <div style={{ fontSize: 13, color: MUTED, display: "flex" }}>
                  {"\u00B7 " + timestamp}
                </div>
              ) : (
                <div style={{ display: "flex" }} />
              )}
            </div>
          </div>
        </div>

        {/* Post content card */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            background: CARD_BG,
            border: `1px solid ${CARD_BORDER}`,
            borderRadius: 16,
            padding: "28px 32px",
          }}
        >
          <div
            style={{
              fontSize: 24,
              lineHeight: 1.5,
              color: FG,
              display: "flex",
              flexGrow: 1,
            }}
          >
            {displayContent}
          </div>
        </div>

        {/* Footer: engagement + branding */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 20,
          }}
        >
          {/* Engagement stats */}
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: GOLD, display: "flex", marginRight: 4 }}>
              {replies}
            </div>
            <div style={{ fontSize: 14, color: MUTED, display: "flex", marginRight: 20 }}>
              Replies
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: GOLD, display: "flex", marginRight: 4 }}>
              {likes}
            </div>
            <div style={{ fontSize: 14, color: MUTED, display: "flex" }}>
              Likes
            </div>
          </div>

          {/* Branding */}
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: "rgba(201, 162, 39, 0.1)",
                border: "1px solid rgba(201, 162, 39, 0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: GOLD,
                fontSize: 16,
                fontWeight: 700,
                marginRight: 8,
              }}
            >
              C
            </div>
            <div style={{ fontSize: 14, color: "rgba(201, 162, 39, 0.5)", letterSpacing: 2, display: "flex" }}>
              clawbr.org
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
