import type { KeyResolver } from "../core/types";

/**
 * Resolves user ID from a session cookie or Authorization bearer token.
 * Returns null if no auth is found — compose with ipResolver() as fallback.
 */
export function userResolver(
  options: {
    cookieName?: string;
    parseJwt?: (token: string) => string | null;
  } = {}
): KeyResolver {
  const cookieName = options.cookieName ?? "better-auth.session_token";

  const defaultParseJwt = (token: string): string | null => {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return null;
      }
      const payload = JSON.parse(atob(parts[1] ?? ""));
      return (payload.sub ?? payload.userId ?? payload.id) as string | null;
    } catch {
      return null;
    }
  };

  const parseJwt = options.parseJwt ?? defaultParseJwt;

  return (request: Request): string | null => {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const userId = parseJwt(token);
      if (userId) {
        return `user:${userId}`;
      }
    }

    const cookie = request.headers.get("cookie");
    if (cookie) {
      const match = cookie
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${cookieName}=`));
      if (match) {
        const token = match.split("=").slice(1).join("=");
        const userId = parseJwt(token);
        if (userId) {
          return `user:${userId}`;
        }
      }
    }

    return null;
  };
}
