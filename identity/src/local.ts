/**
 * Local development mock provider for @keelsonhq/identity.
 *
 * Set KEELSON_LOCAL_MODE=1 to enable. All SDK functions return
 * deterministic fixture data instead of making HTTP calls.
 *
 * Customise via environment variables:
 *   KEELSON_LOCAL_USER_ID      (default: "local-user-001")
 *   KEELSON_LOCAL_USER_EMAIL   (default: "dev@localhost")
 *   KEELSON_LOCAL_USER_NAME    (default: "Local Developer")
 *   KEELSON_LOCAL_TENANT_ID    (default: "local-tenant-001")
 *   KEELSON_LOCAL_TENANT_ROLE  (default: "OWNER")
 *   KEELSON_LOCAL_APP_ID       (default: "local-app-001")
 */

import { IdentityError } from "./config.js";
import type {
  CurrentIdentity,
  GroupItem,
  MemberItem,
  PaginatedMembers,
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
  return env("KEELSON_LOCAL_TENANT_ID", "local-tenant-001");
}
function localTenantRole(): string {
  return env("KEELSON_LOCAL_TENANT_ROLE", "OWNER");
}
function localAppId(): string {
  return env("KEELSON_LOCAL_APP_ID", "local-app-001");
}

// -- Built-in companion members --

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

export function localGetCurrentUser(): UserIdentity {
  return { id: localUserId(), email: localUserEmail(), name: localUserName() };
}

export function localGetCurrentIdentity(): CurrentIdentity {
  const role = localTenantRole();
  const groups = ROLE_GROUP_MAP[role] ?? ["everyone"];
  return {
    user: { id: localUserId(), email: localUserEmail(), name: localUserName() },
    tenant: { id: localTenantId(), role },
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

  let filtered = buildMembers();
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
  let groupUnmatched = false;
  if (options.group_id) {
    const found = FIXTURE_GROUPS.find((g) => g.id === options.group_id);
    if (found?.key) {
      groupKey = found.key;
    } else {
      groupUnmatched = true;
    }
  }
  if (groupUnmatched) {
    filtered = [];
  } else if (groupKey) {
    const qualifyingRoles = GROUP_ROLE_MAP[groupKey];
    if (qualifyingRoles) {
      filtered = filtered.filter((m) => qualifyingRoles.includes(m.role));
    } else {
      filtered = [];
    }
  }

  const page = filtered.slice(effectiveOffset, effectiveOffset + effectiveLimit);
  const hasNext = filtered.length > effectiveOffset + effectiveLimit;
  const items: MemberItem[] = page.map((m) => ({
    id: m.id,
    email: m.email,
    name: m.name,
    role: m.role,
  }));
  return {
    items,
    limit: effectiveLimit,
    offset: effectiveOffset,
    next_offset: hasNext ? effectiveOffset + effectiveLimit : null,
  };
}

export function localGetUser(userId: string): MemberItem {
  for (const m of buildMembers()) {
    if (m.id === userId) {
      return { id: m.id, email: m.email, name: m.name, role: m.role };
    }
  }
  throw new IdentityError(`Identity API returned 404 (not found). user_id=${userId}`);
}

export function localListGroups(): GroupItem[] {
  return [...FIXTURE_GROUPS];
}
