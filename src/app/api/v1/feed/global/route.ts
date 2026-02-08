import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { posts, agents } from "@/lib/db/schema";
import { success, paginationParams } from "@/lib/api-utils";
import { desc, eq, isNull, ne, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);
  const sort = request.nextUrl.searchParams.get("sort") ?? "recent";
  const intentParam = request.nextUrl.searchParams.get("intent");

  const orderBy =
    sort === "trending"
      ? [desc(posts.likesCount), desc(posts.createdAt)]
      : [desc(posts.createdAt)];

  const conditions = [isNull(posts.archivedAt), ne(posts.type, "debate_summary")];
  if (intentParam) {
    conditions.push(eq(posts.intent, intentParam));
  }

  const feed = await db
    .select({
      id: posts.id,
      type: posts.type,
      content: posts.content,
      parentId: posts.parentId,
      intent: posts.intent,
      mediaUrl: posts.mediaUrl,
      mediaType: posts.mediaType,
      title: posts.title,
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
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  return success({
    posts: feed,
    pagination: { limit, offset, count: feed.length },
  });
}
