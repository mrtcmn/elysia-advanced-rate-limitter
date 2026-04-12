import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MemoryStore } from "../core/adapters/memory-store";
import type {
  AlgorithmConfig,
  RateLimitResult,
  RateLimitStore,
} from "../core/types";
import { THROTTLER_ALGORITHM, THROTTLER_OPTIONS, THROTTLER_SKIP } from "./throttler.constants";
import type { ThrottlerModuleOptions } from "./throttler.interfaces";

const MAX_RETRY_MS = 2_147_483_647;

function sanitize(val: number): number {
  return Number.isFinite(val) ? val : MAX_RETRY_MS;
}

function computeTtlMs(config: AlgorithmConfig): number {
  switch (config.algorithm) {
    case "token-bucket":
      return Math.ceil((config.capacity / config.refillRate) * 1000) + 60_000;
    case "sliding-window":
    case "fixed-window":
      return config.windowMs + 60_000;
  }
}

@Injectable()
export class ThrottlerGuard implements CanActivate {
  private readonly store: RateLimitStore;
  private readonly defaultAlgorithm: AlgorithmConfig;
  private readonly prefix: string;
  private readonly skipIf?: (req: any) => boolean;
  private readonly getTracker: (req: any) => string;
  private readonly ignoreUserAgents: RegExp[];
  private readonly errorMessage:
    | string
    | ((result: RateLimitResult) => string | object);

  constructor(
    @Inject(THROTTLER_OPTIONS) private readonly options: ThrottlerModuleOptions,
    private readonly reflector: Reflector
  ) {
    this.defaultAlgorithm = options.algorithm ?? {
      algorithm: "token-bucket",
      capacity: 100,
      refillRate: 10,
    };
    this.store = options.store ?? new MemoryStore({ maxKeys: 100_000 });
    this.prefix = options.prefix ?? "rl:";
    this.skipIf = options.skipIf;
    this.getTracker = options.getTracker ?? this.defaultGetTracker;
    this.ignoreUserAgents = options.ignoreUserAgents ?? [];
    this.errorMessage = options.errorMessage ?? "Too Many Requests";
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skipClass = this.reflector.get<boolean>(
      THROTTLER_SKIP,
      context.getClass()
    );
    if (skipClass) return true;

    const skipHandler = this.reflector.get<boolean>(
      THROTTLER_SKIP,
      context.getHandler()
    );
    if (skipHandler) return true;

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    if (this.skipIf?.(req)) return true;

    const userAgent: string = req.headers?.["user-agent"] ?? "";
    if (this.ignoreUserAgents.some((regex) => regex.test(userAgent))) {
      return true;
    }

    const algorithmConfig =
      this.reflector.getAllAndOverride<AlgorithmConfig>(THROTTLER_ALGORITHM, [
        context.getHandler(),
        context.getClass(),
      ]) ?? this.defaultAlgorithm;

    const tracker = this.getTracker(req);
    const storeKey = `${this.prefix}${tracker}`;
    const ttlMs = computeTtlMs(algorithmConfig);
    const nowMs = Date.now();

    const result = await this.store.check(
      storeKey,
      algorithmConfig,
      nowMs,
      ttlMs
    );

    const remaining = sanitize(result.remaining);
    const resetMs = sanitize(result.resetMs);
    const resetTimestamp = String(Math.ceil((nowMs + resetMs) / 1000));

    res.header("X-RateLimit-Limit", String(result.limit));
    res.header("X-RateLimit-Remaining", String(remaining));
    res.header("X-RateLimit-Reset", resetTimestamp);

    if (!result.allowed) {
      const retryAfterMs = sanitize(result.retryAfterMs);
      const retryAfter = String(Math.ceil(retryAfterMs / 1000));
      res.header("Retry-After", retryAfter);

      const body =
        typeof this.errorMessage === "function"
          ? this.errorMessage(result)
          : { statusCode: 429, message: this.errorMessage };

      throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }

  private defaultGetTracker(req: any): string {
    const cfIp = req.headers?.["cf-connecting-ip"];
    if (cfIp) return cfIp;

    const realIp = req.headers?.["x-real-ip"];
    if (realIp) return realIp;

    const xff = req.headers?.["x-forwarded-for"];
    if (xff) {
      const first = typeof xff === "string" ? xff.split(",")[0]?.trim() : xff[0];
      if (first) return first;
    }

    return req.ip ?? req.socket?.remoteAddress ?? "anonymous";
  }
}
