/**
 * Identity HTTP client for the User-Context API served by the Keelson auth
 * gateway.
 *
 * Uses Node's built-in http/https modules instead of fetch because
 * fetch (undici) silently drops user-supplied Host headers per the
 * Fetch specification. The Keelson auth gateway resolves the app from the
 * request Host header, so the caller-provided host must reach the wire. Node's http.request
 * allows this (same as Python's urllib used by keelson_identity).
 */

import http from "node:http";
import https from "node:https";
import { IdentityError, getDirectoryBaseUrl, isLocalMode } from "./config.js";
import {
  localGetCurrentIdentity,
  localGetCurrentUser,
  localGetUser,
  localListGroups,
  localListMembers
} from "./local.js";
import type {
  CurrentIdentity,
  HeaderBag,
  GroupItem,
  ListMembersOptions,
  MemberItem,
  PaginatedMembers,
  RequestOptions,
  UserIdentity
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// App tokens used for app-as-actor Directory access are read from this env
// var when no explicit app_token option is given.
const DIRECTORY_TOKEN_ENV = "KEELSON_DIRECTORY_TOKEN";

function resolveDirectoryBase(baseUrl?: string): string {
  const explicit = baseUrl?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  return getDirectoryBaseUrl();
}

/**
 * Resolve the Authorization header value for a Directory request.
 *
 * An `app_token` (or the `KEELSON_DIRECTORY_TOKEN` fallback when no explicit
 * credential is given) is sent as `Bearer <token>` for app-as-actor access.
 * An explicit `authorization` takes precedence.
 *
 * A provided `cookie` signals user-as-actor intent: the env-token fallback is
 * skipped so a stray `KEELSON_DIRECTORY_TOKEN` cannot silently turn the call
 * into an app-as-actor request. Passing `app_token` together with
 * `authorization` or `cookie` is rejected.
 */
function resolveAuthorization(opts: {
  authorization?: string;
  app_token?: string;
  cookie?: string;
}): string | undefined {
  const { authorization, app_token, cookie } = opts;
  if (authorization != null && app_token != null) {
    throw new IdentityError("Pass either authorization or app_token, not both.");
  }
  if (cookie != null && app_token != null) {
    throw new IdentityError("Pass either cookie or app_token, not both.");
  }
  if (authorization != null) return authorization.trim();
  if (app_token != null) {
    const token = app_token.trim();
    return token ? `Bearer ${token}` : undefined;
  }
  if (cookie != null) return undefined;
  const envToken = process.env[DIRECTORY_TOKEN_ENV]?.trim() ?? "";
  return envToken ? `Bearer ${envToken}` : undefined;
}

/**
 * Build headers for Directory endpoints, resolving the Authorization header
 * from `authorization` / `app_token` / `KEELSON_DIRECTORY_TOKEN`.
 */
function buildDirectoryHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.cookie) headers["Cookie"] = options.cookie.trim();
  const authorization = resolveAuthorization({
    authorization: options.authorization,
    app_token: options.app_token,
    cookie: options.cookie
  });
  if (authorization) headers["Authorization"] = authorization;
  if (options.host) headers["Host"] = options.host.trim();
  return headers;
}

function normalizeHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeHeaderValue(item);
      if (normalized) return normalized;
    }
    return undefined;
  }
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function readHeader(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined;

  const maybeGetter = (headers as { get?: unknown }).get;
  if (typeof maybeGetter === "function") {
    return normalizeHeaderValue(maybeGetter.call(headers, name));
  }

  const bag = headers as Record<string, unknown>;
  const direct = normalizeHeaderValue(bag[name]);
  if (direct) return direct;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(bag)) {
    if (key.toLowerCase() === lowerName) {
      return normalizeHeaderValue(value);
    }
  }
  return undefined;
}

function parseCurrentUserHeaders(headers: HeaderBag | undefined): UserIdentity {
  const id = readHeader(headers, "x-keelson-user-id");
  if (!id) {
    throw new IdentityError("Current user headers are missing 'x-keelson-user-id'.");
  }
  return {
    id,
    email: readHeader(headers, "x-keelson-user-email") ?? null,
    name: readHeader(headers, "x-keelson-user-name") ?? null
  };
}

function buildCurrentIdentityHeaders(options: RequestOptions): Record<string, string> {
  if (options.cookie != null) {
    throw new IdentityError("getCurrentIdentity requires an app token; cookie is not supported.");
  }
  if (options.authorization != null && options.app_token != null) {
    throw new IdentityError("Pass either authorization or app_token, not both.");
  }

  let authorization: string | undefined;
  if (options.authorization != null) {
    const candidate = options.authorization.trim();
    if (!/^Bearer\s+keelson_/i.test(candidate)) {
      throw new IdentityError("getCurrentIdentity requires a Bearer app token authorization.");
    }
    authorization = candidate;
  }

  if (!authorization && options.app_token != null) {
    const token = options.app_token.trim();
    if (token) authorization = `Bearer ${token}`;
  }

  if (!authorization) {
    const envToken = process.env[DIRECTORY_TOKEN_ENV]?.trim() ?? "";
    if (envToken) authorization = `Bearer ${envToken}`;
  }

  if (!authorization) {
    throw new IdentityError(
      "getCurrentIdentity requires app_token, KEELSON_DIRECTORY_TOKEN, or Bearer app-token authorization."
    );
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: authorization
  };
  if (options.host) headers["Host"] = options.host.trim();
  return headers;
}

