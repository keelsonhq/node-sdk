/**
 * Media upload/download example.
 *
 * Demonstrates: put, get, stat, url, exists, delete.
 *
 * In local mode (no env vars), media is stored in ./media/.
 * On Keelson, media goes through the internal files proxy.
 */

import * as media from "@keelsonhq/media";

async function main() {
  // Upload a text file
  const textId = await media.put(Buffer.from("Hello, Keelson!"), {
    contentType: "text/plain",
    filename: "greeting.txt",
  });
  console.log(`Uploaded text file: ${textId}`);

  // Upload binary data (e.g. an image)
  const imageData = Buffer.alloc(100, 0xff); // placeholder
  const imageId = await media.put(imageData, {
    filename: "placeholder.png",
  });
  console.log(`Uploaded image: ${imageId}`);

  // Check existence
  console.log(`Text file exists: ${await media.exists(textId)}`);

  // Get metadata
  const info = await media.stat(textId);
  console.log(`Content-Type: ${info.contentType}`);
  console.log(`Size: ${info.contentLength} bytes`);

  // Download
  const data = await media.get(textId);
  console.log(`Content: ${Buffer.from(data).toString("utf-8")}`);

  // Public URL path (for use in HTML)
  const publicUrl = media.url(textId);
  console.log(`Public URL: ${publicUrl}`);

  // Delete
  await media.delete(textId);
  console.log(`Deleted: ${textId}`);
  console.log(`Exists after delete: ${await media.exists(textId)}`);
}

main().catch(console.error);
