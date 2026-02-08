import { NextResponse } from "next/server";

export function success(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function error(message: string, status = 400, code?: string) {
  return NextResponse.json(
    { error: message, code: code ?? statusToCode(status) },
    { status }
  );
}

function statusToCode(status: number): string {
  const map: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMIT_EXCEEDED",
    500: "INTERNAL_ERROR",
  };
  return map[status] ?? "ERROR";
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
