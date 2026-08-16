/**
 * Configuration helpers — reads from environment variables injected
 * by Keelson at deploy time.
 *
 * The SDK resolves its storage mode from `KEELSON_MODE` plus the platform
 * Media env (`KEELSON_INTERNAL_MEDIA_BASE_URL` / `KEELSON_APP_MEDIA_TOKEN`):
 *
 * - `KEELSON_MODE=keelson` requires both Media env values. If either is
 *   missing, storage operations throw a `MediaError` instead of silently
 *   writing to the local filesystem — a misconfiguration or a disabled
 *   Media capability fails closed rather than surfacing later as data loss.
 * - An incomplete remote config (exactly one of base URL / token) is an
 *   error regardless of mode.
 * - `KEELSON_MODE=local` uses the local `MEDIA_DIR` (default `./media`).
 * - When `KEELSON_MODE` is unset (local development), the SDK uses the
 *   internal API if both Media env values are present, otherwise local
 *   storage — but refuses that fallback when a platform environment is
 *   detected (any of `KEELSON_APP_ID` / `KEELSON_TENANT_ID` /
 *   `KEELSON_DEPLOY_ID` set), to avoid silent ephemeral writes.
 * - Any other non-empty `KEELSON_MODE` is a configuration error.
 */

export class MediaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MediaError';
	}
}

export function getInternalBaseUrl(): string {
	return process.env.KEELSON_INTERNAL_MEDIA_BASE_URL?.trim() ?? '';
}

export function getMediaToken(): string {
	return process.env.KEELSON_APP_MEDIA_TOKEN?.trim() ?? '';
}

export function getMediaDir(): string {
	return process.env.MEDIA_DIR?.trim() || './media';
}

export function getUrlPrefix(): string {
	let prefix = process.env.KEELSON_MEDIA_URL_PREFIX?.trim() || '/media/';
	if (!prefix.startsWith('/')) prefix = '/' + prefix;
	if (!prefix.endsWith('/')) prefix += '/';
	return prefix;
}

/** Normalized `KEELSON_MODE` value (lower-cased, trimmed); "" when unset. */
export function getMode(): string {
	return (process.env.KEELSON_MODE ?? '').trim().toLowerCase();
}

/**
 * Platform-owned core env vars whose presence signals the app is running on
 * Keelson and activates fail-closed behavior.
 */
const CORE_IDENTIFIER_ENVS = [
	'KEELSON_APP_ID',
	'KEELSON_TENANT_ID',
	'KEELSON_DEPLOY_ID',
] as const;

/** True when any platform-owned core identifier is visible (running on Keelson). */
export function isPlatformEnv(): boolean {
	return CORE_IDENTIFIER_ENVS.some((name) =>
		Boolean(process.env[name]?.trim()),
	);
}

/**
 * True when both Media env vars are set. Kept for backward compatibility;
 * prefer {@link resolveMode} for storage decisions since it enforces the
 * fail-closed runtime-mode contract.
 */
export function isKeelsonEnv(): boolean {
	return Boolean(getInternalBaseUrl() && getMediaToken());
}

export type ResolvedMode = 'remote' | 'local';

/**
 * Resolve the storage mode, throwing `MediaError` on a misconfigured or
 * fail-closed platform deployment. See the module docs for the contract.
 */
export function resolveMode(): ResolvedMode {
	const hasBase = Boolean(getInternalBaseUrl());
	const hasToken = Boolean(getMediaToken());
	const mode = getMode();

	// Partial remote configuration is always an error, regardless of mode.
	if (hasBase !== hasToken) {
		const missing = hasBase
			? 'KEELSON_APP_MEDIA_TOKEN'
			: 'KEELSON_INTERNAL_MEDIA_BASE_URL';
		throw new MediaError(
			`Incomplete remote Media configuration: both KEELSON_INTERNAL_MEDIA_BASE_URL and ` +
				`KEELSON_APP_MEDIA_TOKEN are required, but ${missing} is missing.`,
		);
	}

	if (mode === 'keelson') {
		if (hasBase && hasToken) return 'remote';
		throw new MediaError(
			'KEELSON_MODE=keelson but Media is not configured ' +
				'(KEELSON_INTERNAL_MEDIA_BASE_URL and KEELSON_APP_MEDIA_TOKEN are unset); ' +
				'the Media capability is unavailable for this deployment.',
		);
	}

	if (mode === 'local') {
		// Explicit local development mode: always use the local filesystem.
		return 'local';
	}

	if (mode === '') {
		// KEELSON_MODE unset — local development / backward compatibility.
		if (hasBase && hasToken) return 'remote';
		if (isPlatformEnv()) {
			throw new MediaError(
				'Platform environment detected ' +
					'(KEELSON_APP_ID / KEELSON_TENANT_ID / KEELSON_DEPLOY_ID set) but Media is not configured; ' +
					'refusing to fall back to local storage. Set KEELSON_MODE=local for local development.',
			);
		}
		return 'local';
	}

	// Any other non-empty KEELSON_MODE is a misconfiguration; fail closed
	// rather than treating an unknown mode as local development.
	throw new MediaError(
		`Unrecognized KEELSON_MODE="${mode}"; expected "keelson" or "local" ` +
			'(or unset for local development).',
	);
}
