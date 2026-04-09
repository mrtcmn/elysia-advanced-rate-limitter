import { describe, expect, it } from "bun:test";
import type { KeyResolver } from "../../core/types";
import { composeResolvers } from "../../resolvers/compose";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/test", { headers });
}

describe("composeResolvers", () => {
  it("returns first non-null result", () => {
    const r1: KeyResolver = () => null;
    const r2: KeyResolver = () => "from-r2";
    const r3: KeyResolver = () => "from-r3";
    const composed = composeResolvers(r1, r2, r3);
    expect(composed(req())).toBe("from-r2");
  });

  it("returns null when all resolvers return null", () => {
    const r1: KeyResolver = () => null;
    const r2: KeyResolver = () => null;
    const composed = composeResolvers(r1, r2);
    expect(composed(req())).toBeNull();
  });

  it("returns first resolver result if non-null", () => {
    const r1: KeyResolver = () => "first";
    const r2: KeyResolver = () => "second";
    const composed = composeResolvers(r1, r2);
    expect(composed(req())).toBe("first");
  });

  it("skips null resolvers and finds the match", () => {
    const resolvers: KeyResolver[] = [
      () => null,
      () => null,
      () => null,
      () => "found",
    ];
    const composed = composeResolvers(...resolvers);
    expect(composed(req())).toBe("found");
  });

  it("works with a single resolver", () => {
    const composed = composeResolvers(() => "only");
    expect(composed(req())).toBe("only");
  });

  it("works with zero resolvers", () => {
    const composed = composeResolvers();
    expect(composed(req())).toBeNull();
  });

  it("passes the request to each resolver", () => {
    const calls: Request[] = [];
    const r1: KeyResolver = (r) => {
      calls.push(r);
      return null;
    };
    const r2: KeyResolver = (r) => {
      calls.push(r);
      return "done";
    };
    const request = req();
    composeResolvers(r1, r2)(request);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(request);
    expect(calls[1]).toBe(request);
  });

  it("does not call subsequent resolvers after a match", () => {
    let r2Called = false;
    const r1: KeyResolver = () => "hit";
    const r2: KeyResolver = () => {
      r2Called = true;
      return "never";
    };
    composeResolvers(r1, r2)(req());
    expect(r2Called).toBe(false);
  });
});
