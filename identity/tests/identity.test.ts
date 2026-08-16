/**
 * Unit tests for @keelsonhq/identity SDK.
 *
 * Uses a real local HTTP server to verify the full transport layer,
 * including Host header preservation on the wire.
 */

import { describe, it, expect, afterEach } from "vitest";
import { startMockServer, startMockErrorServer, withEnv, type MockServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Config: env var guards
// ---------------------------------------------------------------------------

describe("config", () => {
  it("getBaseUrl returns trimmed URL without trailing slash", async () => {
    await withEnv({ KEELSON_IDENTITY_BASE_URL: "  http://test/  " }, async () => {
      const { getBaseUrl } = await import("../src/config.js");
      expect(getBaseUrl()).toBe("http://test");
    });
  });

  it("getBaseUrl throws IdentityError when not set", async () => {
    await withEnv({ KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { getBaseUrl, IdentityError } = await import("../src/config.js");
      expect(() => getBaseUrl()).toThrow(IdentityError);
    });
  });

  it("isLocalMode returns true for '1'", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1" }, async () => {
      const { isLocalMode } = await import("../src/config.js");
      expect(isLocalMode()).toBe(true);
    });
  });

  it("isLocalMode returns false when unset", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined }, async () => {
      const { isLocalMode } = await import("../src/config.js");
      expect(isLocalMode()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// getCurrentUser
// ---------------------------------------------------------------------------

describe("getCurrentUser", () => {
  it("reads trusted user headers from a plain object", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined }, async () => {
      const { getCurrentUser } = await import("../src/client.js");
      const result = await getCurrentUser({
        headers: {
          "x-keelson-user-id": "u-1",
          "x-keelson-user-email": "test@example.com",
          "x-keelson-user-name": "Test User",
        },
      });

      expect(result).toEqual({
        id: "u-1",
        email: "test@example.com",
        name: "Test User",
      });
    });
  });

  it("reads headers case-insensitively and accepts array values", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined }, async () => {
      const { getCurrentUser } = await import("../src/client.js");
      const result = await getCurrentUser({
        headers: {
          "X-Keelson-User-Id": ["", "u-2"],
          "X-Keelson-User-Email": ["alice@example.com"],
        },
      });

      expect(result.id).toBe("u-2");
      expect(result.email).toBe("alice@example.com");
      expect(result.name).toBeNull();
    });
  });

  it("accepts WHATWG Headers", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined }, async () => {
      const { getCurrentUser } = await import("../src/client.js");
      const headers = new Headers({
        "x-keelson-user-id": "u-headers",
        "x-keelson-user-name": "Header User",
      });

      const result = await getCurrentUser({ headers });
      expect(result.id).toBe("u-headers");
      expect(result.name).toBe("Header User");
    });
  });

  it("throws IdentityError when the user id header is missing", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined }, async () => {
      const { getCurrentUser } = await import("../src/client.js");
      const { IdentityError } = await import("../src/config.js");
      await expect(getCurrentUser({ headers: {} })).rejects.toThrow(IdentityError);
      await expect(getCurrentUser({ headers: {} })).rejects.toThrow("x-keelson-user-id");
    });
  });

  it("returns fixture data in local mode", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1", KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { getCurrentUser } = await import("../src/client.js");
      const result = await getCurrentUser();
      expect(result.id).toBe("local-user-001");
      expect(result.email).toBe("dev@localhost");
    });
  });
});

// ---------------------------------------------------------------------------
// getCurrentIdentity
// ---------------------------------------------------------------------------

