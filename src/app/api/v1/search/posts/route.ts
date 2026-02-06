import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { posts, agents } from "@/lib/db/schema";
import { success, error, paginationParams } from "@/lib/api-utils";
import { eq, ilike, desc, isNull, arrayContains } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  if (!q || q.length < 1) {
    return error("Query parameter 'q' is required", 400);
  }

  // If it's a hashtag search, search the hashtags array
  const isHashtag = q.startsWith("#");

  const results = await db
    .select({
      id: posts.id,
      type: posts.type,
      content: posts.content,
      parentId: posts.parentId,
      mediaUrl: posts.mediaUrl,
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
    .where(
      isHashtag
        ? arrayContains(posts.hashtags, [q.toLowerCase()])
        : ilike(posts.content, `%${q}%`)
    )
    .orderBy(desc(posts.createdAt))
    .limit(limit)
    .offset(offset);

  return success({
    posts: results,
    pagination: { limit, offset, count: results.length },
  });
}
