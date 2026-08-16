/**
 * Keelson Media SDK for Node.js.
 *
 * @example
 * ```ts
 * import * as media from "@keelsonhq/media";
 *
 * // Upload a file
 * const fileId = await media.put(Buffer.from("hello"), {
 *   contentType: "text/plain",
 *   filename: "hello.txt",
 * });
 *
 * // Download
 * const data = await media.get(fileId);
 *
 * // Read (aliases: open, read)
 * const buf = await media.open(fileId);
 *
 * // Check existence
 * const found = await media.exists(fileId);
 *
 * // Metadata
 * const info = await media.stat(fileId);
 * console.log(info.contentType, info.contentLength);
 *
 * // Public URL path
 * const path = media.url(fileId);
 *
 * // Delete (also available as media.del)
 * await media.delete(fileId);
 * ```
 *
 * ## Modes
 *
 * - **Keelson mode** (production): set `KEELSON_INTERNAL_MEDIA_BASE_URL`
 *   and `KEELSON_APP_MEDIA_TOKEN`. All operations go through the
 *   Keelson media service.
 * - **Local mode** (development): when those vars are absent, files are
 *   stored on the local filesystem under `MEDIA_DIR` (default `./media`).
 */

export { MediaError } from './config.js';
export { put, get, read, open, del, exists, stat, url } from './client.js';
// Re-export `del` as `delete` for Python SDK parity.
// `delete` is a reserved word so it cannot be a function name, but works as
// a named re-export.
export { del as delete } from './client.js';
export type { MediaStat, PutOptions } from './types.js';
