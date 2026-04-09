import type { KeyResolver } from "../core/types";

/**
 * Tries each resolver in order, returns the first non-null result.
 * Useful for: composeResolvers(userResolver(), ipResolver())
 */
export function composeResolvers(...resolvers: KeyResolver[]): KeyResolver {
  return (request: Request): string | null => {
    for (const resolver of resolvers) {
      const key = resolver(request);
      if (key !== null) {
        return key;
      }
    }
    return null;
  };
}
