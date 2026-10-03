/**
 * Keelson Tasks SDK for Node.js (`@keelsonhq/tasks`).
 *
 * Enqueue a run of a command declared under `tasks:` in `keelson.yaml` and
 * read its state.
 *
 * @example
 * ```ts
 * import { enqueue, get, TasksError } from "@keelsonhq/tasks";
 *
 * const taskId = await enqueue("generate-pdf", { order_id: 1 }, {
 *   idempotencyKey: "order-1-pdf",
 * });
 * const status = await get(taskId); // status.status === "queued" / ... / "failed"
 * ```
 *
 * ## Modes
 *
 * - **Keelson mode** (`KEELSON_MODE=keelson`): requests go to the runtime API
 *   at `KEELSON_TASKS_BASE_URL` with an OIDC id token from the metadata
 *   server; the command runs later on a separate instance, with retries.
 * - **Local mode** (`KEELSON_MODE=local`, or no Keelson env at all): `enqueue`
 *   runs `keelson dev task run <name> --payload - --json` and resolves after
 *   the command has finished. No retry; results live in this process only.
 *
 * `KEELSON_MODE` is the single mode signal and the SDK is fail-closed on
 * Keelson (never silently falls back to running tasks locally).
 */

export type { EnqueueOptions, TaskStatus } from './client.js';
export { enqueue, get, MAX_BODY_BYTES, TasksError } from './client.js';