describe("getCurrentIdentity", () => {
  let server: MockServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const IDENTITY_PAYLOAD = {
    user: { id: "u-1", email: "test@example.com", name: "Test User" },
    tenant: { id: "t-1", role: "OWNER" },
    app: { id: "a-1", permissions: ["manage"], roles: [] },
    attributes: { groups: ["everyone", "owners"] },
  };

  it("calls the app-as-actor identity endpoint with app_token", async () => {
    server = await startMockServer(IDENTITY_PAYLOAD);
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: undefined }, async () => {
      const { getCurrentIdentity } = await import("../src/client.js");
      const result = await getCurrentIdentity({
        base_url: server!.baseUrl,
        app_token: "keelson_xyz",
        host: "myapp.keelson.run",
        headers: { "x-keelson-user-id": "u-1" },
      });

      expect(server!.calls).toHaveLength(1);
      const req = server!.calls[0];
      expect(req.url).toBe("/__keelson/users/u-1/identity");
      expect(req.method).toBe("GET");
      expect(req.headers["authorization"]).toBe("Bearer keelson_xyz");
      expect(req.headers["cookie"]).toBeUndefined();
      expect(req.headers["accept"]).toBe("application/json");
      expect(req.headers["host"]).toBe("myapp.keelson.run");

      expect(result.user.id).toBe("u-1");
      expect(result.tenant.role).toBe("OWNER");
      expect(result.app.permissions).toEqual(["manage"]);
      expect(result.attributes?.groups).toEqual(["everyone", "owners"]);
    });
  });

  it("falls back to KEELSON_DIRECTORY_TOKEN", async () => {
    server = await startMockServer(IDENTITY_PAYLOAD);
    await withEnv(
      { KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: "keelson_env" },
      async () => {
        const { getCurrentIdentity } = await import("../src/client.js");
        await getCurrentIdentity({
          base_url: server!.baseUrl,
          headers: new Headers({ "x-keelson-user-id": "u-env" }),
        });
        expect(server!.calls[0].headers["authorization"]).toBe("Bearer keelson_env");
      },
    );
  });

  it("falls back to KEELSON_DIRECTORY_TOKEN when app_token is blank", async () => {
    server = await startMockServer(IDENTITY_PAYLOAD);
    await withEnv(
      { KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: "keelson_env" },
      async () => {
        const { getCurrentIdentity } = await import("../src/client.js");
        await getCurrentIdentity({
          base_url: server!.baseUrl,
          app_token: "  ",
          headers: { "x-keelson-user-id": "u-env" },
        });
        expect(server!.calls[0].headers["authorization"]).toBe("Bearer keelson_env");
      },
    );
  });

  it("accepts Bearer app-token authorization", async () => {
    server = await startMockServer(IDENTITY_PAYLOAD);
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: undefined }, async () => {
      const { getCurrentIdentity } = await import("../src/client.js");
      await getCurrentIdentity({
        base_url: server!.baseUrl,
        authorization: "Bearer keelson_auth",
        headers: { "x-keelson-user-id": "u-auth" },
      });
      expect(server!.calls[0].headers["authorization"]).toBe("Bearer keelson_auth");
    });
  });

  it("ignores cookie and authorization in subject headers", async () => {
    server = await startMockServer(IDENTITY_PAYLOAD);
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: undefined }, async () => {
      const { getCurrentIdentity } = await import("../src/client.js");
      await getCurrentIdentity({
        base_url: server!.baseUrl,
        app_token: "keelson_xyz",
        headers: {
          "x-keelson-user-id": "u-headers",
          cookie: "sid=browser",
          authorization: "Bearer ey.user.jwt",
        },
      });
      expect(server!.calls[0].headers["authorization"]).toBe("Bearer keelson_xyz");
      expect(server!.calls[0].headers["cookie"]).toBeUndefined();
    });
  });

  it("rejects cookie credentials", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: "keelson_env" }, async () => {
      const { getCurrentIdentity } = await import("../src/client.js");
      await expect(
        getCurrentIdentity({
          cookie: "session=abc",
          headers: { "x-keelson-user-id": "u-1" },
        }),
      ).rejects.toThrow("cookie is not supported");
    });
  });

  it("requires an app-token credential before the network call", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: undefined }, async () => {
      const { getCurrentIdentity } = await import("../src/client.js");
      await expect(
        getCurrentIdentity({
          base_url: "http://127.0.0.1:1",
          headers: { "x-keelson-user-id": "u-1" },
        }),
      ).rejects.toThrow("requires app_token");
    });
  });

  it("rejects non app-token authorization", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: undefined }, async () => {
      const { getCurrentIdentity } = await import("../src/client.js");
      await expect(
        getCurrentIdentity({
          authorization: "Bearer ey.jwt",
          headers: { "x-keelson-user-id": "u-1" },
        }),
      ).rejects.toThrow("Bearer app token");
    });
  });

  it("throws IdentityError on 404", async () => {
    server = await startMockErrorServer(404, "Not found");
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_DIRECTORY_TOKEN: undefined }, async () => {
      const { getCurrentIdentity } = await import("../src/client.js");
      await expect(
        getCurrentIdentity({
          base_url: server!.baseUrl,
          app_token: "keelson_xyz",
          headers: { "x-keelson-user-id": "unknown" },
        }),
      ).rejects.toThrow("404");
    });
  });

  it("returns full fixture data in local mode", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1", KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { getCurrentIdentity } = await import("../src/client.js");
      const result = await getCurrentIdentity();
      expect(result.user.id).toBe("local-user-001");
      expect(result.tenant.role).toBe("OWNER");
      expect(result.attributes?.groups).toContain("everyone");
    });
  });
});

