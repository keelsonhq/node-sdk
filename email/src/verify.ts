/**
 * Webhook signature verification.
 *
 * Verifies Svix HMAC-SHA256 signatures on inbound email and event
 * webhook payloads.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { EmailError } from "./config.js";
import { getHeader, parseEventPayload, parseInboundMessage, readBody, toBuffer } from "./_parse.js";
import type { EmailEventPayload, InboundMessage } from "./types.js";

const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verify and parse an inbound email webhook request.
 */
export async function verifyWebhook(
  req: IncomingMessage,
  secret: string,
): Promise<InboundMessage> {
  const body = await readBody(req);
  return verifyWebhookBytes(body, req.headers, secret);
}

/**
 * Verify and parse an inbound email webhook from raw bytes and headers.
 */
export function verifyWebhookBytes(
  body: string | Buffer | ArrayBuffer | Uint8Array,
  headers: IncomingMessage["headers"] | Headers,
  secret: string,
): InboundMessage {
  const payload = _verifyBytes(body, headers, secret, "verifyWebhookBytes");
  return parseInboundMessage(payload, "verifyWebhookBytes");
}

/**
 * Verify and parse an email event webhook request.
 */
export async function verifyEventWebhook(
  req: IncomingMessage,
  secret: string,
): Promise<EmailEventPayload> {
  const body = await readBody(req);
  return verifyEventWebhookBytes(body, req.headers, secret);
}

/**
 * Verify and parse an email event webhook from raw bytes and headers.
 */
export function verifyEventWebhookBytes(
  body: string | Buffer | ArrayBuffer | Uint8Array,
  headers: IncomingMessage["headers"] | Headers,
  secret: string,
): EmailEventPayload {
  const payload = _verifyBytes(body, headers, secret, "verifyEventWebhookBytes");
  return parseEventPayload(payload, "verifyEventWebhookBytes");
}

function _verifyBytes(
  body: string | Buffer | ArrayBuffer | Uint8Array,
  headers: IncomingMessage["headers"] | Headers,
  secret: string,
  fnName: string,
): Buffer {
  if (!secret.trim()) {
    throw new EmailError(`${fnName}: secret is required`);
  }

  const payload = toBuffer(body);
  const msgId = getHeader(headers, "svix-id");
  const timestamp = getHeader(headers, "svix-timestamp");
  const signature = getHeader(headers, "svix-signature");
  if (!msgId || !timestamp || !signature) {
    throw new EmailError(`${fnName}: missing svix headers`);
  }

  _verifySvixSignature(payload, msgId, timestamp, signature, secret, fnName);
  return payload;
}

function _verifySvixSignature(
  body: Buffer,
  msgId: string,
  timestamp: string,
  signature: string,
  secret: string,
  fnName: string,
): void {
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    throw new EmailError(`${fnName}: invalid svix timestamp`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new EmailError(`${fnName}: timestamp outside tolerance`);
  }

  let key: Buffer;
  try {
    key = _decodeSecret(secret);
  } catch (err) {
    throw new EmailError(`${fnName}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const signedContent = Buffer.concat([
    Buffer.from(msgId, "utf-8"),
    Buffer.from(".", "utf-8"),
    Buffer.from(timestamp, "utf-8"),
    Buffer.from(".", "utf-8"),
    body,
  ]);
  const expected = createHmac("sha256", key).update(signedContent).digest();

  for (const entry of signature.split(/\s+/).filter(Boolean)) {
    const [version, encoded] = entry.split(",", 2);
    if (version !== "v1" || !encoded) continue;
    const actual = _strictBase64Decode(encoded);
    if (!actual) continue;
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return;
    }
  }

  throw new EmailError(`${fnName}: no matching signature found`);
}

const _STRICT_B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decode base64 with the same strictness as Python's
 * ``base64.b64decode(s, validate=True)`` and Go's
 * ``base64.StdEncoding.DecodeString``: the input must use only the
 * standard alphabet, its length must be a multiple of 4 (with proper
 * ``=`` padding), and no trailing junk is tolerated.
 *
 * Returns ``null`` instead of throwing so callers can skip invalid
 * entries in a signature list.
 */
function _strictBase64Decode(s: string): Buffer | null {
  if (s.length === 0 || s.length % 4 !== 0) return null;
  if (!_STRICT_B64_RE.test(s)) return null;
  return Buffer.from(s, "base64");
}

function _decodeSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("whsec_")) {
    throw new Error("secret must start with whsec_");
  }
  const b64 = trimmed.slice("whsec_".length);
  const decoded = _strictBase64Decode(b64);
  if (!decoded || decoded.length === 0) {
    throw new Error("secret is not valid base64");
  }
  return decoded;
}
