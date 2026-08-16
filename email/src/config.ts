/**
 * Configuration helpers — reads from environment variables injected
 * by Keelson at deploy time.
 */

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailError";
  }
}

export function getApiUrl(): string {
  const url = process.env.KEELSON_EMAIL_API_URL?.trim().replace(/\/+$/, "");
  if (!url) {
    throw new EmailError(
      "KEELSON_EMAIL_API_URL is not set. " +
        "Ensure the app is deployed on Keelson with email enabled."
    );
  }
  return url;
}

export function getToken(): string {
  const token = process.env.KEELSON_EMAIL_TOKEN?.trim();
  if (!token) {
    throw new EmailError(
      "KEELSON_EMAIL_TOKEN is not set. " +
        "Ensure the app is deployed on Keelson with email enabled."
    );
  }
  return token;
}

export function getAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getToken()}` };
}

export function getWebhookSecret(): string | null {
  const secret = process.env.KEELSON_EMAIL_WEBHOOK_SECRET?.trim();
  return secret ? secret : null;
}

/** Normalized `KEELSON_MODE` value (lower-cased, trimmed); "" when unset. */
export function getMode(): string {
  return (process.env.KEELSON_MODE ?? "").trim().toLowerCase();
}

/**
 * Platform-owned core env vars whose presence signals the app is running on
 * Keelson and activates fail-closed behavior. Mirrors the Media SDK's platform
 * detection.
 */
const CORE_IDENTIFIER_ENVS = ["KEELSON_APP_ID", "KEELSON_TENANT_ID", "KEELSON_DEPLOY_ID"] as const;

/** True when any platform-owned core identifier is visible (running on Keelson). */
export function isPlatformEnv(): boolean {
  return CORE_IDENTIFIER_ENVS.some((name) => Boolean(process.env[name]?.trim()));
}

/**
 * Whether inbound and event webhook deliveries must carry a valid signature.
 *
 * Fail-closed on Keelson: an unsigned or unverifiable delivery is rejected rather
 * than parsed. Contract mirrors the Media runtime-mode contract:
 *
 * - `KEELSON_MODE=keelson` → required.
 * - `KEELSON_MODE=local` → not required (local development accepts unsigned).
 * - `KEELSON_MODE` unset but a platform environment is detected
 *   (`KEELSON_APP_ID` / `KEELSON_TENANT_ID` / `KEELSON_DEPLOY_ID`) → required, so
 *   a misconfigured platform deploy never silently accepts unsigned payloads.
 * - `KEELSON_MODE` unset and no platform env → not required (zero-config local dev).
 * - Any other non-empty mode → required (fail closed on an unrecognized mode).
 */
export function webhookSignatureRequired(): boolean {
  const mode = getMode();
  if (mode === "keelson") return true;
  if (mode === "local") return false;
  if (mode === "") return isPlatformEnv();
  // Unrecognized mode: fail closed.
  return true;
}
