import type { IncomingHttpHeaders } from "node:http";

/**
 * Keelson Identity SDK type definitions.
 *
 * Mirrors the User-Context API response schemas served by the Keelson auth
 * gateway.
 */

export interface UserIdentity {
  id: string;
  email: string | null;
  name: string | null;
}

export interface TenantIdentity {
  id: string;
  role: string;
}

export interface AppIdentity {
  id: string;
  permissions: string[] | null;
  roles: string[] | null;
}

export interface AttributesIdentity {
  groups: string[] | null;
}

export interface CurrentIdentity {
  user: UserIdentity;
  tenant: TenantIdentity;
  app: AppIdentity;
  attributes: AttributesIdentity | null;
}

export interface MemberItem {
  id: string;
  email: string;
  name: string;
  role: string | null;
}

export interface PaginatedMembers {
  items: MemberItem[];
  limit: number;
  offset: number;
  next_offset: number | null;
}

export interface GroupItem {
  /** Stable UUID for machine integration / internal wiring. */
  id: string;
  /**
   * Code-facing identifier for referencing a group: always present (the
   * server guarantees a non-null, normalized key), stable, and immutable —
   * prefer this for code references. Typed nullable for backward
   * compatibility, but groups returned by the Directory API always carry a
   * key.
   */
  key: string | null;
  display_name: string;
  kind: string;
  system_kind: string | null;
}

export interface HeadersLike {
  get(name: string): string | null;
}

export type HeaderBag =
  | HeadersLike
  | IncomingHttpHeaders
  | Record<string, string | string[] | undefined>;

/** Options shared by all SDK functions for explicit header injection. */
export interface RequestOptions {
  base_url?: string;
  /**
   * Incoming request headers. `getCurrentUser` reads the trusted
   * X-Keelson-User-* headers from this bag without making a network call.
   */
  headers?: HeaderBag;
  cookie?: string;
  authorization?: string;
  /**
   * App token for app-as-actor Directory access. Sent as
   * `Authorization: Bearer <app_token>`. Honored by `listMembers`,
   * `getUser`, and `listGroups`; cannot be combined with `authorization`
   * or `cookie`.
   */
  app_token?: string;
  host?: string;
  timeout_ms?: number;
}

export interface ListMembersOptions extends RequestOptions {
  limit?: number;
  offset?: number;
  q?: string;
  role?: string;
  /**
   * Narrow members to a single group by its key. Prefer this for code
   * references: every group has a key, and keys are stable and immutable.
   * Cannot be combined with `group_id`.
   */
  group_key?: string;
  /**
   * Narrow members to a single group by its stable UUID (machine integration
   * / internal use). Cannot be combined with `group_key`.
   */
  group_id?: string;
}
