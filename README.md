# Keelson Node SDK

SDK guide: https://keelson.dev/docs/building-apps/sdk/

Node.js SDK for building apps on the Keelson platform. Provides five packages:

> **Note**: This repository is a read-only release mirror. Development happens in the private Keelson monorepo; issues are welcome here, but pull requests are not accepted — changes land through the next release.

| Package | npm | Description |
|---------|-----|-------------|
| [Email](./email) | [`@keelsonhq/email`](https://www.npmjs.com/package/@keelsonhq/email) | Outbound email and delivery events |
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
npm install @keelsonhq/email @keelsonhq/media @keelsonhq/files @keelsonhq/identity
```

Install only the packages you need.

---

## Email SDK (`@keelsonhq/email`)

Send email to your app's users and receive delivery events (delivered /
bounce / complaint). Keelson injects the endpoint, token, and webhook signing
secret at deploy time; no `keelson.yaml` setting is needed. Full guide:
https://keelson.dev/docs/building-apps/external-integrations/#send-email

```ts
import * as email from "@keelsonhq/email";

const result = await email.send({
  to: "user@example.com",
  subject: "Request received",
  text: "We received request 1234.",
});
// Store result.send_id to match it with delivery events later
console.log(result.send_id, result.status);
```

Sending rules:

- The sender is always `<app-slug>@mail.keelson.run`. `from_name` and
  `reply_to` can be set; custom sender domains are not available
- Send only business communication to your app's users
  ([Acceptable Use Policy](https://keelson.dev/aup/) 2.3). Marketing
  campaigns and sending to people who do not use the app are not allowed
- Up to 50 recipients per message (To + CC + BCC). At least one of `text` or
  `html` is required
- Up to 30 sends per 60 seconds, per app and per workspace
- Monthly recipient limits depend on the plan and are counted per app and per
  workspace ([Plans and limits](https://keelson.dev/docs/workspace/plans-and-limits/))
- Inbound email is not available

A rejected send throws `EmailError`; the message includes the error code.

| HTTP | Error code | Meaning |
|------|------------|---------|
| 400 | `RECIPIENT_SUPPRESSED` | A recipient is on the workspace suppression list |
| 403 | `EMAIL_SENDING_SUSPENDED` | Sending is suspended for the workspace (too many permanent bounces or complaints). Contact Keelson to lift it |
| 422 | `RECIPIENT_LIMIT_EXCEEDED` | More than 50 recipients |
| 429 | `RATE_LIMIT_EXCEEDED` | 60-second send limit reached. Retry later |
| 429 | `MONTHLY_QUOTA_EXCEEDED` | Monthly recipient limit reached |
| 429 | `GLOBAL_RATE_LIMIT_EXCEEDED` / `GLOBAL_DAILY_QUOTA_EXCEEDED` | Platform-wide sending volume limit reached. Retry later |
| 502 | `SEND_OUTCOME_UNKNOWN` | Outcome could not be confirmed; the message may have been sent. Do not retry automatically |

### Delivery events

Keelson posts signed delivery events to your app at
`POST /api/webhooks/email-events`. Verify the signature with
`KEELSON_EMAIL_WEBHOOK_SECRET` over the raw request body, then match the
event to your send record with `send_id`.

```ts
import express from "express";
import * as email from "@keelsonhq/email";

const app = express();

app.post(
  "/api/webhooks/email-events",
  express.raw({ type: "*/*" }),
  (req, res) => {
    const event = email.verifyEventWebhookBytes(
      req.body,
      req.headers,
      process.env.KEELSON_EMAIL_WEBHOOK_SECRET!,
    );
    if (event.event_type === "bounce" && event.bounce_type === "hard") {
      // Look up the send by event.send_id and mark event.email_address invalid
    }
    res.sendStatus(204);
  },
);
```

Event fields: `event_id`, `event_type` (`delivered` / `bounce` /
`complaint`), `email_address`, `send_id`, `bounce_type` (`hard` / `soft`,
bounces only), `detail`, `provider`, `timestamp`. Delivery is at-least-once;
use `event_id` to detect duplicates.

Permanent bounces and complaints add the address to the workspace
suppression list automatically, whether or not the app handles the event.
After that, no app in the workspace can send to it (`RECIPIENT_SUPPRESSED`).
Owners and Admins can review the list under Email in the console's workspace
settings.

### Cross-language guaranteed API

| Function | Description |
|----------|-------------|
| `send(options)` | Send an email; resolves to `{ send_id, status }` |
| `verifyEventWebhook(req, secret)` | Verify Svix signature and parse an event request |
| `verifyEventWebhookBytes(body, headers, secret)` | Verify event from raw body bytes |
| `setIdempotencyStore(store)` | Plug in a shared store to suppress duplicate deliveries across instances |

### Node-specific helpers

| Function | Description |
|----------|-------------|
| `onEvent(handler)` | Register an event handler and start a standalone webhook server on `PORT` |
| `serve(options?)` | Manually start the webhook server; pass `{ quiet: true }` to suppress the startup message |

`onEvent()` / `serve()` start their own HTTP server, so use them only when the
app has no other server listening on `PORT`. They verify signatures
automatically with `KEELSON_EMAIL_WEBHOOK_SECRET`.

### Environment variables

| Variable | Description |
|----------|-------------|
| `KEELSON_EMAIL_API_URL` | Email API endpoint (injected) |
| `KEELSON_EMAIL_TOKEN` | Bearer token for sending (injected) |
| `KEELSON_EMAIL_WEBHOOK_SECRET` | Signing secret for delivery events (injected) |
| `KEELSON_EMAIL_BASE_URL` | Optional app-scoped endpoint. When set, the SDK prefers it over `KEELSON_EMAIL_API_URL` |

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
| `getRequestUser(options?)` | `getCurrentUser` plus `perms` (this app's permissions) from `X-Keelson-User-App-Perms`; no network call |
| `getCurrentIdentity(options?)` | Fetch the current user's full identity as the app actor |
| `listMembers(options?)` | List workspace members (paginated, filterable) |
| `getUser(userId, options?)` | Get user by ID |
| `listGroups(options?)` | List workspace groups |

`getCurrentUser` and `getCurrentIdentity` accept `headers`, which may be a
plain object, Node `IncomingHttpHeaders`, or WHATWG `Headers`. The required
header is `x-keelson-user-id`; `x-keelson-user-email` and
`x-keelson-user-name` are optional.

`getRequestUser({ headers })` returns `RequestUser = UserIdentity & { perms: string[] }`.
`perms` splits `x-keelson-user-app-perms` on `,` (e.g. `["view"]` or
`["view", "manage"]`), trimming items and dropping empty ones; it is `[]` when
the header is absent (machine / webhook requests). The gateway sends non-ASCII
values such as a Japanese name as raw UTF-8 bytes, which Node's HTTP server
hands over as a latin-1 string; `getRequestUser` decodes such values back to
UTF-8 (`getCurrentUser` does not).

```ts
const user = await getRequestUser({ headers: req.headers });
if (!user.perms.includes("manage")) return res.status(403).end();
```

Directory functions accept `RequestOptions`:
`{ base_url?, cookie?, authorization?, app_token?, host?, timeout_ms? }`.

`listMembers` items and `getUser` return a `MemberItem`:
`{ id, email, name, role, image_url }`. `image_url` is the member's profile
image URL served by Clerk (`img.clerk.com`), or `null` when the member has not
uploaded an image (render initials instead). Append `width` / `height` query
parameters to get a resized image. Store only the member `id` in your app's DB
and re-fetch `image_url` on display rather than relying on the URL to change
when the member replaces their image. Local mode returns `image_url: null` for every
member, or the `image_url` from the local users file when one is used.

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
| Local | `KEELSON_LOCAL_MODE=1` (`true` / `yes` also accepted) | Returns deterministic fixture data without HTTP or request headers |
| Keelson | Default | Calls the Keelson auth gateway via `KEELSON_DIRECTORY_BASE_URL` (canonical, platform-injected). `KEELSON_IDENTITY_BASE_URL` is a **deprecated** fallback only |

### Local mode

With `KEELSON_LOCAL_MODE=1`, every function (`getCurrentUser`,
`getRequestUser`, `getCurrentIdentity`, `listMembers`, `getUser`, `listGroups`)
returns fixed data for one fixed user and never reads headers or calls the
Directory API. Local mode is for local development only: if a Keelson
deployment is detected (`KEELSON_MODE=keelson`, or any of `KEELSON_APP_ID`,
`KEELSON_WORKSPACE_ID`, `KEELSON_TENANT_ID`, `KEELSON_DEPLOY_ID`,
`KEELSON_APP_URL` is set), every function throws an `IdentityError` instead
of returning fixed data.

**Local users file.** The members and the fixed user come from a local users
file when one exists: `KEELSON_LOCAL_USERS_FILE`, or `./.keelson/dev-users.json`
(relative to the process working directory) when that variable is unset. A file
named by `KEELSON_LOCAL_USERS_FILE` must exist; a missing, unreadable, or
malformed file throws an `IdentityError`. The file is read only in local mode.

```json
{
  "users": [
    { "id": "sample-tanaka", "email": "tanaka@example.com", "name": "田中 太郎", "perms": ["view", "manage"] },
    { "id": "sample-sato", "email": "sato@example.com", "name": "佐藤 花子", "perms": ["view"], "image_url": null }
  ]
}
```

- `users`: at least one user, in display order. `id` is a unique non-empty
  string; `email` and `name` are strings (may be empty); `perms` is `["view"]`
  or `["view", "manage"]`; `image_url` is optional (string or `null`). Unknown
  keys are ignored.
- The fixed user is the first user with `manage`, or the first user if none has it.
- `role` is `"ADMIN"` for users with `manage`, otherwise `"APP_USER"`.
  `listMembers` keeps file order and supports `q` / `role` / `group_key` /
  `group_id` / `limit` / `offset`.
- `listGroups` returns `admins` (users with `manage`) and `everyone`.
- `getCurrentIdentity` returns the fixed user with `app.permissions` = their
  `perms` sorted, and `attributes.groups` = `["admins", "everyone"]` or `["everyone"]`.
- `KEELSON_LOCAL_USER_*` and `KEELSON_LOCAL_WORKSPACE_ROLE` are ignored;
  `KEELSON_LOCAL_WORKSPACE_ID` and `KEELSON_LOCAL_APP_ID` still apply.

Without a local users file, the fixed user is `KEELSON_LOCAL_USER_ID` /
`_EMAIL` / `_NAME` (default `local-user-001` / `dev@localhost` /
`Local Developer`) with `perms` `["view", "manage"]`, plus three built-in
members (Alice, Bob, Carol) and the groups everyone / developers / admins / owners.

### Environment variables

| Variable | Description |
|----------|-------------|
| `KEELSON_LOCAL_MODE` | Set to `1` for fixture data (no HTTP). Refused (`IdentityError`) in a Keelson deployment |
| `KEELSON_LOCAL_USERS_FILE` | Local mode: path to the local users file (default `./.keelson/dev-users.json` when present) |
| `KEELSON_LOCAL_USER_ID` / `KEELSON_LOCAL_USER_EMAIL` / `KEELSON_LOCAL_USER_NAME` | Local mode without a users file: the fixed user (default `local-user-001` / `dev@localhost` / `Local Developer`) |
| `KEELSON_LOCAL_WORKSPACE_ID` | Override the local workspace ID |
| `KEELSON_LOCAL_WORKSPACE_ROLE` | Override the local workspace role (ignored with a users file) |
| `KEELSON_LOCAL_APP_ID` | Override the local app ID (default `local-app-001`) |
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
pnpm --filter @keelsonhq/email test
pnpm --filter @keelsonhq/media test
pnpm --filter @keelsonhq/identity test
pnpm --filter @keelsonhq/files test
pnpm --filter @keelsonhq/tasks test
```
