# Keelson Node SDK

Node.js SDK for building apps on the [Keelson](https://keelson.dev) platform ([SDK guide](https://keelson.dev/docs/building-apps/sdk/)). Provides four packages:

> **Note**: This repository is a read-only release mirror. Development happens in the private Keelson monorepo; issues are welcome here, but pull requests are not accepted — changes land through the next release.

| Package | npm | Description |
|---------|-----|-------------|
| [Media](./media) | [`@keelsonhq/media`](https://www.npmjs.com/package/@keelsonhq/media) | Media storage (upload, serve by ID) |
| [Files](./files) | [`@keelsonhq/files`](https://www.npmjs.com/package/@keelsonhq/files) | Data files (key-addressed, overwrite, private) |
| [Identity](./identity) | [`@keelsonhq/identity`](https://www.npmjs.com/package/@keelsonhq/identity) | User identity and directory |
| [Tasks](./tasks) | `@keelsonhq/tasks` | Background tasks (enqueue, get) |

Cross-language parity across Node, Python, and Go is defined by
[the cross-SDK parity contract (PARITY.md in this repo)](./PARITY.md). APIs below are labelled as
**guaranteed** (same capability in all 3 languages) or
**Node-specific** (convenience helpers unique to this SDK).

## Installation

```bash
npm install @keelsonhq/media @keelsonhq/files @keelsonhq/identity
```

Install only the packages you need.

---

## Media SDK (`@keelsonhq/media`)

Upload immutable media (images, PDFs, generated assets) and serve it by ID. On
Keelson it uses the managed media storage (internal media API); for local
development it uses the local filesystem. The runtime-mode contract is
**fail-closed**: it never silently writes to ephemeral local storage when platform
Media configuration is missing or incomplete (see Modes below).

```ts
import * as media from "@keelsonhq/media";

// Upload — returns a generated ULID file ID
const fileId = await media.put(Buffer.from("hello"), {
  contentType: "text/plain",
  filename: "hello.txt",
});

// Download
const data = await media.get(fileId);

// Metadata
const info = await media.stat(fileId);
console.log(info.contentType, info.contentLength);

// Public URL path
const path = media.url(fileId); // "/media/01ABC..."

// Check existence
if (await media.exists(fileId)) { /* ... */ }

// Delete
await media.delete(fileId);
```

### Cross-language guaranteed API

| Function | Description |
|----------|-------------|
| `put(data, options?)` | Upload file, returns ULID `file_id` |
| `get(fileId)` | Download file content |
| `delete(fileId)` | Delete file (no-op if not found) |
| `exists(fileId)` | Check if file exists |
| `stat(fileId)` | Get metadata (contentType, contentLength) |
| `url(fileId)` | Generate public URL path |

### Node-specific helpers

| Function | Description |
|----------|-------------|
| `read(fileId)` | Alias for `get` |
| `open(fileId)` | Alias for `get` |

### Modes (fail-closed runtime-mode contract)

| `KEELSON_MODE` | Condition | Behaviour |
|------|-----------|-----------|
| `keelson` | Both Media env set | Remote (the Keelson media service) |
| `keelson` | Media env missing | **`MediaError`** — capability unavailable (covers `files_enabled=false`); never local |
| any | Exactly one of base URL / token set | **`MediaError`** — incomplete remote config |
| `local` | — | Local filesystem (`MEDIA_DIR`, default `./media`) |
| unset | Both Media env set | Remote (backward compatibility) |
| unset | No Media env, platform core env visible (`KEELSON_APP_ID` / `KEELSON_WORKSPACE_ID` / `KEELSON_DEPLOY_ID`) | **`MediaError`** — refuses silent local fallback |
| unset | No Media env, no platform env | Local filesystem (local development) |

The SDK never silently falls back to ephemeral local storage on Keelson: set
`KEELSON_MODE=local` explicitly for local development.

### Environment variables

| Variable | Description |
|----------|-------------|
| `KEELSON_MODE` | `keelson` (remote, fail-closed) / `local` (local FS) / unset (local development). Platform injects `keelson`. |
| `KEELSON_INTERNAL_MEDIA_BASE_URL` | Internal endpoint for the Keelson media service (Keelson mode; required with the token) |
| `KEELSON_APP_MEDIA_TOKEN` | App-scoped media token, validated by the platform (Keelson mode) |
| `KEELSON_MEDIA_URL_PREFIX` | Public URL prefix (default: `/media/`) |
| `MEDIA_DIR` | Local storage directory (default: `./media`); used whenever the SDK resolves to local mode — either explicit `KEELSON_MODE=local`, or zero-config local development (`KEELSON_MODE` unset with no Media env and no platform core env) |

---

## Files (data) SDK (`@keelsonhq/files`)

Durable file storage for your app's own files — state, settings, caches. Reads
and writes are always whole-file, and `write()` is write-through: once it
returns, the data is persisted. There is no background sync and nothing is
stored on ephemeral local disk. Overwriting an existing key is the normal case;
updates to the same key are limited to about once per second. For user-uploaded
or generated media referenced by ID and served over HTTP, use `@keelsonhq/media`;
for data read/written on every request, use the database.

```ts
import * as files from "@keelsonhq/files";

await files.write("seen_urls.json", JSON.stringify(seen));
const raw = await files.read("seen_urls.json");  // Uint8Array | null (null = absent)
const seen = JSON.parse(raw ? new TextDecoder().decode(raw) : "[]");
const keys = await files.list();                 // sorted string[]
await files.delete("seen_urls.json");            // idempotent
```

### Cross-language guaranteed API

| Function | Description |
| --- | --- |
| `write(key, data)` | Overwrite `key` with bytes/string (string stored UTF-8); write-through |
| `read(key)` | Bytes, or `null` when the key is absent (only a 404 is missing) |
| `del(key)` (exported as `delete`) | Idempotent delete |
| `list(prefix?)` | Full, lexicographically-sorted key list; paging absorbed |

Key grammar: `/`-separated relative path, well-formed UTF-8 ≤ 512 bytes total and
≤ 255 bytes per segment, no leading/trailing `/`, no empty / `.` / `..` segments,
no control characters. One-object soft limit 10 MiB. There is no `exists()` —
`read()` returning `null` covers it.

### Environment variables

| Variable | Description |
| --- | --- |
| `KEELSON_MODE` | `keelson` (remote) or `local`; the single mode signal |
| `KEELSON_FILES_BUCKET` / `KEELSON_FILES_PREFIX` | Platform-injected in `keelson` mode (managed object storage) |
| `KEELSON_FILES_DIR` | Local-mode directory (default `./.keelson/files`) |

Fail-closed: `KEELSON_MODE=keelson` requires bucket + prefix + platform identity;
missing config throws `FilesError`. See
[the cross-SDK parity contract (PARITY.md in this repo)](./PARITY.md) for the full contract.

---

## Tasks SDK (`@keelsonhq/tasks`)

Enqueue a run of a command declared under `tasks:` in `keelson.yaml`, and
read its state. On Keelson the platform runs the command once on a separate
instance, passes the payload as one JSON line on stdin, and retries failed
attempts (at-least-once: make the command safe to run twice). The SDK does not
receive tasks; the command is an ordinary program that reads stdin.

```yaml
# keelson.yaml
tasks:
  - name: generate-pdf
    command: python make_pdf.py
    timeout: 300      # seconds; optional
```

```ts
import { enqueue, get, TasksError } from "@keelsonhq/tasks";

const taskId = await enqueue("generate-pdf", { order_id: 1 }, {
  idempotencyKey: "order-1-pdf",
});
const status = await get(taskId);
console.log(status.status, status.claimed_attempts, status.last_failure_code);

try {
  await enqueue("generate-pdf", { order_id: 2 });
} catch (e) {
  if (e instanceof TasksError && e.code === "TASK_NOT_DECLARED") {
    // ...
  }
}
```

### Cross-language guaranteed API

| Function | Description |
| --- | --- |
| `enqueue(name, payload?, { idempotencyKey? })` | Enqueue one run; resolves to the `task_id` (`string`). `payload` is any JSON value (default `null`); `idempotencyKey` is 1–128 printable ASCII characters |
| `get(taskId)` | Resolves to `TaskStatus`: `task_id`, `name`, `status` (`queued` / `running` / `succeeded` / `failed` / `cancelled`), `claimed_attempts`, `last_failure_code` (`string \| null`), `created_at`, `finished_at` (`string \| null`; RFC 3339 strings) |
| `TasksError` | The single error class (`code`, `status`, `message`) |

A repeat with the same idempotency key returns the existing `task_id` instead
of enqueueing again. Payloads are serialized with `JSON.stringify`, which turns
`NaN` into `null` (standard JavaScript behavior). In local mode the CLI runs as
an asynchronous child process, so the event loop keeps serving other requests
while a task runs.

### Errors

Every failure is one `TasksError` with `code`, `status` (the HTTP status, or
`null` when there was no HTTP response), and `message`. Branch on `code`:

| `code` | Meaning |
|--------|---------|
| `TASK_NOT_DECLARED` | The name is not under `tasks:` in the deployed (or local) `keelson.yaml` |
| `TASK_INVALID_REQUEST` | Empty name, malformed idempotency key, or a payload that is not JSON-serializable |
| `TASK_PAYLOAD_TOO_LARGE` | The request body is over 65,536 bytes (checked before sending) |
| `TASK_NOT_FOUND` | `get` of an unknown task ID (local mode: not enqueued in this process) |
| `TASK_BACKLOG_LIMIT_EXCEEDED` / `TASK_MONTHLY_QUOTA_EXCEEDED` | Plan limits; not retried by the SDK |
| `TASKS_UNAVAILABLE` | Intake is closed on the platform. Retrying does not help |
| `TASKS_UNAVAILABLE_TRANSIENT` | A passing outage (502/503/504, connection failure, 15 s timeout), after the SDK's own retries |
| `TASKS_FORBIDDEN` | 403 from Cloud Run. Right after the first deploy that declares `tasks:`, the permission can take a few minutes to propagate |
| `TASKS_UNAUTHORIZED` / `TASKS_IDENTITY_TOKEN_ERROR` | The id token was rejected / could not be fetched from the metadata server |
| `TASKS_SERVER_ERROR` / `TASKS_HTTP_ERROR` / `TASKS_UNEXPECTED_RESPONSE` | Other unexpected responses |
| `TASKS_NOT_CONFIGURED` | Mode resolution failed (below) |
| `TASKS_LOCAL_CLI_NOT_FOUND` / `TASKS_LOCAL_CLI_FAILED` | Local mode: no `keelson` on `PATH` (install: `https://keelson.dev/install.sh`) / the CLI failed (try `keelson upgrade`) |

Retries: only `TASKS_UNAVAILABLE_TRANSIENT` is retried (3 attempts in total,
waiting 0.5 s then 1 s). `get` always retries; enqueue retries **only with an
idempotency key**, because without one a request the server already accepted
would be enqueued twice. The payload never appears in an error message.

### Modes (fail-closed runtime-mode contract)

| Condition | Result |
|-----------|--------|
| `KEELSON_MODE=keelson` + `KEELSON_TASKS_BASE_URL` set | Keelson (runtime API); `KEELSON_APP_ID` is also required |
| `KEELSON_MODE=keelson` + `KEELSON_TASKS_BASE_URL` missing | `TASKS_NOT_CONFIGURED` (declare `tasks:` in `keelson.yaml` and deploy) |
| `KEELSON_MODE=local` | Local (runs the command through the CLI) |
| `KEELSON_MODE` unset + a platform variable (`KEELSON_APP_ID` / `KEELSON_WORKSPACE_ID` / `KEELSON_DEPLOY_ID`) | `TASKS_NOT_CONFIGURED` (never falls back to local on Keelson) |
| `KEELSON_MODE` unset + none of those | Local (zero-config development) |
| Any other `KEELSON_MODE` value | `TASKS_NOT_CONFIGURED` |

### Environment variables

| Variable | Description |
|----------|-------------|
| `KEELSON_MODE` | `keelson` (remote) or `local`; the single mode signal |
| `KEELSON_TASKS_BASE_URL` | Platform-injected runtime API URL when the app declares `tasks:`; also the id-token audience |
| `KEELSON_APP_ID` | Platform-injected app ID; the `/internal/apps/{app_id}/...` path segment |

There is no token variable: the id token comes from the Cloud Run metadata
server on every call.

### Local mode

In local mode, enqueue runs `keelson dev task run <name> --payload - --json`
(the `keelson` CLI on `PATH`) from the app's working directory, so start your
dev server in the directory that has `keelson.yaml`. The command receives the
same stdin document as on Keelson, its output goes to your app's stderr, and
enqueue returns **after the command has finished** — a request handler that
enqueues waits for it. A command that exits non-zero or times out is not an
enqueue error: `get` reports `status` `failed` with `last_failure_code`
`exit_nonzero` or `timed_out`.

Differences from Keelson:

- synchronous: the command runs before enqueue returns, in the same machine
- no retry: one attempt only
- no concurrency, backlog, or monthly-quota limits
- the declared `timeout` applies as written (on Keelson it is capped by your
  plan's limit)
- `get` knows only tasks enqueued in the same process; others are
  `TASK_NOT_FOUND`, and a running task is never visible
- the same name + idempotency key returns the existing task ID without running
  again, but two concurrent calls with the same key both run the command

See [the cross-SDK parity contract (PARITY.md in this repo)](./PARITY.md) for the full contract.

---

## Identity SDK (`@keelsonhq/identity`)

User identity and workspace directory lookup. In production, the Keelson auth
gateway injects trusted `X-Keelson-User-*` headers into requests before they
reach the app.
Use `getCurrentUser` when the basic user profile is enough; use
`getCurrentIdentity` when the app needs workspace role, app permissions, app roles,
or group attributes.

```ts
import {
  getCurrentUser,
  getCurrentIdentity,
  listMembers,
  getUser,
  listGroups,
} from "@keelsonhq/identity";

// In an Express/Fastify/Node HTTP handler:
async function handleRequest(req, res) {
  const user = await getCurrentUser({
    headers: req.headers,
  });
  console.log(user.id, user.email);

  const identity = await getCurrentIdentity({
    headers: req.headers,
    app_token: process.env.KEELSON_DIRECTORY_TOKEN,
  });
  console.log(identity.workspace.role);
  console.log(identity.app.permissions); // ["manage", "view"]

  // List workspace members as the app actor
  const page = await listMembers({
    q: "alice",
    limit: 25,
    app_token: process.env.KEELSON_DIRECTORY_TOKEN,
  });
  for (const m of page.items) {
    console.log(m.name, m.email, m.role);
  }

  // Single user by ID
  const member = await getUser("user-id-here", {
    app_token: process.env.KEELSON_DIRECTORY_TOKEN,
  });

  // List groups
  const groups = await listGroups({
    app_token: process.env.KEELSON_DIRECTORY_TOKEN,
  });
}
```

### Cross-language guaranteed API

| Function | Description |
|----------|-------------|
| `getCurrentUser(options?)` | Parse the current user's basic profile from trusted `X-Keelson-User-*` headers; no network call |
| `getCurrentIdentity(options?)` | Fetch the current user's full identity as the app actor |
| `listMembers(options?)` | List workspace members (paginated, filterable) |
| `getUser(userId, options?)` | Get user by ID |
| `listGroups(options?)` | List workspace groups |

`getCurrentUser` and `getCurrentIdentity` accept `headers`, which may be a
plain object, Node `IncomingHttpHeaders`, or WHATWG `Headers`. The required
header is `x-keelson-user-id`; `x-keelson-user-email` and
`x-keelson-user-name` are optional.

Directory functions accept `RequestOptions`:
`{ base_url?, cookie?, authorization?, app_token?, host?, timeout_ms? }`.

`listMembers` items and `getUser` return a `MemberItem`:
`{ id, email, name, role, image_url }`. `image_url` is the member's profile
image URL served by Clerk (`img.clerk.com`), or `null` when the member has not
uploaded an image (render initials instead). Append `width` / `height` query
parameters to get a resized image. Store only the member `id` in your app's DB
and re-fetch `image_url` on display rather than relying on the URL to change
when the member replaces their image. Local mode returns `image_url: null` for every member.

### Filtering members by group

`listMembers` narrows results to a single group via either `group_id` or
`group_key`:

- `group_key` — the group's code-facing identifier. Always present, stable, and
  immutable. **Prefer this for code references.** Keys may be non-ASCII (e.g. a
  Japanese `経理`).
- `group_id` — a stable UUID for machine integration / internal wiring.

Passing both throws an `IdentityError`. On `GroupItem`, `key` is `string | null`
kept nullable for backward compatibility, but the server always populates it;
`id` is the UUID.

### App-as-actor Directory access

`getCurrentIdentity`, `listMembers`, `getUser`, and `listGroups` can run as the
app itself using a Directory-scoped app token. This is the right mode for
authorization checks, cron runs, and bulk operations where there is no user
request to forward.

```ts
import { getCurrentIdentity, listMembers } from "@keelsonhq/identity";

const identity = await getCurrentIdentity({
  headers: request.headers,
  app_token: process.env.KEELSON_DIRECTORY_TOKEN,
});

// Explicit app token:
const page = await listMembers({ app_token: process.env.KEELSON_DIRECTORY_TOKEN });

// Or omit it — the token is read from KEELSON_DIRECTORY_TOKEN automatically:
const page2 = await listMembers();
```

- `app_token` is sent as `Authorization: Bearer <app_token>`.
- Passing `app_token` together with `authorization` or `cookie` throws — pick
  one actor. When a `cookie` is supplied (user-as-actor), the
  `KEELSON_DIRECTORY_TOKEN` fallback is skipped.
- `getCurrentIdentity` is app-token only. It reads the subject user id from
  trusted headers and rejects explicit `cookie`.
- Directory app tokens must never reach the browser; keep them on the server.

### Current-user and authorization data

`getCurrentUser({ headers })` reads basic user fields directly from trusted
request headers. Use `getCurrentIdentity({ headers, app_token })` when you also
need `workspace.role`, `app.permissions`, `app.roles`, or `attributes.groups`.

The former `TenantIdentity` type, `identity.tenant` property, `tenant` wire key,
`KEELSON_TENANT_ID`, and `KEELSON_LOCAL_TENANT_ID` /
`KEELSON_LOCAL_TENANT_ROLE` remain deprecated aliases through at least the next
major SDK version.

### Modes

| Mode | Condition | Behaviour |
|------|-----------|-----------|
| Local | `KEELSON_LOCAL_MODE=1` | Returns deterministic fixture data without HTTP or request headers |
| Keelson | Default | Calls the Keelson auth gateway via `KEELSON_DIRECTORY_BASE_URL` (canonical, platform-injected). `KEELSON_IDENTITY_BASE_URL` is a **deprecated** fallback only |

### Environment variables

| Variable | Description |
|----------|-------------|
| `KEELSON_LOCAL_MODE` | Set to `1` for fixture data (no HTTP) |
| `KEELSON_LOCAL_WORKSPACE_ID` | Override the local workspace ID |
| `KEELSON_LOCAL_WORKSPACE_ROLE` | Override the local workspace role |
| `KEELSON_DIRECTORY_BASE_URL` | **Canonical, platform-injected** base URL for Identity/Directory calls (`getCurrentIdentity` / `listMembers` / `getUser` / `listGroups`). Use this |
| `KEELSON_DIRECTORY_TOKEN` | App token for app-as-actor Directory access; used when no explicit credential is given |
| `KEELSON_IDENTITY_BASE_URL` | **Deprecated** compatibility fallback for the base URL (used only when `KEELSON_DIRECTORY_BASE_URL` and an explicit `base_url` are both absent). See sunset note below |

#### Deprecation & sunset: `KEELSON_IDENTITY_BASE_URL`

`KEELSON_IDENTITY_BASE_URL` is a **deprecated alias** kept for backward compatibility
with apps that predate the Directory base-URL wiring. The platform **never injects
it** — the canonical, platform-injected variable is `KEELSON_DIRECTORY_BASE_URL`.

- **Do not** set `KEELSON_IDENTITY_BASE_URL` in new code or manifests; migrate to
  `KEELSON_DIRECTORY_BASE_URL`.
- The alias remains a functional fallback through the **`0.2.x`** SDK line
  (minimum retention: at least one minor release after Directory base-URL wiring
  is GA across all SDKs).
- **First removal target: `v0.3.0`.** From that release the alias is dropped and
  only `KEELSON_DIRECTORY_BASE_URL` (or an explicit `base_url`) is honored.

---

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -r build

# Type-check all packages
pnpm -r check

# Run all tests
pnpm -r test

# Run tests for one package
pnpm --filter @keelsonhq/media test
pnpm --filter @keelsonhq/identity test
pnpm --filter @keelsonhq/files test
pnpm --filter @keelsonhq/tasks test
```
