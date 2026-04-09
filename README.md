# elysia-advanced-rate-limiter

A fast, opinionated rate limiter for [Elysia](https://elysiajs.com). Ships with in-memory storage. Plug in Redis or any compatible external store when you need shared state across instances.

No locks. No Lua overhead for counters. GCRA for token bucket. The same algorithms Stripe and Cloudflare run in production.

## Install

```bash
bun add elysia-advanced-rate-limiter
```

## Quick Start

```typescript
import { Elysia } from "elysia";
import { rateLimiter } from "elysia-advanced-rate-limiter";

const app = new Elysia()
  .use(rateLimiter())
  .get("/", () => "hello")
  .listen(3000);
```

Works out of the box. In-memory, token bucket, 100 capacity, 10 tokens/sec.

When you outgrow a single process, plug in Redis:

```typescript
import Redis from "ioredis";
import { RedisStore } from "elysia-advanced-rate-limiter";

rateLimiter({
  store: new RedisStore(new Redis()),
});
```

Same API. Same behavior. Shared state across all your instances.

## Algorithms

Three algorithms. All O(1) time and space per request.

### Fixed Window

Simplest option. Divides time into equal blocks, counts requests per block. Counter resets at each boundary.

```typescript
rateLimiter({
  algorithm: { algorithm: "fixed-window", limit: 100, windowMs: 60_000 },
});
```

```
limit = 5 requests per window

Window 1 (00:00-01:00)          Window 2 (01:00-02:00)
┌──────────────────────┐        ┌──────────────────────┐
│ ## ## ## ## ## .. .. │        │ ## ## ## .. .. .. .. │
│  1  2  3  4  5  x  x │        │  1  2  3             │
└──────────────────────┘        └──────────────────────┘
count=5 -> DENY after 5          count resets to 0

## = allowed    .. = denied    x = rejected
```

**The boundary burst problem** -- clients can send `limit` requests at the end of one window and `limit` at the start of the next, getting 2x the limit in a short span:

```
limit = 5

Window 1                        Window 2
┌──────────────────────┐        ┌──────────────────────┐
│              ## ## ## │## ## ##│## ##                 │
│               3  4  5 │ 1  2  3│ 4  5                 │
└──────────────────────┘        └──────────────────────┘
             <--- 1 second --->
             6 requests in 1s!    (but each window sees <= 5)
```

If boundary bursts matter, use sliding window instead.

Storage: `{ count: 5, windowStart: 1712678400000 }` -- **39 bytes per key**

| | |
|---|---|
| Time | O(1) |
| Space | O(1) per key |
| Redis | 1 `INCR` (atomic, non-blocking) |

### Sliding Window

Blends current and previous window counts to eliminate the boundary burst. Uses the two-counter approximation: `floor(prevCount * weight + currCount)`.

```typescript
rateLimiter({
  algorithm: { algorithm: "sliding-window", limit: 100, windowMs: 60_000 },
});
```

```
limit = 10

Previous Window          Current Window
┌──────────────┐        ┌──────────────┐
│  count = 8   │        │  count = 3   │
└──────────────┘        └──────────────┘
                             ^
                             |  we are 40% into this window
                             |  weight = 1 - 0.4 = 0.6

estimated = floor(prev x weight + current)
          = floor(8    x 0.6    + 3)
          = floor(7.8)
          = 7

7 < 10 -> ALLOWED (3 remaining)
```

The weight slides linearly as time progresses through the current window:

```
weight
 1.0 |\.
     |  \.
 0.5 |----\.----
     |      \.
 0.0 |--------\.
     +----------+---> time
     start     end
     of window

At start: weight=1.0, previous window counts fully
At mid:   weight=0.5, previous window counts half
At end:   weight=0.0, previous window ignored
```

Same O(1) memory as fixed window. No timestamp arrays.

> **Note:** Sliding window uses an approximate calculation. It blends two fixed window counters with linear interpolation instead of tracking exact timestamps. This is a deliberate tradeoff for O(1) performance. The estimation is slightly conservative and good enough for production use at Cloudflare and Nginx, but it is not exact. Keep this in mind if your use case requires precise counting.

Storage: `{ previousCount: 8, currentCount: 3, windowStart: ... }` -- **64 bytes per key**

| | |
|---|---|
| Time | O(1) |
| Space | O(1) per key |
| Redis | 1 `INCR` + 1 `GET` (pipelined, one round trip) |

### Token Bucket (GCRA)

Allows bursts up to `capacity` while enforcing a steady `refillRate` per second. The default.

```typescript
rateLimiter({
  algorithm: { algorithm: "token-bucket", capacity: 100, refillRate: 10 },
});
```

This is not a traditional token bucket. It uses GCRA (Generic Cell Rate Algorithm). Instead of storing token counts and running refill loops, it stores a single number -- **TAT** (Theoretical Arrival Time) -- and asks one question: "is it too early for this request?" Time passing *is* the refill.

```
capacity = 5,  refillRate = 1/sec
emissionInterval = 1000ms          (time between tokens)
burstOffset      = 5000ms          (capacity x emissionInterval)

Each request pushes TAT forward. If "too early", denied:

t=0ms   Req #1  newTat=1000   allowAt=-4000   0>-4000  ALLOWED  tat=1000
t=0ms   Req #2  newTat=2000   allowAt=-3000   0>-3000  ALLOWED  tat=2000
t=0ms   Req #3  newTat=3000   allowAt=-2000   0>-2000  ALLOWED  tat=3000
t=0ms   Req #4  newTat=4000   allowAt=-1000   0>-1000  ALLOWED  tat=4000
t=0ms   Req #5  newTat=5000   allowAt=0       0>=0     ALLOWED  tat=5000
t=0ms   Req #6  newTat=6000   allowAt=1000    0<1000   DENIED   retryAfter=1s
t=1000  Req #7  newTat=6000   allowAt=1000    1000>=1000 ALLOWED  (1 token refilled)
```

The "refill" is just time moving forward -- no counters, no loops:

```
tokens available over time (capacity=5, refill=1/sec)

 5 |* * * * *                              *---------
   |          \                           /
 4 |           \                         /
   |            \                       /
 3 |             \                     /
   |              \                   /
 2 |               \                 /
   |                \               /
 1 |                 \             /
   |                  \           /
 0 |                   *---------*
   +---+---+---+---+---+---+---+---+---+---+---> time(s)
       0   1   2   3   4   5   6   7   8   9

   <-- 5 reqs burst -->  <-- denied -->  <-- refilling -->
       at t=0              retryAfter      1 token/sec
```

A traditional token bucket stores `{tokens, lastRefillMs}`, needs a refill calculation on every request, and requires locking in Redis. GCRA stores one number and does one comparison. That is why Stripe, Cloudflare, Kong, and Shopify all use it.

Storage: `{ tat: 1712678405000 }` -- **21 bytes per key**

| | |
|---|---|
| Time | O(1) |
| Space | O(1) per key (21 bytes) |
| Redis | 1 `EVAL` (minimal Lua: read a number, compare, write a number) |

### Algorithm Comparison

```
               Fixed Window     Sliding Window    Token Bucket (GCRA)
             +----------------+------------------+--------------------+
 Time        |     O(1)       |      O(1)        |       O(1)         |
 Space/key   |   39 bytes     |    64 bytes      |     21 bytes       |
 Redis cmds  |   1 INCR       |  INCR + GET      |    1 EVAL (Lua)    |
 Burst       | 2x at edges    |  Smoothed        |  Controlled        |
 Precision   |   Exact        |  Approximate     |     Exact          |
 Best for    |  Simplicity    |  Smooth limiting |  APIs / billing    |
             +----------------+------------------+--------------------+
```

## Storage

### In-Memory (default)

No dependencies. 4.8M-5.7M ops/sec. Good for single-process deployments.

```typescript
import { MemoryStore } from "elysia-advanced-rate-limiter";

rateLimiter({
  store: new MemoryStore({
    cleanupIntervalMs: 60_000,  // evict expired keys (default: 60s)
    maxKeys: 100_000,           // cap on stored keys (default: unlimited)
  }),
});
```

### Redis (or any compatible store)

> **Caution:** If you are running on a cloud platform, prefer your provider's built-in rate limiting (AWS WAF, Cloudflare Rate Limiting, GCP Cloud Armor, etc.). They run at the edge, closer to the client, and do not add load to your application. Only use Redis-backed rate limiting when you cannot use those services and you need shared state across multiple application instances.

For multi-instance deployments. Works with ioredis, redis, or anything that implements `get`, `set`, `incr`, `pexpire`, and `eval`.

```typescript
import { RedisStore } from "elysia-advanced-rate-limiter";

new RedisStore(redis);                  // defaults
new RedisStore(redis, "rl:");           // custom prefix
new RedisStore(redis, "rl:", 5000);     // 5s timeout
```

How it talks to Redis:

| Algorithm | Commands | Blocks Redis? |
|---|---|---|
| Fixed window | `INCR` + `PEXPIRE` | No |
| Sliding window | `INCR` + `GET` (pipelined) | No |
| Token bucket | `EVAL` (GCRA Lua) | Briefly. Minimal script, no cjson. |

Fixed window and sliding window never use Lua. They use bare `INCR`, which is a single atomic Redis command that does not block other commands. That is an intentional design choice. Lua scripts execute atomically but block the entire Redis server during execution. Under high concurrency, that turns your rate limiter into a bottleneck.

### Resilient Store

Wraps any store with error handling. If Redis goes down, your app keeps running.

```typescript
import { ResilientStore, RedisStore } from "elysia-advanced-rate-limiter";

rateLimiter({
  store: new ResilientStore(new RedisStore(redis), {
    failMode: "open",     // allow traffic when store is down (default)
    threshold: 5,         // open circuit after 5 consecutive failures
    cooldownMs: 30_000,   // retry after 30s
    onError: (err) => console.error(err),
  }),
});
```

Set `failMode: "closed"` to deny traffic when the store is unavailable.

## Key Resolvers

Determine who gets rate limited.

```typescript
import {
  ipResolver,
  userResolver,
  composeResolvers,
} from "elysia-advanced-rate-limiter";

// IP-based (default)
rateLimiter({ keyResolver: ipResolver() });

// User-based. Extracts user ID from JWT or session cookie.
rateLimiter({ keyResolver: userResolver() });
rateLimiter({ keyResolver: userResolver({ cookieName: "session" }) });

// User first, fall back to IP.
rateLimiter({
  keyResolver: composeResolvers(userResolver(), ipResolver()),
});
```

### IP Resolution

The IP resolver checks headers in this order:

| Priority | Header | Set by | Spoofable? |
|---|---|---|---|
| 1 | `cf-connecting-ip` | Cloudflare | No |
| 2 | `x-real-ip` | nginx / load balancer | No |
| 3 | `x-forwarded-for` | Any proxy (or client) | Yes |
| 4 | `"anonymous"` | Fallback | N/A |

Trusted headers (`cf-connecting-ip`, `x-real-ip`) are checked first because they are set by your infrastructure and cannot be forged by clients. `x-forwarded-for` is checked last because anyone can send it.

**If you're behind Cloudflare**, it just works. No config needed -- `cf-connecting-ip` is always the real client IP.

**If you're behind nginx or a load balancer** that sets `x-real-ip`, it also just works.

**If you only have `x-forwarded-for`** (e.g. a plain reverse proxy), use `trustedProxyDepth` to prevent spoofing:

```typescript
// Behind 1 proxy (e.g. nginx that only sets x-forwarded-for)
rateLimiter({ keyResolver: ipResolver({ trustedProxyDepth: 1 }) });

// Behind 2 proxies (e.g. CDN → load balancer)
rateLimiter({ keyResolver: ipResolver({ trustedProxyDepth: 2 }) });
```

Without `trustedProxyDepth`, the resolver takes the leftmost IP in `x-forwarded-for`, which a client can fake:

```
Client sends:      x-forwarded-for: fake-ip
Your proxy adds:   x-forwarded-for: fake-ip, real-ip
                                    ^^^^^^
                                    leftmost = attacker controls the rate limit key
```

With `trustedProxyDepth: 1`, it takes the rightmost IP (the one your proxy added), which the client cannot control:

```
x-forwarded-for: fake-ip, real-ip
                           ^^^^^^^
                           rightmost = your proxy added this, safe
```

Set `trustedProxyDepth` to the number of proxies between the internet and your app.

## Multiple Rate Limits

You can stack multiple limiters on the same app. Use a high global limit per IP, and a stricter per-user limit on sensitive routes.

Each `rateLimiter()` call needs a unique `prefix`. The plugin uses the prefix to register itself with Elysia, so two limiters with the same prefix would be deduplicated.

Use `skip` to control which routes a limiter applies to:

```typescript
import { Elysia } from "elysia";
import {
  rateLimiter,
  ipResolver,
  userResolver,
  composeResolvers,
} from "elysia-advanced-rate-limiter";

const app = new Elysia()
  // Global: 100 req/min per IP (all routes)
  .use(
    rateLimiter({
      algorithm: { algorithm: "fixed-window", limit: 100, windowMs: 60_000 },
      keyResolver: ipResolver(),
      prefix: "global:",
    })
  )
  // Strict: 10 req/sec per user (only /api/* routes)
  .use(
    rateLimiter({
      algorithm: { algorithm: "token-bucket", capacity: 10, refillRate: 1 },
      keyResolver: composeResolvers(userResolver(), ipResolver()),
      prefix: "api:",
      skip: (req) => !new URL(req.url).pathname.startsWith("/api"),
    })
  )
  .get("/", () => "hello")
  .get("/public", () => "open")
  .get("/api/profile", () => "profile")
  .post("/api/upload", () => "uploaded")
  .listen(3000);
```

A request to `/api/profile` must pass both limiters: the global 100/min IP limit and the scoped 10/sec user limit. A request to `/public` only hits the global limiter because the api limiter skips non-`/api` paths.

## All Options

```typescript
rateLimiter({
  algorithm: { algorithm: "token-bucket", capacity: 100, refillRate: 10 },
  store: new MemoryStore(),
  keyResolver: ipResolver(),
  prefix: "rl:",
  skip: (request) => request.url.includes("/health"),
  errorResponse: (result) => ({
    error: "rate_limited",
    retryAfter: result.retryAfterMs,
  }),
});
```

## Response Headers

| Header | When |
|---|---|
| `X-RateLimit-Limit` | Always |
| `X-RateLimit-Remaining` | Always |
| `X-RateLimit-Reset` | Always |
| `Retry-After` | 429 only |

## Performance

Tested on Apple M3 Pro, 16GB RAM, local Redis, Bun runtime. These numbers are here to give you a rough idea, not a guarantee. Your results will vary depending on hardware, network, and workload.

| | Fixed Window | Sliding Window | Token Bucket |
|---|---|---|---|
| In-memory | 5.7M ops/sec | 4.8M ops/sec | 5.2M ops/sec |
| Redis (c=100) | 69,933 ops/sec | 65,139 ops/sec | 53,171 ops/sec |
| State per key | 39 bytes | 64 bytes | 21 bytes |
| Race conditions | 0 | 0 | 0 |

```bash
bun run bench              # full suite
bun run bench:throughput    # ops/sec
bun run bench:race          # concurrency correctness
bun run bench:burst         # burst accuracy
bun run bench:memory        # state sizes
```

## Why These Algorithms

**Fixed window** because it maps to a single `INCR`. One atomic command, no coordination needed. You cannot make Redis rate limiting faster than this.

**Sliding window** because the two-counter approximation gives you smooth limiting at the same O(1) cost. Storing timestamps per request (the "exact" approach) costs O(n) memory and gets expensive at scale.

**GCRA** because a traditional token bucket is a read-modify-write cycle that needs locking in distributed systems. GCRA reduces it to a single number comparison. The "refill" is just time moving forward. No refill loops, no floating point accumulation, no state synchronization problems.

## References

- [GCRA](https://en.wikipedia.org/wiki/Generic_cell_rate_algorithm) - originally designed for ATM networks, now the standard for distributed rate limiting
- [Stripe: Rate Limiters](https://stripe.com/blog/rate-limiters) - how Stripe uses token bucket (GCRA) at scale
- [Cloudflare: Counting Things](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) - sliding windows at billions of requests
- [Redis INCR Pattern](https://redis.io/commands/incr/#pattern-rate-limiter) - the official Redis rate limiting pattern

## License

MIT