// ---------------------------------------------------------------------------
// listMembers
// ---------------------------------------------------------------------------

describe("listMembers", () => {
  let server: MockServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const MEMBERS_PAYLOAD = {
    items: [
      { id: "u-1", email: "a@b.com", name: "A", role: "OWNER" },
      { id: "u-2", email: "c@d.com", name: "C", role: "ADMIN" },
    ],
    limit: 25,
    offset: 0,
    next_offset: null,
  };

  it("calls GET /__keelson/members with query params", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { listMembers } = await import("../src/client.js");
      const result = await listMembers({ limit: 10, offset: 5, q: "alice", role: "ADMIN" });

      const url = new URL(server!.calls[0].url, server!.baseUrl);
      expect(url.pathname).toBe("/__keelson/members");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("offset")).toBe("5");
      expect(url.searchParams.get("q")).toBe("alice");
      expect(url.searchParams.get("role")).toBe("ADMIN");

      expect(result.items).toHaveLength(2);
      expect(result.items[0].email).toBe("a@b.com");
      expect(result.next_offset).toBeNull();
    });
  });

  it("omits undefined query params", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { listMembers } = await import("../src/client.js");
      await listMembers();

      const url = new URL(server!.calls[0].url, server!.baseUrl);
      expect(url.search).toBe("");
    });
  });

  it("returns fixture data in local mode with filtering", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1", KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { listMembers } = await import("../src/client.js");
      const result = await listMembers({ q: "alice" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("Alice (local)");
    });
  });

  it("forwards group_id as a query param", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { listMembers } = await import("../src/client.js");
      await listMembers({ group_id: "grp_xyz" });

      const url = new URL(server!.calls[0].url, server!.baseUrl);
      expect(url.searchParams.get("group_id")).toBe("grp_xyz");
    });
  });

  it("filters by group_id in local mode", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1", KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { listMembers } = await import("../src/client.js");
      const result = await listMembers({ group_id: "local-group-owners" });
      expect(result.items.every((m) => m.role === "OWNER")).toBe(true);
      expect(result.items.length).toBeGreaterThanOrEqual(1);

      const unknown = await listMembers({ group_id: "no-such-id" });
      expect(unknown.items).toHaveLength(0);
    });
  });

  it("rejects group_id and group_key together", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1", KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { listMembers } = await import("../src/client.js");
      const { IdentityError } = await import("../src/config.js");
      await expect(listMembers({ group_id: "g1", group_key: "owners" })).rejects.toThrow(
        IdentityError,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// getUser
// ---------------------------------------------------------------------------

describe("getUser", () => {
  let server: MockServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("calls GET /__keelson/users/{id}", async () => {
    server = await startMockServer({ id: "u-1", email: "a@b.com", name: "A", role: "OWNER" });
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { getUser } = await import("../src/client.js");
      const result = await getUser("u-1");

      expect(server!.calls[0].url).toBe("/__keelson/users/u-1");
      expect(result.id).toBe("u-1");
      expect(result.email).toBe("a@b.com");
    });
  });

  it("encodes special characters in user_id", async () => {
    server = await startMockServer({ id: "a/b", email: "x@y.com", name: "X", role: null });
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { getUser } = await import("../src/client.js");
      await getUser("a/b");

      expect(server!.calls[0].url).toBe("/__keelson/users/a%2Fb");
    });
  });

  it("throws on empty user_id", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: "http://test-proxy" }, async () => {
      const { getUser } = await import("../src/client.js");
      const { IdentityError } = await import("../src/config.js");
      await expect(getUser("  ")).rejects.toThrow(IdentityError);
    });
  });

  it("throws IdentityError on 404", async () => {
    server = await startMockErrorServer(404, "Not found");
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { getUser } = await import("../src/client.js");
      await expect(getUser("unknown")).rejects.toThrow("404");
    });
  });

  it("returns fixture data in local mode", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1", KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { getUser } = await import("../src/client.js");
      const result = await getUser("local-user-002");
      expect(result.name).toBe("Alice (local)");
    });
  });

  it("throws in local mode for unknown user", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1", KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { getUser } = await import("../src/client.js");
      await expect(getUser("unknown")).rejects.toThrow("404");
    });
  });
});

