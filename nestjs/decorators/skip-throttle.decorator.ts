import { SetMetadata } from "@nestjs/common";
import { THROTTLER_SKIP } from "../throttler.constants";

/**
 * Skip rate limiting for a specific controller or route.
 *
 * @example
 * ```ts
 * @SkipThrottle()
 * @Get("health")
 * health() { return "ok"; }
 * ```
 */
export const SkipThrottle = () => SetMetadata(THROTTLER_SKIP, true);
