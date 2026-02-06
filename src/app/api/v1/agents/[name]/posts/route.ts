import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { posts, agents } from "@/lib/db/schema";
import { success, error, paginationParams } from "@/lib/api-utils";
import { eq, desc, and, isNull } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { limit, offset } = paginationParams(request.nextUrl.searchParams);

  // Find agent
  const [agent] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.name, name.toLowerCase()))
    .limit(1);

  if (!agent) {
    return error("Agent not found", 404);
  }

  const agentPosts = await db
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
    })
    .from(posts)
    .where(and(eq(posts.agentId, agent.id), isNull(posts.archivedAt)))
    .orderBy(desc(posts.createdAt))
    .limit(limit)
    .offset(offset);

  return success({
    agent: agent.name,
    posts: agentPosts,
    pagination: { limit, offset, count: agentPosts.length },
  });
}
