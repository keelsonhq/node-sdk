/**
 * Cross-language parity tests for the identity local-mode contract
 * (docs/specs/local-dev-spec.md): the production-mark guard, getRequestUser,
 * and the local users file (roster).
 *
 * Loads the shared fixtures identity_local_mode_guard.json,
 * identity_request_user.json, and identity_local_roster.json.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveParityFixturesDir } from "../../test-fixtures.js";
import {
  IdentityError,
  getCurrentIdentity,
  getCurrentUser,
  getRequestUser,
  getUser,
  listGroups,
  listMembers,
} from "../src/index.js";
import type { ListMembersOptions } from "../src/index.js";
import { withEnv } from "./helpers.js";

const FIXTURES = resolveParityFixturesDir(import.meta.url);

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf-8"));
}

const guard = loadFixture("identity_local_mode_guard.json");
const requestUser = loadFixture("identity_request_user.json");
const roster = loadFixture("identity_local_roster.json");

const tmp = mkdtempSync(join(tmpdir(), "keelson-identity-local-"));
let fileSeq = 0;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a roster (JSON value or raw text) to a fresh file and return its path. */
function writeRoster(content: unknown): string {
  const path = join(tmp, `users-${fileSeq++}.json`);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

/** Run fn with every fixture env var cleared, then `env` applied. */
async function inEnv(
  envVars: string[],
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const vars: Record<string, string | undefined> = {};
  for (const name of envVars) vars[name] = undefined;
  await withEnv({ ...vars, ...env }, fn);
}

async function inRoster(
  users: unknown,
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  await inEnv(
    roster.env_vars,
    { KEELSON_LOCAL_MODE: "1", ...env, KEELSON_LOCAL_USERS_FILE: writeRoster(users) },
    fn,
  );
}

function pickIdentityFields(identity: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of roster.identity_compared_fields) picked[field] = identity[field];
  return picked;
}

const LOCAL_FUNCTIONS: Record<string, () => Promise<unknown>> = {
  getCurrentUser: () => getCurrentUser(),
  getCurrentIdentity: () => getCurrentIdentity(),
  listMembers: () => listMembers(),
  getUser: () => getUser("local-user-001"),
  listGroups: () => listGroups(),
  getRequestUser: () => getRequestUser(),
};

describe("parity: identity local-mode guard", () => {
  const headers = { "x-keelson-user-id": "header-user" };

  for (const c of guard.cases) {
    it(c.name, async () => {
      await inEnv(guard.env_vars, c.env, async () => {
        if (c.expected.sdk === "local") {
          expect((await getRequestUser({ headers })).id).toBe("local-user-001");
          return;
        }
        if (c.expected.sdk === "not_local") {
          expect((await getRequestUser({ headers })).id).toBe("header-user");
          return;
        }
        for (const [fn, call] of Object.entries(LOCAL_FUNCTIONS)) {
          const err = await call().then(
            () => null,
            (e: unknown) => e,
          );
          expect(err, fn).toBeInstanceOf(IdentityError);
          const message = (err as Error).message;
          for (const text of guard.message_must_contain) expect(message).toContain(text);
          // Marks are listed in the canonical order, and no mark values leak.
          const positions = c.expected.marks.map((m: string) => message.indexOf(m));
          expect(positions.every((p: number) => p >= 0)).toBe(true);
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
          for (const [name, value] of Object.entries(c.env as Record<string, string>)) {
            if (name !== "KEELSON_LOCAL_MODE" && name !== "KEELSON_MODE") {
              expect(message).not.toContain(value);
            }
          }
        }
      });
    });
  }
});

describe("parity: getRequestUser", () => {
  for (const c of requestUser.header_cases) {
    it(`headers: ${c.name}`, async () => {
      await inEnv(requestUser.env_vars, {}, async () => {
        if (c.error === "missing_user_id") {
          await expect(getRequestUser({ headers: c.headers })).rejects.toThrow(
            new IdentityError("Current user headers are missing 'x-keelson-user-id'."),
          );
          return;
        }
        expect(await getRequestUser({ headers: c.headers })).toEqual(c.expected);
      });
    });
  }

  for (const c of requestUser.local_cases) {
    it(`local: ${c.name}`, async () => {
      const env = { ...c.env };
      if (c.users_file) env.KEELSON_LOCAL_USERS_FILE = writeRoster(c.users_file);
      await inEnv(requestUser.env_vars, env, async () => {
        expect(await getRequestUser({ headers: c.headers })).toEqual(c.expected);
      });
    });
  }

  it("decodes a latin-1 value before trimming (trailing 0xA0 byte)", async () => {
    // "タム" ends with the UTF-8 byte 0xA0, which String#trim treats as NBSP.
    const latin1 = Buffer.from("タム", "utf-8").toString("latin1");
    await inEnv(requestUser.env_vars, {}, async () => {
      const user = await getRequestUser({
        headers: { "x-keelson-user-id": "u", "x-keelson-user-name": latin1 },
      });
      expect(user.name).toBe("タム");
    });
  });

  it("does not change getCurrentUser (no latin-1 recovery)", async () => {
    const latin1 = Buffer.from("田中", "utf-8").toString("latin1");
    await inEnv(requestUser.env_vars, {}, async () => {
      const user = await getCurrentUser({
        headers: { "x-keelson-user-id": "u", "x-keelson-user-name": latin1 },
      });
      expect(user.name).toBe(latin1);
    });
  });
});

