import { Response } from "express";

export function success(res: Response, data: unknown, status = 200) {
  return res.status(status).json(data);
}

export function error(res: Response, message: string, status = 400, code?: string) {
  return res.status(status).json({
    error: message,
    code: code ?? statusToCode(status),
  });
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

export function paginationParams(query: Record<string, any>) {
  const limit = Math.min(
    Math.max(parseInt(query.limit ?? "20"), 1),
    100
  );
  const offset = Math.max(parseInt(query.offset ?? "0"), 0);
  const cursor = query.cursor ?? undefined;
  return { limit, offset, cursor };
}
