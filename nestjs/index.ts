// Decorators
export { SkipThrottle, Throttle } from "./decorators";

// Guard
export { ThrottlerGuard } from "./throttler.guard";

// Module
export { ThrottlerModule } from "./throttler.module";

// Constants
export { THROTTLER_OPTIONS } from "./throttler.constants";

// Interfaces
export type {
  ThrottlerAsyncOptions,
  ThrottlerModuleOptions,
  ThrottlerOptionsFactory,
} from "./throttler.interfaces";

// Re-export core types and stores for convenience
export type {
  AlgorithmConfig,
  FixedWindowConfig,
  RateLimitResult,
  RateLimitStore,
  SlidingWindowConfig,
  StoredState,
  TokenBucketConfig,
} from "../core/types";
export { MemoryStore } from "../core/adapters/memory-store";
export { RedisStore } from "../core/adapters/redis-store";
export { ResilientStore } from "../core/adapters/resilient-store";
