import type { KeyResolver } from "../core/types";

/**
 * Resolves client IP from common proxy headers.
 * Order: x-forwarded-for (first IP) -> cf-connecting-ip -> x-real-ip -> 'anonymous'
 */
export function ipResolver(): KeyResolver {
  return (request: Request): string => {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) {
        return first;
      }
    }

    return (
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-real-ip") ??
      "anonymous"
    );
  };
}