// ---------------------------------------------------------------------------
// listGroups
// ---------------------------------------------------------------------------

describe("listGroups", () => {
  let server: MockServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("calls GET /__keelson/groups", async () => {
    server = await startMockServer({
      items: [
        { id: "g-everyone", key: "everyone", display_name: "Everyone", kind: "SYSTEM", system_kind: "everyone" },
        { id: "g-team-a", key: "team-a", display_name: "Team A", kind: "CUSTOM", system_kind: null },
        { id: "g-keyless", key: null, display_name: "Keyless Team", kind: "CUSTOM", system_kind: null },
      ],
    });
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { listGroups } = await import("../src/client.js");
      const result = await listGroups();

      expect(server!.calls[0].url).toBe("/__keelson/groups");
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("g-everyone");
      expect(result[0].key).toBe("everyone");
      expect(result[0].kind).toBe("SYSTEM");
      expect(result[1].system_kind).toBeNull();
      // A keyless group carries an id but key is null.
      expect(result[2].id).toBe("g-keyless");
      expect(result[2].key).toBeNull();
    });
  });

  it("returns fixture data in local mode", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: "1", KEELSON_IDENTITY_BASE_URL: undefined }, async () => {
      const { listGroups } = await import("../src/client.js");
      const result = await listGroups();
      expect(result.length).toBeGreaterThanOrEqual(4);
      expect(result.map((g) => g.key)).toContain("everyone");
    });
  });

  it("rejects a group with an empty key string", async () => {
    server = await startMockServer({
      items: [{ id: "g1", key: "", display_name: "X", kind: "CUSTOM", system_kind: null }],
    });
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { listGroups } = await import("../src/client.js");
      await expect(listGroups()).rejects.toThrow("empty 'key'");
    });
  });
});

// ---------------------------------------------------------------------------
// Host header wire-level verification
// ---------------------------------------------------------------------------

describe("Host header passthrough", () => {
  let server: MockServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("custom Host header arrives on Directory requests", async () => {
    const payload = { items: [], limit: 25, offset: 0, next_offset: null };
    server = await startMockServer(payload);
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { listMembers } = await import("../src/client.js");
      await listMembers({ host: "myapp.keelson.run" });

      // The server receives the caller-provided Host, NOT the socket address
      expect(server!.calls[0].headers["host"]).toBe("myapp.keelson.run");
    });
  });

  it("without explicit host, Directory requests use socket address as Host", async () => {
    const payload = { items: [], limit: 25, offset: 0, next_offset: null };
    server = await startMockServer(payload);
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: server.baseUrl }, async () => {
      const { listMembers } = await import("../src/client.js");
      await listMembers();

      // Without explicit host, the transport's default Host (socket addr) is used
      expect(server!.calls[0].headers["host"]).toContain("127.0.0.1");
    });
  });
});

// ---------------------------------------------------------------------------
// app-as-actor (app_token) support
// ---------------------------------------------------------------------------

