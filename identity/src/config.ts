/**
 * Configuration helpers — reads from environment variables injected
 * by Keelson at deploy time.
 */

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export function getBaseUrl(): string {
  const url = process.env.KEELSON_IDENTITY_BASE_URL?.trim().replace(/\/+$/, "");
  if (!url) {
    throw new IdentityError(
      "KEELSON_IDENTITY_BASE_URL is not set. " +
        "Pass base_url or set KEELSON_IDENTITY_BASE_URL.",
    );
  }
  return url;
}

/**
 * Resolve the Directory API base URL for app-as-actor access.
 *
 * Prefers KEELSON_DIRECTORY_BASE_URL (set for app-as-actor deployments) and
 * falls back to KEELSON_IDENTITY_BASE_URL for compatibility with the existing
 * user-as-actor configuration.
 */
export function getDirectoryBaseUrl(): string {
  const directory = process.env.KEELSON_DIRECTORY_BASE_URL?.trim().replace(/\/+$/, "");
  if (directory) return directory;
  const identity = process.env.KEELSON_IDENTITY_BASE_URL?.trim().replace(/\/+$/, "");
  if (identity) return identity;
  throw new IdentityError(
    "Directory base URL is not set. " +
      "Pass base_url or set KEELSON_DIRECTORY_BASE_URL / KEELSON_IDENTITY_BASE_URL.",
  );
}

export function isLocalMode(): boolean {
  const val = process.env.KEELSON_LOCAL_MODE?.trim() ?? "";
  return val === "1" || val === "true" || val === "yes";
}

// Production marks (local-dev-spec §4.1), in the order they are reported.
const PRODUCTION_MARK_VARS = [
  "KEELSON_APP_ID",
  "KEELSON_WORKSPACE_ID",
  "KEELSON_TENANT_ID",
  "KEELSON_DEPLOY_ID",
  "KEELSON_APP_URL",
];

function productionMarks(): string[] {
  const marks: string[] = [];
  if (process.env.KEELSON_MODE?.trim().toLowerCase() === "keelson") {
    marks.push("KEELSON_MODE=keelson");
  }
  for (const name of PRODUCTION_MARK_VARS) {
    if (process.env[name]?.trim()) marks.push(name);
  }
  return marks;
}

/**
 * Throw when local mode is on inside a Keelson deployment. Local mode must
 * never serve fixed data in production, nor silently fall back to headers.
 */
export function assertLocalModeAllowed(): void {
  const marks = productionMarks();
  if (marks.length === 0) return;
  throw new IdentityError(
    `KEELSON_LOCAL_MODE is set, but this is a Keelson deployment (${marks.join(", ")}). ` +
      "Local mode is for local development only; unset KEELSON_LOCAL_MODE.",
  );
}
