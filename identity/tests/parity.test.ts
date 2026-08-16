/**
 * Cross-language parity tests for Identity / Directory.
 *
 * These tests load the shared fixtures from fixtures/parity/ at the repository
 * root (or from KEELSON_SDK_FIXTURES_DIR) and
 * assert the same semantic field values that Go and Python parity tests assert.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { resolveParityFixturesDir } from "../../test-fixtures.js";
import { getCurrentIdentity, getCurrentUser, listMembers, listGroups } from "../src/index.js";
import { startMockServer, withEnv } from "./helpers.js";
import type { MockServer } from "./helpers.js";

const FIXTURES = resolveParityFixturesDir(import.meta.url);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf-8"));
}

describe("parity: identity current user", () => {
  let server: MockServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("parses shared fixture with same field values as Go and Python", async () => {
    const fixture = loadFixture("identity_current_user.json");
    server = await startMockServer(fixture);

    let user: Awaited<ReturnType<typeof getCurrentUser>>;
    let id: Awaited<ReturnType<typeof getCurrentIdentity>>;
    await withEnv(
      {
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
        KEELSON_DIRECTORY_TOKEN: undefined,
        KEELSON_LOCAL_MODE: undefined
      },
      async () => {
        const headers = {
          "x-keelson-user-id": "usr_parity01",
          "x-keelson-user-email": "taro@example.com",
          "x-keelson-user-name": "Taro Yamada"
        };
        user = await getCurrentUser({ headers });
        id = await getCurrentIdentity({ headers, app_token: "keelson_parity" });
      }
    );

    // --- Cross-language parity assertions ---
    expect(user!.id).toBe("usr_parity01");
    expect(user!.email).toBe("taro@example.com");
    expect(user!.name).toBe("Taro Yamada");

    expect(id!.user.id).toBe("usr_parity01");
    expect(id!.user.email).toBe("taro@example.com");
    expect(id!.user.name).toBe("Taro Yamada");

    expect(id!.tenant.id).toBe("tenant_001");
    expect(id!.tenant.role).toBe("admin");

    expect(id!.app.id).toBe("app_xyz");
    expect(id!.app.permissions).toEqual(["manage", "view"]);
    expect(id!.app.roles).toEqual(["editor"]);

    expect(id!.attributes).not.toBeNull();
    // attributes.groups contains every system group the user belongs to plus
    // custom groups bound to this app; unbound custom groups are omitted and
    // the returned keys are sorted.
    expect(id!.attributes!.groups).toEqual(["admins", "everyone", "sales"]);
  });
});

describe("parity: identity members", () => {
  let server: MockServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("parses shared fixture with same field values as Go and Python", async () => {
    const fixture = loadFixture("identity_members.json");
    server = await startMockServer(fixture);

    let result: Awaited<ReturnType<typeof listMembers>>;
    await withEnv(
      {
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
        KEELSON_LOCAL_MODE: undefined
      },
      async () => {
        result = await listMembers();
      }
    );

    // --- Cross-language parity assertions ---
    expect(result!.limit).toBe(25);
    expect(result!.offset).toBe(0);
    expect(result!.next_offset).toBeNull();
    expect(result!.items).toHaveLength(2);

    expect(result!.items[0].id).toBe("usr_m01");
    expect(result!.items[0].email).toBe("alice@example.com");
    expect(result!.items[0].name).toBe("Alice");
    expect(result!.items[0].role).toBe("admin");

    expect(result!.items[1].id).toBe("usr_m02");
    expect(result!.items[1].email).toBe("bob@example.com");
  });
});

describe("parity: identity groups", () => {
  let server: MockServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("parses shared fixture with same field values as Go and Python", async () => {
    const fixture = loadFixture("identity_groups.json");
    server = await startMockServer(fixture);

    let groups: Awaited<ReturnType<typeof listGroups>>;
    await withEnv(
      {
        KEELSON_IDENTITY_BASE_URL: server.baseUrl,
        KEELSON_LOCAL_MODE: undefined
      },
      async () => {
        groups = await listGroups();
      }
    );

    // --- Cross-language parity assertions ---
    expect(groups!).toHaveLength(3);

    expect(groups![0].id).toBe("grp_admins01");
    expect(groups![0].key).toBe("admins");
    expect(groups![0].display_name).toBe("Administrators");
    expect(groups![0].kind).toBe("system");
    expect(groups![0].system_kind).toBe("admin");

    expect(groups![1].key).toBe("editors");
    expect(groups![1].display_name).toBe("Editors");
    expect(groups![1].kind).toBe("custom");
    expect(groups![1].system_kind).toBeNull();

    // A keyless group carries a stable id but key is null.
    expect(groups![2].id).toBe("grp_keyless01");
    expect(groups![2].key).toBeNull();
  });
});
