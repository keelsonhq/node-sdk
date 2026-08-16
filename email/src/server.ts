/**
 * Inbound email webhook server.
 *
 * Starts an HTTP server that listens for Keelson webhook deliveries
 * on ``POST /api/webhooks/email`` and ``POST /api/webhooks/email-events``.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EmailError, getWebhookSecret, webhookSignatureRequired } from "./config.js";
import { getHeader, parseEventPayload, parseInboundMessage, readBody } from "./_parse.js";
import type { ReserveResult } from "./dedup.js";
import { commitDelivery, releaseDelivery, reserveDelivery } from "./dedup.js";
import { verifyEventWebhookBytes, verifyWebhookBytes } from "./verify.js";
import type { EventHandler, ReceiveHandler } from "./types.js";

const WEBHOOK_PATH = "/api/webhooks/email";
const EVENT_WEBHOOK_PATH = "/api/webhooks/email-events";
const HEALTH_PATH = "/health";

let _receiveHandler: ReceiveHandler | null = null;
let _eventHandler: EventHandler | null = null;
let _server: Server | null = null;
let _started = false;

/**
 * Register a handler for inbound emails.
 *
 * The first call automatically starts the webhook server in the background.
 *
 * @example
 * ```ts
 * import * as email from "@keelsonhq/email";
 *
 * email.onReceive(async (msg) => {
 *   console.log(msg.subject, msg.text);
 * });
 * ```
 */
export function onReceive(handler: ReceiveHandler): void {
  _receiveHandler = handler;
  _ensureServerStarted();
}

/**
 * Register a handler for bounce/complaint/delivery events.
 *
 * @example
 * ```ts
 * email.onEvent(async (event) => {
 *   if (event.event_type === "bounce") {
 *     console.log("Bounced:", event.email_address);
 *   }
 * });
 * ```
 */
export function onEvent(handler: EventHandler): void {
  _eventHandler = handler;
  _ensureServerStarted();
}

export interface ServeOptions {
  port?: number;
  host?: string;
  blocking?: boolean;
  /** Suppress the informational message emitted after the server starts. */
  quiet?: boolean;
}

/**
 * Start the webhook HTTP server.
 *
 * When ``blocking`` is true (default) the server keeps the Node.js event
 * loop alive (``server.ref()``), preventing the process from exiting.
 * When ``blocking`` is false the server is ``unref()``-ed so the process
 * can exit even while the server is listening.
 *
 * In both cases the function returns the ``Server`` immediately — it does
 * not block the calling thread.
 *
 * Calling ``serve()`` marks the server as started, so subsequent calls
 * to ``onReceive()`` / ``onEvent()`` will register their handlers on the
 * existing server instead of starting a second listener.
 */
export function serve(options: ServeOptions = {}): Server {
  if (_started && _server) {
    return _server;
  }

  const port = options.port ?? parseInt(process.env.PORT ?? "8000", 10);
  const blocking = options.blocking ?? true;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      await _handleInboundWebhook(req, res);
      return;
    }

    if (req.method === "POST" && req.url === EVENT_WEBHOOK_PATH) {
      await _handleEventWebhook(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const host = options.host ?? "0.0.0.0";
  server.listen(port, host, () => {
    if (!options.quiet) {
      console.log(`Keelson email webhook server listening on ${host}:${port}`);
    }
  });

  if (!blocking) {
    server.unref();
  }

  _started = true;
  _server = server;

  server.on("close", () => {
    _started = false;
    _server = null;
  });

  return server;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function _ensureServerStarted(): void {
  if (_started && _server) {
    // A previous serve({ blocking: false }) may have unref'ed the server.
    // Handler registration means the process should stay alive.
    _server.ref();
    return;
  }
  const port = parseInt(process.env.PORT ?? "8000", 10);
  const server = serve({ port, blocking: false });
  // Keep the process alive — the server must stay referenced so that
  // registered handlers can receive incoming webhooks.
  server.ref();
}

async function _handleInboundWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);

  try {
    const secret = getWebhookSecret();
    if (webhookSignatureRequired() && !secret) {
      // Keelson mode (or a platform env) without an injected signing secret:
      // fail closed rather than accept an unverifiable payload.
      _respondUnverifiable(res);
      return;
    }
    const data = secret
      ? verifyWebhookBytes(body, req.headers, secret)
      : parseInboundMessage(body, "onReceive");

    if (!_receiveHandler) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error": "No handler registered"}');
      return;
    }

    const handler = _receiveHandler;
    await _dispatchDeduped(req, res, () => handler(data));
  } catch (err) {
    _handleWebhookError(res, err, "receive");
  }
}

