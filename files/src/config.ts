/**
 * Configuration + mode resolution for the data-files `files` SDK.
 *
 * `KEELSON_MODE` is the single explicit mode signal shared across SDKs. The
 * remote GCS backend requires the platform-injected `KEELSON_FILES_BUCKET` and
 * `KEELSON_FILES_PREFIX`; authentication uses Application Default Credentials
 * through the GCE metadata server, so no authentication environment variable
 * is needed.
 *
 * Resolution (fail-closed — a Keelson deployment never silently writes to
 * ephemeral local disk):
 *
 * - `KEELSON_MODE=keelson` requires bucket + prefix + the platform identity
 *   (`KEELSON_APP_ID` / `KEELSON_TENANT_ID`); any missing → `FilesError`.
 * - Partial config (exactly one of bucket / prefix) → `FilesError`, any mode.
 * - `KEELSON_MODE=local` → local filesystem (`KEELSON_FILES_DIR`, default
 *   `./.keelson/files`).
 * - `KEELSON_MODE` unset → local (zero-config); the remote env is NOT consulted
 *   to infer remote. If a platform environment is visible the silent local
 *   fallback is refused (`FilesError`).
 * - Any other non-empty `KEELSON_MODE` → `FilesError`.
 */

export class FilesError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FilesError';
	}
}

/** Soft size limit for one object: 10 MiB. */
export const MAX_OBJECT_SIZE_BYTES = 10 * 1024 * 1024;

/** GCS JSON API base and GCE metadata token endpoint. The env overrides are
 * SDK-internal test seams (not part of the platform env contract). */
const DEFAULT_STORAGE_BASE = 'https://storage.googleapis.com';
const DEFAULT_METADATA_URL =
	'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export function getBucket(): string {
	return process.env.KEELSON_FILES_BUCKET?.trim() ?? '';
}

export function getFilesPrefix(): string {
	let prefix = process.env.KEELSON_FILES_PREFIX?.trim() ?? '';
	if (prefix && !prefix.endsWith('/')) prefix += '/';
	return prefix;
}

export function getFilesDir(): string {
	return process.env.KEELSON_FILES_DIR?.trim() || './.keelson/files';
}

/** Opt-in to the weaker path-based local backend on a platform with no working
 * descriptor-relative portal (see `localstrategy.ts`). Local-development escape
 * hatch only; it is never consulted in `KEELSON_MODE=keelson`. */
export function allowBestEffortLocal(): boolean {
	const raw = process.env.KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL?.trim() ?? '';
	return raw === '1' || raw.toLowerCase() === 'true';
}

export function getStorageBase(): string {
	return (
		process.env.KEELSON_FILES_STORAGE_BASE?.trim() || DEFAULT_STORAGE_BASE
	).replace(/\/+$/, '');
}

export function getMetadataUrl(): string {
	return process.env.KEELSON_FILES_METADATA_URL?.trim() || DEFAULT_METADATA_URL;
}

export function getMode(): string {
	return (process.env.KEELSON_MODE ?? '').trim().toLowerCase();
}

const CORE_IDENTIFIER_ENVS = [
	'KEELSON_APP_ID',
	'KEELSON_TENANT_ID',
	'KEELSON_DEPLOY_ID',
] as const;

export function isPlatformEnv(): boolean {
	return CORE_IDENTIFIER_ENVS.some((name) =>
		Boolean(process.env[name]?.trim()),
	);
}

/** True when the tenant + app identity that composes the prefix is present. */
export function hasIdentity(): boolean {
	return Boolean(
		process.env.KEELSON_APP_ID?.trim() && process.env.KEELSON_TENANT_ID?.trim(),
	);
}

export type ResolvedMode = 'remote' | 'local';

/**
 * `KEELSON_MODE` is the single mode signal; the storage backend is never
 * inferred from the presence of remote configuration.
 */
export function resolveMode(): ResolvedMode {
	const hasBucket = Boolean(getBucket());
	const hasPrefix = Boolean(getFilesPrefix());
	const mode = getMode();

	if (hasBucket !== hasPrefix) {
		const missing = hasBucket ? 'KEELSON_FILES_PREFIX' : 'KEELSON_FILES_BUCKET';
		throw new FilesError(
			`Incomplete remote Files configuration: both KEELSON_FILES_BUCKET and ` +
				`KEELSON_FILES_PREFIX are required, but ${missing} is missing.`,
		);
	}

	if (mode === 'keelson') {
		if (!(hasBucket && hasPrefix)) {
			throw new FilesError(
				'KEELSON_MODE=keelson but Files is not configured ' +
					'(KEELSON_FILES_BUCKET and KEELSON_FILES_PREFIX are unset); ' +
					'the Files capability is unavailable for this deployment.',
			);
		}
		if (!hasIdentity()) {
			throw new FilesError(
				'KEELSON_MODE=keelson but the platform identity is missing ' +
					'(KEELSON_APP_ID and KEELSON_TENANT_ID must be set); ' +
					'the Files capability is unavailable for this deployment.',
			);
		}
		return 'remote';
	}

	if (mode === 'local') return 'local';

	if (mode === '') {
		if (isPlatformEnv()) {
			throw new FilesError(
				'Platform environment detected ' +
					'(KEELSON_APP_ID / KEELSON_TENANT_ID / KEELSON_DEPLOY_ID set) but KEELSON_MODE is unset; ' +
					'refusing to fall back to local storage. Set KEELSON_MODE=local for local ' +
					'development or KEELSON_MODE=keelson for platform storage.',
			);
		}
		return 'local';
	}

	throw new FilesError(
		`Unrecognized KEELSON_MODE="${mode}"; expected "keelson" or "local" ` +
			'(or unset for local development).',
	);
}
