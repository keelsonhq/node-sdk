/**
 * Keelson Email SDK for Node.js.
 *
 * @example
 * ```ts
 * import * as email from "@keelsonhq/email";
 *
 * // Receive inbound emails
 * email.onReceive(async (msg) => {
 *   console.log(msg.subject, msg.text);
 *   console.log(msg.spam.verdict); // "clean", "suspicious", "spam"
 *
 *   // Download attachments
 *   for (const att of msg.attachments) {
 *     const data = await email.downloadAttachment(att.download_url);
 *     // save data...
 *   }
 *
 *   // Reply
 *   await email.send({
 *     to: msg.reply_to?.address ?? msg.from.address,
 *     subject: `Re: ${msg.subject}`,
 *     text: "Got it!",
 *     in_reply_to: msg.provider_message_id ?? undefined,
 *   });
 * });
 *
 * // Handle bounce/complaint events
 * email.onEvent(async (event) => {
 *   if (event.event_type === "bounce") {
 *     console.log("Bounced:", event.email_address);
 *   }
 * });
 * ```
 *
 * The SDK automatically reads ``KEELSON_EMAIL_API_URL`` and
 * ``KEELSON_EMAIL_TOKEN`` from the environment.
 */

export { EmailError } from "./config.js";
export { send } from "./send.js";
export { downloadAttachment } from "./attachment.js";
export {
  verifyWebhook,
  verifyWebhookBytes,
  verifyEventWebhook,
  verifyEventWebhookBytes
} from "./verify.js";
export {
  onReceive,
  onEvent,
  serve
} from "./server.js";
export type { ServeOptions } from "./server.js";
export { setIdempotencyStore } from "./dedup.js";
export type { IdempotencyStore, ReserveResult } from "./dedup.js";
export type {
  Address,
  Attachment,
  AuthenticationResult,
  EmailEventPayload,
  EventHandler,
  InboundAttachmentMeta,
  InboundMessage,
  ReceiveHandler,
  SendOptions,
  SendResult,
  SpamAssessment
} from "./types.js";
