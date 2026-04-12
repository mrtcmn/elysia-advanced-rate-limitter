import type { ModuleMetadata, Type } from "@nestjs/common";
import type {
  AlgorithmConfig,
  RateLimitResult,
  RateLimitStore,
} from "../core/types";

export interface ThrottlerModuleOptions {
  algorithm?: AlgorithmConfig;
  store?: RateLimitStore;
  prefix?: string;
  errorMessage?: string | ((result: RateLimitResult) => string | object);
  skipIf?: (request: any) => boolean;
  getTracker?: (request: any) => string;
  ignoreUserAgents?: RegExp[];
}

export interface ThrottlerOptionsFactory {
  createThrottlerOptions():
    | ThrottlerModuleOptions
    | Promise<ThrottlerModuleOptions>;
}

export interface ThrottlerAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  useExisting?: Type<ThrottlerOptionsFactory>;
  useClass?: Type<ThrottlerOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => ThrottlerModuleOptions | Promise<ThrottlerModuleOptions>;
  inject?: any[];
}
