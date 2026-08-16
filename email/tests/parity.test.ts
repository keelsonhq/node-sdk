/**
 * Cross-language parity tests for Email.
 *
 * These tests load the shared fixtures from fixtures/parity/ at the repository
 * root (or from KEELSON_SDK_FIXTURES_DIR) and
 * assert the same semantic field values that Go and Python parity tests assert.
 *
 * Tests go through verifyWebhookBytes / verifyEventWebhookBytes to exercise
 * the real SDK entry point, not just JSON.parse.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { resolveParityFixturesDir } from "../../test-fixtures.js";
import { verifyWebhookBytes, verifyEventWebhookBytes } from "../src/index.js";

const FIXTURES = resolveParityFixturesDir(import.meta.url);

// deterministic fake secret for tests
const TEST_SECRET = `whsec_${Buffer.from("fake-test-webhook-key!!", "utf-8").toString("base64")}`;

function signPayload(body: string, secret: string): Record<string, string> {
  const msgId = "msg_parity_001";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = `${msgId}.${timestamp}.${body}`;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(signed).digest("base64");
  return {
    "svix-id": msgId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`
  };
}

describe("parity: inbound email", () => {
  it("parses shared fixture through verifyWebhookBytes", () => {
    const body = readFileSync(resolve(FIXTURES, "email_inbound.json"), "utf-8");
    const headers = signPayload(body, TEST_SECRET);

    const msg = verifyWebhookBytes(body, headers, TEST_SECRET);

    // --- Cross-language parity assertions ---
    expect(msg.delivery_id).toBe("dlv_parity01");
    expect(msg.attempt).toBe(1);
    expect(msg.received_at).toBe("2026-01-15T10:00:00Z");
    expect(msg.sent_at).toBe("2026-01-15T09:59:00Z");

    expect(msg.from.name).toBe("Sender");
    expect(msg.from.address).toBe("sender@example.com");

    expect(msg.to).toHaveLength(1);
    expect(msg.to[0].address).toBe("receiver@example.com");

    expect(msg.cc).toHaveLength(0);
    expect(msg.reply_to).toBeNull();

    expect(msg.subject).toBe("Parity test");
    expect(msg.text).toBe("Hello from parity test");
    expect(msg.html).toBeNull();

    expect(msg.provider_message_id).toBe("msg_provider_01");
    expect(msg.in_reply_to).toBeNull();
    expect(msg.references).toEqual(["ref-001"]);
    expect(msg.envelope_to).toBe("receiver@example.com");

    // Authentication
    expect(msg.authentication.spf).toBe("pass");
    expect(msg.authentication.dkim).toBe("pass");
    expect(msg.authentication.dmarc).toBe("pass");

    // Spam
    expect(msg.spam.score).toBe(0.1);
    expect(msg.spam.verdict).toBe("clean");
    expect(msg.spam.reasons).toEqual([]);

    // Attachments
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].id).toBe("att_001");
    expect(msg.attachments[0].filename).toBe("document.pdf");
    expect(msg.attachments[0].content_type).toBe("application/pdf");
    expect(msg.attachments[0].size_bytes).toBe(1024);
  });
});

describe("parity: email event", () => {
  it("parses shared fixture through verifyEventWebhookBytes", () => {
    const body = readFileSync(resolve(FIXTURES, "email_event.json"), "utf-8");
    const headers = signPayload(body, TEST_SECRET);

    const evt = verifyEventWebhookBytes(body, headers, TEST_SECRET);

    // --- Cross-language parity assertions ---
    expect(evt.event_id).toBe("evt_parity01");
    expect(evt.event_type).toBe("bounce");
    expect(evt.email_address).toBe("bounced@example.com");
    expect(evt.resend_email_id).toBe("re_001");
    expect(evt.bounce_type).toBe("hard");
    expect(evt.detail).toBe("Mailbox not found");
    expect(evt.timestamp).toBe("2026-01-15T11:00:00Z");
  });
});
