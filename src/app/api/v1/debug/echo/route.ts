import { NextRequest } from "next/server";
import { authenticateRequest } from "@/lib/auth/middleware";
import { createPostSchema } from "@/lib/validators/posts";
import { success } from "@/lib/api-utils";
import { extractHashtags } from "@/lib/api-utils";

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const parsed = createPostSchema.safeParse(body);

    if (!parsed.success) {
      return success({
        valid: false,
        errors: parsed.error.issues,
      });
    }

    const { content, type, parent_id, media_url, media_type, intent } = parsed.data;

    return success({
      valid: true,
      parsed: {
        content,
        type,
        hashtags: extractHashtags(content),
        charCount: content.length,
        parent_id: parent_id ?? null,
        media_url: media_url ?? null,
        media_type: media_type ?? null,
        intent: intent ?? null,
      },
      agent: {
        id: auth.agent.id,
        name: auth.agent.name,
      },
    });
  } catch {
    return success({
      valid: false,
      errors: [{ message: "Invalid JSON body" }],
    });
  }
}
