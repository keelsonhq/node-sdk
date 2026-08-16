/**
 * Email auto-responder example.
 *
 * Listens for inbound emails and sends an automatic reply.
 * Demonstrates: onReceive, send, downloadAttachment, onEvent.
 *
 * Environment variables (set by Keelson at deploy time):
 *   KEELSON_EMAIL_API_URL
 *   KEELSON_EMAIL_TOKEN
 */

import * as email from "@keelsonhq/email";

// Handle inbound emails
email.onReceive(async (msg) => {
  console.log(`From: ${msg.from.address}`);
  console.log(`Subject: ${msg.subject}`);
  console.log(`Spam: ${msg.spam.verdict}`);

  // Skip spam
  if (msg.spam.verdict === "spam") {
    console.log("Skipping spam message.");
    return;
  }

  // Download attachments if any
  for (const att of msg.attachments) {
    const data = await email.downloadAttachment(att.download_url);
    console.log(`Attachment: ${att.filename} (${data.byteLength} bytes)`);
  }

  // Send reply
  const replyTo = msg.reply_to?.address ?? msg.from.address;
  await email.send({
    to: replyTo,
    subject: `Re: ${msg.subject}`,
    text: `Thanks for your message! We received it at ${new Date().toISOString()}.`,
    in_reply_to: msg.provider_message_id ?? undefined,
  });

  console.log(`Replied to ${replyTo}`);
});

// Handle bounce/complaint events
email.onEvent(async (event) => {
  console.log(`Event: ${event.event_type} for ${event.email_address}`);
});
