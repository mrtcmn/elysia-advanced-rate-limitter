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

  describe("trustedProxyDepth", () => {
    it("depth=1: takes rightmost (last) IP from x-forwarded-for", () => {
      const r = ipResolver({ trustedProxyDepth: 1 });
      const key = r(req({ "x-forwarded-for": "spoofed, 1.2.3.4" }));
      expect(key).toBe("1.2.3.4");
    });

    it("depth=2: takes 2nd-from-right IP", () => {
      const r = ipResolver({ trustedProxyDepth: 2 });
      const key = r(req({ "x-forwarded-for": "client, proxy1, proxy2" }));
      expect(key).toBe("proxy1");
    });

    it("depth=1 with single IP returns that IP", () => {
      const r = ipResolver({ trustedProxyDepth: 1 });
      const key = r(req({ "x-forwarded-for": "10.0.0.1" }));
      expect(key).toBe("10.0.0.1");
    });

    it("depth exceeding IP count clamps to first IP", () => {
      const r = ipResolver({ trustedProxyDepth: 5 });
      const key = r(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }));
      expect(key).toBe("1.1.1.1");
    });

    it("depth=0 behaves like legacy (takes first IP)", () => {
      const r = ipResolver({ trustedProxyDepth: 0 });
      const key = r(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }));
      expect(key).toBe("1.1.1.1");
    });

    it("depth=1 prevents client-side spoofing", () => {
      const r = ipResolver({ trustedProxyDepth: 1 });
      // Attacker sends x-forwarded-for: fake-ip
      // Proxy appends real IP → "fake-ip, real-ip"
      const key = r(req({ "x-forwarded-for": "fake-ip, real-ip" }));
      expect(key).toBe("real-ip");
    });

    it("falls back to cf-connecting-ip when xff is empty with depth", () => {
      const r = ipResolver({ trustedProxyDepth: 1 });
      const key = r(req({ "cf-connecting-ip": "203.0.113.1" }));
      expect(key).toBe("203.0.113.1");
    });
  });
});
