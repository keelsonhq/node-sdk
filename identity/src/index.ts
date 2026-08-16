/**
 * Keelson Identity SDK for Node.js.
 *
 * `getCurrentUser` reads the trusted `X-Keelson-User-*` headers from the
 * incoming request and returns `{ id, email, name }` without a network call.
 * Use `getCurrentIdentity` when the app needs role, permission, app-role, or
 * group information; it calls the app-as-actor Directory identity endpoint.
 *
 * The Directory functions (`listMembers`, `getUser`, `listGroups`) run either
 * as the user (forward ``cookie`` / ``host``) or as the app itself, by passing
 * an ``app_token`` — or relying on the ``KEELSON_DIRECTORY_TOKEN`` env var.
 *
 * @example
 * ```ts
 * import { getCurrentUser, getCurrentIdentity, listMembers, getUser, listGroups } from "@keelsonhq/identity";
 *
 * // In your HTTP handler, pass the incoming request headers:
 * const me = await getCurrentUser({ headers: req.headers });
 * console.log(me.id, me.email);
 *
 * const identity = await getCurrentIdentity({
 *   headers: req.headers,
 *   app_token: process.env.KEELSON_DIRECTORY_TOKEN,
 * });
 * console.log(identity.tenant.role, identity.app.permissions);
 *
 * const directory = { app_token: process.env.KEELSON_DIRECTORY_TOKEN };
 * const members = await listMembers({ ...directory, q: "alice" });
 * for (const m of members.items) {
 *   console.log(m.name, m.email, m.role);
 * }
 *
 * const user = await getUser("user-id-here", directory);
 * const groups = await listGroups(directory);
 *
 * // App-as-actor: no user request to forward (cron, worker, bulk jobs):
 * const allMembers = await listMembers({ app_token: process.env.KEELSON_DIRECTORY_TOKEN });
 * ```
 *
 * Keelson supplies ``KEELSON_DIRECTORY_BASE_URL`` as the default base URL; you
 * may also pass ``base_url`` explicitly. ``KEELSON_IDENTITY_BASE_URL`` remains
 * available only as a deprecated compatibility fallback.
 *
 * Set ``KEELSON_LOCAL_MODE=1`` for local development with fixture data
 * without network calls or request headers.
 */

export { IdentityError } from "./config.js";
export {
  getCurrentIdentity,
  getCurrentUser,
  listMembers,
  getUser,
  listGroups
} from "./client.js";
export type {
  AppIdentity,
  AttributesIdentity,
  CurrentIdentity,
  GroupItem,
  HeaderBag,
  HeadersLike,
  ListMembersOptions,
  MemberItem,
  PaginatedMembers,
  RequestOptions,
  TenantIdentity,
  UserIdentity
} from "./types.js";