describe("app-as-actor Directory access", () => {
  let server: MockServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const MEMBERS_PAYLOAD = { items: [], limit: 25, offset: 0, next_offset: null };

  it("listMembers sends app_token as Bearer Authorization", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_DIRECTORY_TOKEN: undefined,
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
      },
      async () => {
        const { listMembers } = await import("../src/client.js");
        await listMembers({ app_token: "keelson_xyz" });
        expect(server!.calls[0].headers["authorization"]).toBe("Bearer keelson_xyz");
      },
    );
  });

  it("falls back to KEELSON_DIRECTORY_TOKEN when no credential is given", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_DIRECTORY_TOKEN: "keelson_env",
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
      },
      async () => {
        const { listMembers } = await import("../src/client.js");
        await listMembers();
        expect(server!.calls[0].headers["authorization"]).toBe("Bearer keelson_env");
      },
    );
  });

  it("does not use the env token when a cookie is supplied", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_DIRECTORY_TOKEN: "keelson_env",
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
      },
      async () => {
        const { listMembers } = await import("../src/client.js");
        await listMembers({ cookie: "session=abc" });
        // A cookie signals user-as-actor intent — the env token must not leak in.
        expect(server!.calls[0].headers["authorization"]).toBeUndefined();
        expect(server!.calls[0].headers["cookie"]).toBe("session=abc");
      },
    );
  });

  it("explicit authorization wins over the env token", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_DIRECTORY_TOKEN: "keelson_env",
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
      },
      async () => {
        const { listMembers } = await import("../src/client.js");
        await listMembers({ authorization: "Bearer jwt-xyz" });
        expect(server!.calls[0].headers["authorization"]).toBe("Bearer jwt-xyz");
      },
    );
  });

  it("rejects passing both authorization and app_token", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: "http://test" }, async () => {
      const { listMembers } = await import("../src/client.js");
      const { IdentityError } = await import("../src/config.js");
      await expect(
        listMembers({ authorization: "Bearer jwt", app_token: "keelson_xyz" }),
      ).rejects.toThrow(IdentityError);
    });
  });

  it("rejects passing both cookie and app_token", async () => {
    await withEnv({ KEELSON_LOCAL_MODE: undefined, KEELSON_IDENTITY_BASE_URL: "http://test" }, async () => {
      const { listMembers } = await import("../src/client.js");
      const { IdentityError } = await import("../src/config.js");
      await expect(
        listMembers({ cookie: "session=abc", app_token: "keelson_xyz" }),
      ).rejects.toThrow("not both");
    });
  });

  it("prefers KEELSON_DIRECTORY_BASE_URL over KEELSON_IDENTITY_BASE_URL", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_DIRECTORY_TOKEN: undefined,
        KEELSON_DIRECTORY_BASE_URL: server.baseUrl,
        KEELSON_IDENTITY_BASE_URL: "http://wrong-identity",
      },
      async () => {
        const { listMembers } = await import("../src/client.js");
        await listMembers();
        expect(server!.calls).toHaveLength(1);
        expect(server!.calls[0].url).toBe("/__keelson/members");
      },
    );
  });

  it("falls back to KEELSON_IDENTITY_BASE_URL when directory base is unset", async () => {
    server = await startMockServer(MEMBERS_PAYLOAD);
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_DIRECTORY_TOKEN: undefined,
        KEELSON_DIRECTORY_BASE_URL: undefined,
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
      },
      async () => {
        const { listMembers } = await import("../src/client.js");
        await listMembers();
        expect(server!.calls).toHaveLength(1);
      },
    );
  });

  it("getUser sends app_token as Bearer Authorization", async () => {
    server = await startMockServer({ id: "u-1", email: "a@b.com", name: "A", role: "OWNER" });
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_DIRECTORY_TOKEN: undefined,
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
      },
      async () => {
        const { getUser } = await import("../src/client.js");
        await getUser("u-1", { app_token: "keelson_xyz" });
        expect(server!.calls[0].headers["authorization"]).toBe("Bearer keelson_xyz");
      },
    );
  });

  it("listGroups sends app_token as Bearer Authorization", async () => {
    server = await startMockServer({ items: [] });
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_DIRECTORY_TOKEN: undefined,
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
      },
      async () => {
        const { listGroups } = await import("../src/client.js");
        await listGroups({ app_token: "keelson_xyz" });
        expect(server!.calls[0].headers["authorization"]).toBe("Bearer keelson_xyz");
      },
    );
  });
});
