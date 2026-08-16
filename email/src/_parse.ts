/**
 * Internal parsing and buffer utilities for the email SDK.
 *
 * Shared by verify.ts and server.ts — not part of the public API.
 */

import type { IncomingMessage } from "node:http";
import { EmailError } from "./config.js";
import type { EmailEventPayload, InboundMessage } from "./types.js";

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function parseInboundMessage(
  body: string | Buffer | ArrayBuffer | Uint8Array,
  fnName: string,
): InboundMessage {
  try {
    return JSON.parse(toBuffer(body).toString("utf-8")) as InboundMessage;
  } catch {
    throw new EmailError(`${fnName}: decode payload: invalid JSON`);
  }
}

export function parseEventPayload(
  body: string | Buffer | ArrayBuffer | Uint8Array,
  fnName: string,
): EmailEventPayload {
  try {
    return JSON.parse(toBuffer(body).toString("utf-8")) as EmailEventPayload;
  } catch {
    throw new EmailError(`${fnName}: decode payload: invalid JSON`);
  }
}

export function getHeader(
  headers: IncomingMessage["headers"] | Headers,
  name: string,
): string {
  if (headers instanceof Headers) {
    return headers.get(name) ?? "";
  }

  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export function toBuffer(
  body: string | Buffer | ArrayBuffer | Uint8Array,
): Buffer {
  if (typeof body === "string") {
    return Buffer.from(body, "utf-8");
  }
  if (body instanceof Buffer) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.from(body);
}
