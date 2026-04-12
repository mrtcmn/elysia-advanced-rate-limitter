import { DynamicModule, Module, Provider } from "@nestjs/common";
import { THROTTLER_OPTIONS } from "./throttler.constants";
import { ThrottlerGuard } from "./throttler.guard";
import type {
  ThrottlerAsyncOptions,
  ThrottlerModuleOptions,
  ThrottlerOptionsFactory,
} from "./throttler.interfaces";

@Module({})
export class ThrottlerModule {
  static forRoot(options: ThrottlerModuleOptions = {}): DynamicModule {
    return {
      module: ThrottlerModule,
      global: true,
      providers: [
        { provide: THROTTLER_OPTIONS, useValue: options },
        ThrottlerGuard,
      ],
      exports: [THROTTLER_OPTIONS, ThrottlerGuard],
    };
  }

  static forRootAsync(options: ThrottlerAsyncOptions): DynamicModule {
    const providers = this.createAsyncProviders(options);
    return {
      module: ThrottlerModule,
      global: true,
      imports: options.imports ?? [],
      providers: [...providers, ThrottlerGuard],
      exports: [THROTTLER_OPTIONS, ThrottlerGuard],
    };
  }

  private static createAsyncProviders(
    options: ThrottlerAsyncOptions
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }

    if (options.useClass) {
      return [
        this.createAsyncOptionsProvider(options),
        { provide: options.useClass, useClass: options.useClass },
      ];
    }

    return [{ provide: THROTTLER_OPTIONS, useValue: {} }];
  }

  private static createAsyncOptionsProvider(
    options: ThrottlerAsyncOptions
  ): Provider {
    if (options.useFactory) {
      return {
        provide: THROTTLER_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }

    const inject = options.useExisting ?? options.useClass;
    return {
      provide: THROTTLER_OPTIONS,
      useFactory: (factory: ThrottlerOptionsFactory) =>
        factory.createThrottlerOptions(),
      inject: inject ? [inject] : [],
    };
  }
}
