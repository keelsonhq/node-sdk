/**
 * Keelson data-files SDK for Node.js (`@keelsonhq/files`).
 *
 * Key-addressed, overwrite, whole-value durable storage for an app's own files
 * (state, settings, caches). Distinct from `@keelsonhq/media`: media is
 * create-only, ULID-addressed, immutable and served over HTTP; `files` is
 * key-addressed, overwrite-in-place, and read only by the app itself.
 *
 * @example
 * ```ts
 * import * as files from "@keelsonhq/files";
 *
 * await files.write("seen_urls.json", JSON.stringify(seen));
 * const raw = await files.read("seen_urls.json"); // Uint8Array | null
 * const seen = JSON.parse(raw ? new TextDecoder().decode(raw) : "[]");
 * const keys = await files.list();          // sorted string[]
 * await files.delete("seen_urls.json");     // idempotent
 * ```
 *
 * ## Modes
 *
 * - **Keelson mode** (production): the platform injects `KEELSON_FILES_BUCKET`
 *   / `KEELSON_FILES_PREFIX`; the per-app service account writes through to GCS
 *   over ADC (no auth env).
 * - **Local mode** (development): files are stored on the local filesystem
 *   under `KEELSON_FILES_DIR` (default `./.keelson/files`).
 *
 * Linux uses a descriptor-relative backend through `/proc/self/fd`. macOS and
 * Windows use a path-based local-development backend because Node's `fs` does
 * not expose `openat`; it rejects observed symlinks and confines paths to the
 * configured directory. See `localstrategy.ts`.
 *
 * `KEELSON_MODE` is the single mode signal and the SDK is fail-closed on
 * Keelson (never silently falls back to ephemeral local disk).
 */

// Re-export `del` as `delete` for Python/Go parity. `delete` is a reserved
// word so it cannot be a function name, but works as a named re-export.
export { del, del as delete, list, read, write } from './client.js';
export { FilesError, MAX_OBJECT_SIZE_BYTES } from './config.js';
