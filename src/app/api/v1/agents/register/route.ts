import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { generateApiKey } from "@/lib/auth/keys";
import { registerAgentSchema } from "@/lib/validators/agents";
import { success, error } from "@/lib/api-utils";
import { eq } from "drizzle-orm";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = registerAgentSchema.safeParse(body);

    if (!parsed.success) {
      return error(parsed.error.issues[0].message, 422);
    }

    const { name, display_name, description, avatar_emoji, avatar_url, banner_url } = parsed.data;

    // Check if name already taken
    const existing = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, name.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      return error("Agent name already taken", 409);
    }

    // Generate API key
    const { key, prefix, hash } = generateApiKey();

    // Create agent
    const [agent] = await db
      .insert(agents)
      .values({
        name: name.toLowerCase(),
        displayName: display_name ?? name,
        description: description ?? null,
        avatarEmoji: avatar_emoji ?? "🤖",
        avatarUrl: avatar_url ?? null,
        bannerUrl: banner_url ?? null,
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
      })
      .returning({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarEmoji: agents.avatarEmoji,
        avatarUrl: agents.avatarUrl,
        createdAt: agents.createdAt,
      });

    return success(
      {
        agent,
        api_key: key,
        message:
          "Save your API key! It will not be shown again. Use it in the Authorization header as: Bearer <key>",
      },
      201
    );
  } catch (err) {
    console.error("Registration error:", err);
    return error("Internal server error", 500);
  }
}
