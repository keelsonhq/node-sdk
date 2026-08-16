/**
 * Email sending via the Keelson Email API.
 */

import { getApiUrl, getAuthHeaders, EmailError } from "./config.js";
import type { Attachment, SendOptions, SendResult } from "./types.js";

function toAddressList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

export async function send(options: SendOptions): Promise<SendResult> {
  const to = toAddressList(options.to);

  const payload: Record<string, unknown> = {
    to,
    subject: options.subject,
  };

  if (options.text != null) payload.text = options.text;
  if (options.html != null) payload.html = options.html;
  if (options.cc != null) payload.cc = toAddressList(options.cc);
  if (options.bcc != null) payload.bcc = toAddressList(options.bcc);
  if (options.from_address != null) payload.from = options.from_address;
  if (options.from_name != null) payload.from_name = options.from_name;
  if (options.reply_to != null) payload.reply_to = options.reply_to;
  if (options.in_reply_to != null) payload.in_reply_to = options.in_reply_to;
  if (options.references != null) payload.references = options.references;

  if (options.attachments && options.attachments.length > 0) {
    payload.attachments = options.attachments.map((att: Attachment) => ({
      filename: att.filename,
      content: att.content.toString("base64"),
      content_type: att.content_type ?? "application/octet-stream",
    }));
  }

  const url = `${getApiUrl()}/v1/email/send`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.text();

  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    let message = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) {
        code = parsed.error.code ?? code;
        message = parsed.error.message ?? message;
      }
    } catch {
      // Use raw body as message.
    }
    throw new EmailError(`Send failed [${code}]: ${message}`);
  }

  return JSON.parse(body) as SendResult;
}