/**
 * Signed deliveries use an idempotency state machine: reserve → handler →
 * commit(token), with release on failure. Only signed deliveries carry a
 * `svix-id`; unsigned local-development deliveries skip deduplication.
 *
 * reserve resolves one of three states:
 * - `completed` → ACK 200 duplicate (already handled).
 * - `pending`   → another attempt is in flight (un-expired reservation); return a
 *   **retryable 503** so the platform keeps retrying — it is NEVER collapsed into a
 *   200 duplicate, which would falsely mark the delivery `delivered` and break
 *   crash recovery. Once the in-flight attempt completes (→ dedup) or its lease
 *   expires (→ re-acquire) the retry makes progress.
 * - `acquired`  → process; the returned `token` fences commit/release so a stale
 *   attempt cannot mutate a newer attempt's reservation.
 *
 * A store BACKEND error on `reserve` returns 500 (retryable) — never a duplicate
 * ACK. On handler failure the reservation is released. A `commit` failure also
 * returns 500 (fail-closed): the handler succeeded but the completed record is not
 * durable, so the delivery must NOT be ACKed as done. A `release` failure is only
 * logged (the pending lease still fences a retry).
 */
async function _dispatchDeduped(
  req: IncomingMessage,
  res: ServerResponse,
  run: () => void | Promise<void>
): Promise<void> {
  const svixId = getHeader(req.headers, "svix-id");
  let token: string | null = null;
  if (svixId) {
    let result: ReserveResult;
    try {
      result = await reserveDelivery(svixId);
    } catch (storeErr) {
      console.error("idempotency store reserve failed:", storeErr);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error": "Idempotency store error"}');
      return;
    }
    if (result.status === "completed") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status": "ok", "duplicate": true}');
      return;
    }
    if (result.status === "pending") {
      // Another attempt holds an un-expired reservation — retryable, do NOT process
      // and do NOT ACK as done.
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error": "Delivery already in progress"}');
      return;
    }
    token = result.token;
  }
  try {
    await run();
  } catch (err) {
    if (svixId && token !== null) {
      try {
        await releaseDelivery(svixId, token);
      } catch (relErr) {
        // Release failed: log, but still surface the handler error as 500. The
        // pending reservation's lease will let a later retry re-acquire.
        console.error("idempotency store release failed:", relErr);
      }
    }
    throw err;
  }
  if (svixId && token !== null) {
    try {
      await commitDelivery(svixId, token);
    } catch (commitErr) {
      // Fail CLOSED: the handler succeeded but the COMPLETED record could not be
      // durably persisted (e.g. the commit transaction rolled back). Returning 200
      // would let the platform mark the delivery `delivered` with no completed
      // reservation, so a later replay would re-acquire and double-process. Return
      // a retryable 500 instead — the platform retries until a commit succeeds and
      // the completed record is durable (at-least-once; the app is idempotent).
      console.error("idempotency store commit failed:", commitErr);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error": "Idempotency commit failed"}');
      return;
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end('{"status": "ok"}');
}

async function _handleEventWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);

  try {
    const secret = getWebhookSecret();
    if (webhookSignatureRequired() && !secret) {
      _respondUnverifiable(res);
      return;
    }
    const data = secret
      ? verifyEventWebhookBytes(body, req.headers, secret)
      : parseEventPayload(body, "onEvent");

    if (!_eventHandler) {
      // No event handler registered — just ACK.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status": "ok"}');
      return;
    }

    const handler = _eventHandler;
    await _dispatchDeduped(req, res, () => handler(data));
  } catch (err) {
    _handleWebhookError(res, err, "event");
  }
}

function _respondUnverifiable(res: ServerResponse): void {
  // 500: the webhook signing secret is not configured on a Keelson deployment.
  // This is a platform/config error, not a bad request from the caller — the
  // delivery is neither processed nor acknowledged, so the platform retries.
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(
    '{"error": "KEELSON_EMAIL_WEBHOOK_SECRET is not configured; refusing to accept an unsigned webhook in Keelson mode"}'
  );
}

function _handleWebhookError(res: ServerResponse, err: unknown, kind: "receive" | "event"): void {
  if (err instanceof EmailError && err.message.includes("decode payload")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end('{"error": "Invalid JSON"}');
    return;
  }
  if (err instanceof EmailError && err.message.startsWith("verify")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error": "Invalid signature"}');
    return;
  }
  console.error(`Error in email ${kind} handler:`, err);
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end('{"error": "Handler error"}');
}
