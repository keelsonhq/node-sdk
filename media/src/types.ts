/**
 * Keelson Media SDK type definitions.
 */

/** Metadata for a stored file. */
export interface MediaStat {
  contentType: string;
  contentLength: number;
  status: number;
}

/** Options for uploading a file. */
export interface PutOptions {
  /** MIME content type. Auto-detected from filename if omitted. */
  contentType?: string;
  /** Original filename hint (used for content-type guessing and metadata). */
  filename?: string;
}
