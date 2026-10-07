/**
 * Local development mock provider for @keelsonhq/identity.
 *
 * Set KEELSON_LOCAL_MODE=1 to enable. All SDK functions return
 * deterministic fixture data instead of making HTTP calls.
 *
 * With a local users file (KEELSON_LOCAL_USERS_FILE, or ./.keelson/dev-users.json
 * when present) the members, groups, and fixed current user come from that
 * roster. Without one, the built-in fixture data below is used, customised via:
 *   KEELSON_LOCAL_USER_ID      (default: "local-user-001")
 *   KEELSON_LOCAL_USER_EMAIL   (default: "dev@localhost")
 *   KEELSON_LOCAL_USER_NAME    (default: "Local Developer")
 *   KEELSON_LOCAL_WORKSPACE_ROLE (tenant alias also accepted; default: "OWNER")
 * In both cases:
 *   KEELSON_LOCAL_WORKSPACE_ID   (tenant alias also accepted; default: "local-tenant-001")
 *   KEELSON_LOCAL_APP_ID       (default: "local-app-001")
 *
 * The canonical contract is docs/specs/local-dev-spec.md in the Keelson monorepo.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IdentityError } from "./config.js";
import type {
  CurrentIdentity,
  GroupItem,
  MemberItem,
  PaginatedMembers,
  RequestUser,
  UserIdentity,
} from "./types.js";

function env(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function localUserId(): string {
  return env("KEELSON_LOCAL_USER_ID", "local-user-001");
}
function localUserEmail(): string {
  return env("KEELSON_LOCAL_USER_EMAIL", "dev@localhost");
}
function localUserName(): string {
  return env("KEELSON_LOCAL_USER_NAME", "Local Developer");
}
function localTenantId(): string {
  return env(
    "KEELSON_LOCAL_WORKSPACE_ID",
    env("KEELSON_LOCAL_TENANT_ID", "local-tenant-001"),
  );
}
function localTenantRole(): string {
  return env(
    "KEELSON_LOCAL_WORKSPACE_ROLE",
    env("KEELSON_LOCAL_TENANT_ROLE", "OWNER"),
  );
}
function localAppId(): string {
  return env("KEELSON_LOCAL_APP_ID", "local-app-001");
}

// -- Local users file (roster) --

const DEFAULT_USERS_FILE = ".keelson/dev-users.json";

interface RosterUser {
  id: string;
  email: string;
  name: string;
  /** Normalized: ["view"] or ["view", "manage"]. */
  perms: string[];
  image_url: string | null;
}