describe("parity: identity local roster", () => {
  it("current user, request user, identity, and groups", async () => {
    await inRoster(roster.roster, {}, async () => {
      expect(await getCurrentUser()).toEqual(roster.current_user);
      expect(await getRequestUser()).toEqual(roster.request_user);
      const identity = await getCurrentIdentity();
      expect(pickIdentityFields(identity as unknown as Record<string, unknown>)).toEqual(
        pickIdentityFields(roster.identities[roster.fixed_user_id]),
      );
      expect(await listGroups()).toEqual(roster.groups.items);
    });
  });

  for (const [userId, expected] of Object.entries(roster.identities)) {
    it(`identity of ${userId}`, async () => {
      const only = roster.roster.users.filter((u: { id: string }) => u.id === userId);
      await inRoster({ users: only }, {}, async () => {
        const identity = await getCurrentIdentity();
        expect(pickIdentityFields(identity as unknown as Record<string, unknown>)).toEqual(
          pickIdentityFields(expected as Record<string, unknown>),
        );
      });
    });
  }

  for (const c of roster.list_members) {
    it(`listMembers: ${c.name}`, async () => {
      await inRoster(roster.roster, {}, async () => {
        const call = listMembers(c.query as ListMembersOptions);
        if (c.error) {
          await expect(call).rejects.toBeInstanceOf(IdentityError);
          return;
        }
        expect(await call).toEqual(c.response);
      });
    });
  }

  for (const c of roster.get_user) {
    it(`getUser: ${c.user_id}`, async () => {
      await inRoster(roster.roster, {}, async () => {
        const call = getUser(c.user_id);
        if (c.error) {
          await expect(call).rejects.toBeInstanceOf(IdentityError);
          return;
        }
        expect(await call).toEqual(c.response);
      });
    });
  }

  for (const c of roster.fixed_user_cases) {
    it(`fixed user: ${c.name}`, async () => {
      await inRoster(c.roster, {}, async () => {
        expect((await getCurrentUser()).id).toBe(c.expected_user_id);
      });
    });
  }

  for (const c of roster.workspace_id_cases) {
    it(`workspace id: ${c.name}`, async () => {
      await inRoster(roster.roster, c.env, async () => {
        expect((await getCurrentIdentity()).workspace.id).toBe(c.expected_workspace_id);
      });
    });
  }

  it("roster ignores KEELSON_LOCAL_USER_* and KEELSON_LOCAL_WORKSPACE_ROLE", async () => {
    const env = {
      KEELSON_LOCAL_USER_ID: "dev-9",
      KEELSON_LOCAL_USER_EMAIL: "nine@localhost",
      KEELSON_LOCAL_USER_NAME: "Nine",
      KEELSON_LOCAL_WORKSPACE_ROLE: "OWNER",
    };
    await inRoster(roster.roster, env, async () => {
      expect(await getCurrentUser()).toEqual(roster.current_user);
      expect((await getCurrentIdentity()).workspace.role).toBe("ADMIN");
    });
  });

  for (const c of roster.invalid_rosters) {
    it(`invalid roster: ${c.reason}`, async () => {
      await inRoster(c.text ?? c.roster, {}, async () => {
        for (const [fn, call] of Object.entries(LOCAL_FUNCTIONS)) {
          await expect(call(), fn).rejects.toBeInstanceOf(IdentityError);
        }
      });
    });
  }

  it("explicit users file that does not exist is an error", async () => {
    await inEnv(
      roster.env_vars,
      { KEELSON_LOCAL_MODE: "1", KEELSON_LOCAL_USERS_FILE: join(tmp, "missing.json") },
      async () => {
        await expect(getCurrentUser()).rejects.toBeInstanceOf(IdentityError);
      },
    );
  });

  it("reads ./.keelson/dev-users.json when present", async () => {
    const dir = mkdtempSync(join(tmp, "cwd-"));
    mkdirSync(join(dir, ".keelson"));
    writeFileSync(join(dir, ".keelson", "dev-users.json"), JSON.stringify(roster.roster));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await inEnv(roster.env_vars, { KEELSON_LOCAL_MODE: "1" }, async () => {
        expect(await getRequestUser()).toEqual(roster.request_user);
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it("built-in members without a roster match builtin_roster", async () => {
    await inEnv(roster.env_vars, { KEELSON_LOCAL_MODE: "1" }, async () => {
      const page = await listMembers();
      expect(page.items.map(({ id, email, name }) => ({ id, email, name }))).toEqual(
        roster.builtin_roster.users.map(({ id, email, name }: Record<string, string>) => ({
          id,
          email,
          name,
        })),
      );
      expect((await getRequestUser()).id).toBe(roster.builtin_default_user_id);
    });
  });
});
