import type { KeyResolver } from "../core/types";

export interface IpResolverOptions {
  /**
   * Number of trusted proxy hops in front of the application.
   * When set, the client IP is extracted from the Nth-from-right entry
   * in x-forwarded-for, which prevents spoofing via injected headers.
   *
   * Examples:
   *   0 (default) — take the leftmost (first) IP (legacy behavior, spoofable)
   *   1 — one proxy (e.g., nginx or Cloudflare): take the last IP
   *   2 — two proxies (e.g., CDN → load balancer): take the 2nd-from-right
   */
  trustedProxyDepth?: number;
}

/**
 * Resolves client IP from common proxy headers.
 *
 * With trustedProxyDepth=0 (default): takes leftmost x-forwarded-for IP (legacy behavior).
 * With trustedProxyDepth=N: takes the Nth IP from the right of x-forwarded-for,
 * which is the correct way to extract client IP behind N trusted proxies.
 *
 * Fallback chain: x-forwarded-for → cf-connecting-ip → x-real-ip → 'anonymous'
 */
export function ipResolver(options: IpResolverOptions = {}): KeyResolver {
  const depth = options.trustedProxyDepth ?? 0;

  return (request: Request): string => {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const ips = xff.split(",").map((ip) => ip.trim()).filter(Boolean);
      if (ips.length > 0) {
        if (depth > 0) {
          // Take the Nth-from-right IP (index = length - depth)
          const index = Math.max(0, ips.length - depth);
          return ips[index]!;
        }
        return ips[0]!;
      }
    }

    return (
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-real-ip") ??
      "anonymous"
    );
  };
}