const ROSTER_GROUPS: GroupItem[] = [
  { id: "local-group-admins", key: "admins", display_name: "Admins", kind: "SYSTEM", system_kind: "admins" },
  { id: "local-group-everyone", key: "everyone", display_name: "Everyone", kind: "SYSTEM", system_kind: "everyone" },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRosterUser(raw: unknown, index: number, seen: Set<string>): RosterUser {
  const at = `users[${index}]`;
  if (!isObject(raw)) throw new Error(`${at} must be an object`);
  const { id, email, name, perms, image_url } = raw;
  if (typeof id !== "string" || !id.trim()) throw new Error(`${at}.id must be a non-empty string`);
  if (seen.has(id)) throw new Error(`${at}.id '${id}' is duplicated`);
  seen.add(id);
  if (typeof email !== "string") throw new Error(`${at}.email must be a string`);
  if (typeof name !== "string") throw new Error(`${at}.name must be a string`);
  if (
    !Array.isArray(perms) ||
    !perms.includes("view") ||
    perms.some((p) => p !== "view" && p !== "manage") ||
    new Set(perms).size !== perms.length
  ) {
    throw new Error(`${at}.perms must be ["view"] or ["view", "manage"]`);
  }
  if (image_url != null && typeof image_url !== "string") {
    throw new Error(`${at}.image_url must be a string or null`);
  }
  return {
    id,
    email,
    name,
    perms: perms.includes("manage") ? ["view", "manage"] : ["view"],
    image_url: image_url ?? null,
  };
}

function parseRoster(text: string): RosterUser[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  if (!isObject(data) || !Array.isArray(data.users) || data.users.length === 0) {
    throw new Error("expected an object with a non-empty 'users' array");
  }
  const seen = new Set<string>();
  return data.users.map((raw, i) => parseRosterUser(raw, i, seen));
}

/**
 * Read the local users file, or return null when none is configured.
 * An explicit KEELSON_LOCAL_USERS_FILE must exist; the default path is used
 * only when present. A file that is present but malformed is an error.
 */
function loadRoster(): RosterUser[] | null {
  const explicit = process.env.KEELSON_LOCAL_USERS_FILE?.trim();
  const path = resolve(explicit || DEFAULT_USERS_FILE);
  if (!explicit && !existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new IdentityError(`Cannot read local users file ${path}: ${(err as Error).message}`);
  }
  try {
    return parseRoster(text);
  } catch (err) {
    throw new IdentityError(`Invalid local users file ${path}: ${(err as Error).message}`);
  }
}

/** The first user with manage, else the first user (local-dev-spec §6.4). */
function fixedUser(roster: RosterUser[]): RosterUser {
  return roster.find((u) => u.perms.includes("manage")) ?? roster[0];
}

function rosterRole(user: RosterUser): string {
  return user.perms.includes("manage") ? "ADMIN" : "APP_USER";
}

function rosterMember(user: RosterUser): MemberItem {
  return { id: user.id, email: user.email, name: user.name, role: rosterRole(user), image_url: user.image_url };
}

function blankToNull(value: string): string | null {
  return value.trim() ? value : null;
}

// -- Built-in companion members (no roster) --

interface FixtureMember {
  id: string;
  email: string;
  name: string;
  role: string;
}

const COMPANION_MEMBERS: FixtureMember[] = [
  { id: "local-user-002", email: "alice@localhost", name: "Alice (local)", role: "ADMIN" },
  { id: "local-user-003", email: "bob@localhost", name: "Bob (local)", role: "BUILDER" },
  { id: "local-user-004", email: "carol@localhost", name: "Carol (local)", role: "APP_USER" },
];

const FIXTURE_GROUPS: GroupItem[] = [
  { id: "local-group-everyone", key: "everyone", display_name: "Everyone", kind: "SYSTEM", system_kind: "everyone" },
  { id: "local-group-developers", key: "developers", display_name: "Developers", kind: "SYSTEM", system_kind: "developers" },
  { id: "local-group-admins", key: "admins", display_name: "Admins", kind: "SYSTEM", system_kind: "admins" },
  { id: "local-group-owners", key: "owners", display_name: "Owners", kind: "SYSTEM", system_kind: "owners" },
];

const ROLE_GROUP_MAP: Record<string, string[]> = {
  OWNER: ["everyone", "developers", "admins", "owners"],
  ADMIN: ["everyone", "developers", "admins"],
  BUILDER: ["everyone", "developers"],
  APP_USER: ["everyone"],
};

const GROUP_ROLE_MAP: Record<string, string[]> = {
  everyone: ["OWNER", "ADMIN", "BUILDER", "APP_USER"],
  developers: ["OWNER", "ADMIN", "BUILDER"],
  admins: ["OWNER", "ADMIN"],
  owners: ["OWNER"],
};

function buildMembers(): FixtureMember[] {
  const envUser: FixtureMember = {
    id: localUserId(),
    email: localUserEmail(),
    name: localUserName(),
    role: localTenantRole(),
  };
  const envId = envUser.id;
  return [envUser, ...COMPANION_MEMBERS.filter((m) => m.id !== envId)];
}

function fixtureMember(m: FixtureMember): MemberItem {
  return { id: m.id, email: m.email, name: m.name, role: m.role, image_url: null };
}

// -- Public local-mode functions --

export function localGetCurrentUser(): UserIdentity {
  const roster = loadRoster();
  if (roster) {
    const user = fixedUser(roster);
    return { id: user.id, email: blankToNull(user.email), name: blankToNull(user.name) };
  }
  return { id: localUserId(), email: localUserEmail(), name: localUserName() };
}

export function localGetRequestUser(): RequestUser {
  const roster = loadRoster();
  if (roster) {
    const user = fixedUser(roster);
    return {
      id: user.id,
      email: blankToNull(user.email),
      name: blankToNull(user.name),
      perms: [...user.perms],
    };
  }
  return { id: localUserId(), email: localUserEmail(), name: localUserName(), perms: ["view", "manage"] };
}

export function localGetCurrentIdentity(): CurrentIdentity {
  const roster = loadRoster();
  if (roster) {
    const user = fixedUser(roster);
    const manage = user.perms.includes("manage");
    const workspace = { id: localTenantId(), role: rosterRole(user) };
    return {
      user: { id: user.id, email: user.email, name: user.name },
      workspace,
      tenant: workspace,
      app: { id: localAppId(), permissions: [...user.perms].sort(), roles: [] },
      attributes: { groups: manage ? ["admins", "everyone"] : ["everyone"] },
    };
  }
  const role = localTenantRole();
  const groups = ROLE_GROUP_MAP[role] ?? ["everyone"];
  const workspace = { id: localTenantId(), role };
  return {
    user: { id: localUserId(), email: localUserEmail(), name: localUserName() },
    workspace,
    tenant: workspace,
    app: { id: localAppId(), permissions: ["manage", "view"], roles: [] },
    attributes: { groups },
  };
}

export function localListMembers(options: {
  limit?: number;
  offset?: number;
  q?: string;
  role?: string;
  group_key?: string;
  group_id?: string;
}): PaginatedMembers {
  const effectiveLimit = options.limit ?? 25;
  const effectiveOffset = options.offset ?? 0;

  const roster = loadRoster();
  const groups = roster ? ROSTER_GROUPS : FIXTURE_GROUPS;
  const inGroup = roster
    ? (m: MemberItem, key: string) => key === "everyone" || (key === "admins" && m.role === "ADMIN")
    : (m: MemberItem, key: string) => (GROUP_ROLE_MAP[key] ?? []).includes(m.role ?? "");
  let filtered: MemberItem[] = roster ? roster.map(rosterMember) : buildMembers().map(fixtureMember);

  if (options.q) {
    const qLower = options.q.toLowerCase();
    filtered = filtered.filter(
      (m) => m.name.toLowerCase().includes(qLower) || m.email.toLowerCase().includes(qLower),
    );
  }
  if (options.role) {
    filtered = filtered.filter((m) => m.role === options.role);
  }
  // Resolve group_id to its key; an unknown id matches no group. The caller
  // (listMembers) rejects group_id + group_key together, so at most one is set.
  let groupKey = options.group_key;
  if (options.group_id) {
    groupKey = groups.find((g) => g.id === options.group_id)?.key ?? undefined;
    if (!groupKey) filtered = [];
  }
  if (groupKey) {
    const key = groupKey;
    filtered = filtered.filter((m) => inGroup(m, key));
  }

  const items = filtered.slice(effectiveOffset, effectiveOffset + effectiveLimit);
  const hasNext = filtered.length > effectiveOffset + effectiveLimit;
  return {
    items,
    limit: effectiveLimit,
    offset: effectiveOffset,
    next_offset: hasNext ? effectiveOffset + effectiveLimit : null,
  };
}

export function localGetUser(userId: string): MemberItem {
  const roster = loadRoster();
  const members = roster ? roster.map(rosterMember) : buildMembers().map(fixtureMember);
  const found = members.find((m) => m.id === userId);
  if (found) return found;
  throw new IdentityError(`Identity API returned 404 (not found). user_id=${userId}`);
}

export function localListGroups(): GroupItem[] {
  return [...(loadRoster() ? ROSTER_GROUPS : FIXTURE_GROUPS)];
}
