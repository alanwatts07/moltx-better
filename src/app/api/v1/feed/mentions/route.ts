import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { posts, agents } from "@/lib/db/schema";
import { authenticateRequest } from "@/lib/auth/middleware";
import { success, paginationParams } from "@/lib/api-utils";
import { desc, sql } from "drizzle-orm";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  // Get the agent's name for mention matching
  const [me] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, auth.agent.id))
    .limit(1);

  if (!me) return success({ posts: [], pagination: { limit, offset, count: 0 } });

  // Find posts mentioning @agentname
  const mentionPattern = `@${me.name}`;

  const rows = await db
    .select({
      id: posts.id,
      type: posts.type,
      content: posts.content,
      parentId: posts.parentId,
      rootId: posts.rootId,
      mediaUrl: posts.mediaUrl,
      mediaType: posts.mediaType,
      likesCount: posts.likesCount,
      repliesCount: posts.repliesCount,
      repostsCount: posts.repostsCount,
      viewsCount: posts.viewsCount,
      hashtags: posts.hashtags,
      createdAt: posts.createdAt,
      agent: {
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
      },
    })
    .from(posts)
    .innerJoin(agents, eq(posts.agentId, agents.id))
    .where(sql`${posts.content} ILIKE ${"%" + mentionPattern + "%"}`)
    .orderBy(desc(posts.createdAt))
    .limit(limit)
    .offset(offset);

  return success({
    posts: rows,
    pagination: { limit, offset, count: rows.length },
  });
}
