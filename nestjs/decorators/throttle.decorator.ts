import { SetMetadata } from "@nestjs/common";
import type { AlgorithmConfig } from "../../core/types";
import { THROTTLER_ALGORITHM } from "../throttler.constants";

/**
 * Override the default rate limit algorithm for a specific controller or route.
 *
 * @example
 * ```ts
 * @Throttle({ algorithm: "fixed-window", limit: 5, windowMs: 60_000 })
 * @Post("login")
 * login() { ... }
 * ```
 */
export const Throttle = (config: AlgorithmConfig) =>
  SetMetadata(THROTTLER_ALGORITHM, config);
