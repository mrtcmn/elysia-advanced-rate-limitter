import { describe, expect, it } from "bun:test";
import { ipResolver } from "../../resolvers/ip-resolver";

describe("ipResolver", () => {
  const resolve = ipResolver();

  function req(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/test", { headers });
  }

  describe("x-forwarded-for", () => {
    it("returns first IP from x-forwarded-for", () => {
      const key = resolve(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }));
      expect(key).toBe("1.2.3.4");
    });

    it("handles single IP in x-forwarded-for", () => {
      const key = resolve(req({ "x-forwarded-for": "10.0.0.1" }));
      expect(key).toBe("10.0.0.1");
    });

    it("trims whitespace", () => {
      const key = resolve(req({ "x-forwarded-for": "  1.2.3.4 , 5.6.7.8" }));
      expect(key).toBe("1.2.3.4");
    });

    it("skips empty x-forwarded-for", () => {
      const key = resolve(req({ "x-forwarded-for": "" }));
      expect(key).toBe("anonymous");
    });
  });

  describe("cf-connecting-ip", () => {
    it("falls back to cf-connecting-ip when no xff", () => {
      const key = resolve(req({ "cf-connecting-ip": "203.0.113.1" }));
      expect(key).toBe("203.0.113.1");
    });
  });

  describe("x-real-ip", () => {
    it("falls back to x-real-ip when no xff or cf-connecting-ip", () => {
      const key = resolve(req({ "x-real-ip": "198.51.100.1" }));
      expect(key).toBe("198.51.100.1");
    });
  });

  describe("priority order", () => {
    it("prefers x-forwarded-for over cf-connecting-ip", () => {
      const key = resolve(
        req({
          "x-forwarded-for": "1.1.1.1",
          "cf-connecting-ip": "2.2.2.2",
          "x-real-ip": "3.3.3.3",
        })
      );
      expect(key).toBe("1.1.1.1");
    });

    it("prefers cf-connecting-ip over x-real-ip", () => {
      const key = resolve(
        req({
          "cf-connecting-ip": "2.2.2.2",
          "x-real-ip": "3.3.3.3",
        })
      );
      expect(key).toBe("2.2.2.2");
    });
  });

  describe("fallback", () => {
    it("returns 'anonymous' when no headers present", () => {
      const key = resolve(req());
      expect(key).toBe("anonymous");
    });
  });

  describe("IPv6 addresses", () => {
    it("handles IPv6 in x-forwarded-for", () => {
      const key = resolve(
        req({ "x-forwarded-for": "::1, 2001:db8::1" })
      );
      expect(key).toBe("::1");
    });
  });

  describe("always returns a string (never null)", () => {
    it("never returns null", () => {
      const key = resolve(req());
      expect(key).not.toBeNull();
      expect(typeof key).toBe("string");
    });
  });
});
