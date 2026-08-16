/**
 * Attachment download client.
 */

import { EmailError, getApiUrl, getAuthHeaders } from "./config.js";

/**
 * Download an inbound attachment by URL.
 */
export async function downloadAttachment(
  downloadUrl: string,
  timeoutMs = 30_000,
): Promise<Buffer> {
  const url = new URL(downloadUrl.replace(/^\//, ""), getApiUrl() + "/");
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
