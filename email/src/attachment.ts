/**
 * Attachment download client.
 */

import { EmailError, getApiUrl, getAuthHeaders, getEmailBaseUrl } from "./config.js";
import type { InboundAttachment } from "./types.js";

/**
 * Download an inbound attachment. Passing the attachment metadata enables the
 * app-scoped gateway route; a URL string always retains the legacy behavior.
 */
export async function downloadAttachment(
  attachment: string | InboundAttachment,
  timeoutMs = 30_000,
): Promise<Buffer> {
  const gatewayBaseUrl = typeof attachment === "string" ? null : getEmailBaseUrl();
  let url: URL;
  if (typeof attachment !== "string" && gatewayBaseUrl) {
    url = new URL(
      `__keelson/email/attachments/${encodeURIComponent(attachment.id)}`,
      `${gatewayBaseUrl}/`,
    );
  } else {
    const downloadUrl = typeof attachment === "string" ? attachment : attachment.download_url;
    url = new URL(downloadUrl.replace(/^\//, ""), `${getApiUrl()}/`);
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      ...getAuthHeaders(),
      Accept: "application/octet-stream",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new EmailError(`Attachment download failed (${response.status}): ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
