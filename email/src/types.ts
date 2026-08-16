/**
 * Keelson Email SDK type definitions.
 */

export interface Address {
  name: string;
  address: string;
}

export interface AuthenticationResult {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

export interface SpamAssessment {
  score: number;
  verdict: "clean" | "suspicious" | "spam";
  reasons: string[];
}

export interface InboundAttachmentMeta {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  download_url: string;
}

export interface InboundMessage {
  delivery_id: string;
  attempt: number;
  received_at: string;
  sent_at: string | null;
  from: Address;
  to: Address[];
  cc: Address[];
  reply_to: Address | null;
  subject: string;
  text: string | null;
  html: string | null;
  provider_message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  envelope_to: string;
  authentication: AuthenticationResult;
  spam: SpamAssessment;
  attachments: InboundAttachmentMeta[];
}

export interface Attachment {
  filename: string;
  content: Buffer;
  content_type?: string;
}

export interface SendOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  from_address?: string;
  from_name?: string;
  reply_to?: string;
  in_reply_to?: string;
  references?: string[];
  attachments?: Attachment[];
}

export interface SendResult {
  send_id: string;
  status: string;
}

export interface EmailEventPayload {
  event_id: string;
  event_type: "bounce" | "complaint" | "delivered";
  email_address: string;
  resend_email_id: string | null;
  bounce_type: string | null;
  detail: string | null;
  timestamp: string;
}

export type ReceiveHandler = (msg: InboundMessage) => void | Promise<void>;
export type EventHandler = (event: EmailEventPayload) => void | Promise<void>;
