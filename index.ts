// Core types

// Store adapters
export { MemoryStore } from "./core/adapters/memory-store";
export type { RedisClient } from "./core/adapters/redis-store";
export { RedisStore } from "./core/adapters/redis-store";
export { ResilientStore } from "./core/adapters/resilient-store";
export { fixedWindow } from "./core/algorithms/fixed-window";
export { slidingWindow } from "./core/algorithms/sliding-window";
// Algorithms
export { tokenBucket } from "./core/algorithms/token-bucket";
export type {
  AlgorithmConfig,
  AlgorithmFn,
  FixedWindowConfig,
  KeyResolver,
  RateLimiterOptions,
  RateLimitResult,
  RateLimitStore,
  SlidingWindowConfig,
  StoredState,
  TokenBucketConfig,
} from "./core/types";
// Elysia plugin
export { rateLimiter } from "./plugin/elysia-plugin";
export { composeResolvers } from "./resolvers/compose";
// Key resolvers
export { ipResolver } from "./resolvers/ip-resolver";
export type { IpResolverOptions } from "./resolvers/ip-resolver";
export { userResolver } from "./resolvers/user-resolver";
