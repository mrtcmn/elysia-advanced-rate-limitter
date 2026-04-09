import { describe, expect, it } from "bun:test";
import { userResolver } from "../../resolvers/user-resolver";

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload));
  const sig = btoa("fake-sig");
  return `${header}.${body}.${sig}`;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/test", { headers });
}

describe("userResolver", () => {
  describe("Bearer token (Authorization header)", () => {
    const resolve = userResolver();

    it("extracts sub from JWT", () => {
      const token = makeJwt({ sub: "user-123" });
      const key = resolve(req({ authorization: `Bearer ${token}` }));
      expect(key).toBe("user:user-123");
    });

    it("extracts userId from JWT when no sub", () => {
      const token = makeJwt({ userId: "uid-456" });
      const key = resolve(req({ authorization: `Bearer ${token}` }));
      expect(key).toBe("user:uid-456");
    });

    it("extracts id from JWT when no sub or userId", () => {
      const token = makeJwt({ id: "id-789" });
      const key = resolve(req({ authorization: `Bearer ${token}` }));
      expect(key).toBe("user:id-789");
    });

    it("prefers sub over userId", () => {
      const token = makeJwt({ sub: "sub-1", userId: "uid-2" });
      const key = resolve(req({ authorization: `Bearer ${token}` }));
      expect(key).toBe("user:sub-1");
    });

    it("returns null for invalid JWT (not 3 parts)", () => {
      const key = resolve(req({ authorization: "Bearer not.a.valid.jwt.here" }));
      expect(key).toBeNull();
    });

    it("returns null for JWT with no user fields", () => {
      const token = makeJwt({ email: "test@test.com" });
      const key = resolve(req({ authorization: `Bearer ${token}` }));
      expect(key).toBeNull();
    });

    it("returns null for non-Bearer auth", () => {
      const key = resolve(req({ authorization: "Basic dXNlcjpwYXNz" }));
      expect(key).toBeNull();
    });

    it("returns null for malformed base64 in JWT", () => {
      const key = resolve(req({ authorization: "Bearer aaa.!!!invalid!!!.bbb" }));
      expect(key).toBeNull();
    });
  });

  describe("session cookie", () => {
    const resolve = userResolver();

    it("extracts user from default session cookie", () => {
      const token = makeJwt({ sub: "cookie-user" });
      const key = resolve(
        req({ cookie: `better-auth.session_token=${token}` })
      );
      expect(key).toBe("user:cookie-user");
    });

    it("handles multiple cookies", () => {
      const token = makeJwt({ sub: "from-cookie" });
      const key = resolve(
        req({
          cookie: `other=value; better-auth.session_token=${token}; another=thing`,
        })
      );
      expect(key).toBe("user:from-cookie");
    });

    it("returns null when cookie has no user fields", () => {
      const token = makeJwt({ role: "admin" });
      const key = resolve(
        req({ cookie: `better-auth.session_token=${token}` })
      );
      expect(key).toBeNull();
    });

    it("returns null when session cookie is missing", () => {
      const key = resolve(req({ cookie: "other=value" }));
      expect(key).toBeNull();
    });
  });

  describe("custom cookieName", () => {
    const resolve = userResolver({ cookieName: "my_session" });

    it("uses custom cookie name", () => {
      const token = makeJwt({ sub: "custom-cookie" });
      const key = resolve(req({ cookie: `my_session=${token}` }));
      expect(key).toBe("user:custom-cookie");
    });

    it("ignores default cookie name", () => {
      const token = makeJwt({ sub: "default" });
      const key = resolve(
        req({ cookie: `better-auth.session_token=${token}` })
      );
      expect(key).toBeNull();
    });
  });

  describe("custom parseJwt", () => {
    const resolve = userResolver({
      parseJwt: (token) => {
        if (token === "magic-token") return "custom-user-id";
        return null;
      },
    });

    it("uses custom parser for Bearer token", () => {
      const key = resolve(req({ authorization: "Bearer magic-token" }));
      expect(key).toBe("user:custom-user-id");
    });

    it("returns null when custom parser returns null", () => {
      const key = resolve(req({ authorization: "Bearer unknown-token" }));
      expect(key).toBeNull();
    });
  });

  describe("priority: Bearer over cookie", () => {
    const resolve = userResolver();

    it("prefers Authorization header over cookie", () => {
      const bearerToken = makeJwt({ sub: "bearer-user" });
      const cookieToken = makeJwt({ sub: "cookie-user" });
      const key = resolve(
        req({
          authorization: `Bearer ${bearerToken}`,
          cookie: `better-auth.session_token=${cookieToken}`,
        })
      );
      expect(key).toBe("user:bearer-user");
    });
  });

  describe("no auth at all", () => {
    const resolve = userResolver();

    it("returns null with no headers", () => {
      const key = resolve(req());
      expect(key).toBeNull();
    });

    it("returns null with unrelated headers", () => {
      const key = resolve(req({ "content-type": "application/json" }));
      expect(key).toBeNull();
    });
  });

  describe("cookie with = in value", () => {
    const resolve = userResolver();

    it("handles tokens containing = characters", () => {
      const token = makeJwt({ sub: "eq-user" });
      // JWT tokens can contain = in base64
      const key = resolve(
        req({ cookie: `better-auth.session_token=${token}` })
      );
      expect(key).toBe("user:eq-user");
    });
  });
});