/**
 * Perform a GET request using Node's http/https modules.
 *
 * Unlike fetch/undici, http.request preserves user-supplied Host headers
 * on the wire, which is required for app resolution by the Keelson auth gateway.
 */
async function doGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<unknown> {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;

  return new Promise<unknown>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers,
        timeout: Math.max(100, timeoutMs)
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;

          if (status === 401) {
            reject(new IdentityError("Identity API returned 401 (unauthenticated)."));
            return;
          }
          if (status === 403) {
            reject(new IdentityError("Identity API returned 403 (not authorized)."));
            return;
          }
          if (status === 404) {
            reject(new IdentityError("Identity API returned 404 (not found)."));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new IdentityError(`GET ${url} failed with ${status}: ${body}`));
            return;
          }

          if (!body) {
            resolve({});
            return;
          }
          try {
            const result: unknown = JSON.parse(body);
            if (typeof result !== "object" || result === null || Array.isArray(result)) {
              reject(new IdentityError("Identity API returned non-object JSON."));
              return;
            }
            resolve(result);
          } catch {
            reject(new IdentityError("Identity API returned invalid JSON."));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new IdentityError(`GET ${url} timed out after ${timeoutMs}ms.`));
    });

    req.on("error", (err) => {
      reject(new IdentityError(`GET ${url} failed: ${err.message}`));
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

function requireString(obj: Record<string, unknown>, path: string): string {
  const val = obj[path];
  const s = String(val ?? "").trim();
  if (!s) throw new IdentityError(`Identity response is missing '${path}'.`);
  return s;
}

function parseIdentity(payload: Record<string, unknown>): CurrentIdentity {
  const userRaw = payload.user;
  const tenantRaw = payload.tenant;
  const appRaw = payload.app;
  if (typeof userRaw !== "object" || !userRaw)
    throw new IdentityError("Identity response is missing 'user'.");
  if (typeof tenantRaw !== "object" || !tenantRaw)
    throw new IdentityError("Identity response is missing 'tenant'.");
  if (typeof appRaw !== "object" || !appRaw)
    throw new IdentityError("Identity response is missing 'app'.");

  const u = userRaw as Record<string, unknown>;
  const t = tenantRaw as Record<string, unknown>;
  const a = appRaw as Record<string, unknown>;

  const userId = requireString(u, "id");
  const tenantId = requireString(t, "id");
  const tenantRole = requireString(t, "role");
  const appId = requireString(a, "id");

  const email = u.email != null ? String(u.email) : null;
  const name = u.name != null ? String(u.name) : null;

  const permissions = Array.isArray(a.permissions) ? a.permissions.map(String) : null;
  const roles = Array.isArray(a.roles) ? a.roles.map(String) : null;

  let attributes: CurrentIdentity["attributes"] = null;
  const attrRaw = payload.attributes;
  if (typeof attrRaw === "object" && attrRaw !== null) {
    const ar = attrRaw as Record<string, unknown>;
    const groups = Array.isArray(ar.groups) ? ar.groups.map(String) : null;
    attributes = { groups };
  }

  return {
    user: { id: userId, email, name },
    tenant: { id: tenantId, role: tenantRole },
    app: { id: appId, permissions, roles },
    attributes
  };
}

function parseMemberItem(raw: unknown): MemberItem {
  if (typeof raw !== "object" || !raw) throw new IdentityError("Member item is not an object.");
  const m = raw as Record<string, unknown>;
  const id = requireString(m, "id");
  if (m.email == null) throw new IdentityError("Member item is missing 'email'.");
  if (m.name == null) throw new IdentityError("Member item is missing 'name'.");
  const role = m.role != null ? String(m.role) : null;
  return { id, email: String(m.email), name: String(m.name), role };
}

function parsePaginatedMembers(payload: Record<string, unknown>): PaginatedMembers {
  const itemsRaw = payload.items;
  if (!Array.isArray(itemsRaw)) throw new IdentityError("Members response is missing 'items'.");
  if (payload.limit == null) throw new IdentityError("Members response is missing 'limit'.");
  if (payload.offset == null) throw new IdentityError("Members response is missing 'offset'.");

  const items = itemsRaw.map(parseMemberItem);
  const limit = Number(payload.limit);
  const offset = Number(payload.offset);
  const nextOffset = payload.next_offset != null ? Number(payload.next_offset) : null;

  if (Number.isNaN(limit) || Number.isNaN(offset)) {
    throw new IdentityError("Members response has invalid pagination fields.");
  }

  return { items, limit, offset, next_offset: nextOffset };
}

function parseGroupItem(raw: unknown): GroupItem {
  if (typeof raw !== "object" || !raw) throw new IdentityError("Group item is not an object.");
  const g = raw as Record<string, unknown>;
  const id = requireString(g, "id");
  if (g.display_name == null) throw new IdentityError("Group item is missing 'display_name'.");
  if (g.kind == null) throw new IdentityError("Group item is missing 'kind'.");
  // key is the group's code-facing identifier and is present on every group
  // the server returns. The null-tolerance here is kept for backward
  // compatibility; the contract is a non-empty validated key or null, so an
  // empty/blank string is a malformed response.
  let key: string | null = null;
  if (g.key != null) {
    key = String(g.key);
    if (key.trim() === "") {
      throw new IdentityError("Group item has an empty 'key' (use null for keyless groups).");
    }
  }
  const systemKind = g.system_kind != null ? String(g.system_kind) : null;
  return {
    id,
    key,
    display_name: String(g.display_name),
    kind: String(g.kind),
    system_kind: systemKind
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Get the current user's basic profile from trusted X-Keelson-User-* headers.
 *
 * In local mode (KEELSON_LOCAL_MODE=1), returns deterministic fixture data.
 */
export async function getCurrentUser(options: RequestOptions = {}): Promise<UserIdentity> {
  if (isLocalMode()) return localGetCurrentUser();

  return parseCurrentUserHeaders(options.headers);
}

/**
 * Get the current user's full identity as the app actor.
 *
 * Reads the subject user id from trusted X-Keelson-User-* headers and calls
 * the Directory identity endpoint using an app token.
 */
export async function getCurrentIdentity(options: RequestOptions = {}): Promise<CurrentIdentity> {
  if (isLocalMode()) return localGetCurrentIdentity();

  const user = parseCurrentUserHeaders(options.headers);
  const headers = buildCurrentIdentityHeaders(options);
  const base = resolveDirectoryBase(options.base_url);
  const payload = await doGet(
    `${base}/__keelson/users/${encodeURIComponent(user.id)}/identity`,
    headers,
    options.timeout_ms ?? DEFAULT_TIMEOUT_MS
  );
  return parseIdentity(payload as Record<string, unknown>);
}

/**
 * List workspace members with optional filtering.
 */
export async function listMembers(options: ListMembersOptions = {}): Promise<PaginatedMembers> {
  if (options.group_id != null && options.group_key != null) {
    // The Directory API rejects naming the same group two ways; fail fast
    // client-side so local mode behaves identically.
    throw new IdentityError("Specify only one of group_id or group_key.");
  }
  if (isLocalMode()) {
    return localListMembers({
      limit: options.limit,
      offset: options.offset,
      q: options.q,
      role: options.role,
      group_key: options.group_key,
      group_id: options.group_id
    });
  }

  const base = resolveDirectoryBase(options.base_url);
  const params = new URLSearchParams();
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.offset != null) params.set("offset", String(options.offset));
  if (options.q != null) params.set("q", options.q);
  if (options.role != null) params.set("role", options.role);
  if (options.group_key != null) params.set("group_key", options.group_key);
  if (options.group_id != null) params.set("group_id", options.group_id);

  const qs = params.toString();
  const url = `${base}/__keelson/members${qs ? `?${qs}` : ""}`;
  const headers = buildDirectoryHeaders(options);
  const payload = await doGet(url, headers, options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  return parsePaginatedMembers(payload as Record<string, unknown>);
}

/**
 * Get a single user by ID.
 */
export async function getUser(userId: string, options: RequestOptions = {}): Promise<MemberItem> {
  if (isLocalMode()) return localGetUser(userId);

  const uid = userId.trim();
  if (!uid) throw new IdentityError("user_id is required.");

  const base = resolveDirectoryBase(options.base_url);
  const headers = buildDirectoryHeaders(options);
  const url = `${base}/__keelson/users/${encodeURIComponent(uid)}`;
  const payload = await doGet(url, headers, options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  return parseMemberItem(payload);
}

/**
 * List workspace groups.
 */
export async function listGroups(options: RequestOptions = {}): Promise<GroupItem[]> {
  if (isLocalMode()) return localListGroups();

  const base = resolveDirectoryBase(options.base_url);
  const headers = buildDirectoryHeaders(options);
  const payload = await doGet(
    `${base}/__keelson/groups`,
    headers,
    options.timeout_ms ?? DEFAULT_TIMEOUT_MS
  );
  const p = payload as Record<string, unknown>;
  const itemsRaw = p.items;
  if (!Array.isArray(itemsRaw)) throw new IdentityError("Groups response is missing 'items'.");
  return itemsRaw.map(parseGroupItem);
}
