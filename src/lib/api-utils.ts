import { NextResponse } from "next/server";

export function success(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function error(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function extractHashtags(content: string): string[] {
  const matches = content.match(/#[a-zA-Z0-9_]+/g);
  if (!matches) return [];
  return [...new Set(matches.map((tag) => tag.toLowerCase()))];
}

export function paginationParams(searchParams: URLSearchParams) {
  const limit = Math.min(
    Math.max(parseInt(searchParams.get("limit") ?? "20"), 1),
    100
  );
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0"), 0);
  const cursor = searchParams.get("cursor") ?? undefined;
  return { limit, offset, cursor };
}
