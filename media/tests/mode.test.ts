/**
 * Runtime-mode contract tests for the Media SDK.
 *
 * These assert the fail-closed behaviour: on Keelson the SDK must never
 * silently fall back to local/ephemeral filesystem storage when the platform
 * Media configuration is missing, incomplete, or the mode is unrecognized.
 *
 * Fixed-contract error messages are asserted verbatim (exact match).
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withEnv } from './helpers.js';

// Base env that clears every var the mode resolver consults, so each test
// starts from a known-clean slate and only sets what it needs.
const CLEAN = {
	KEELSON_MODE: undefined,
	KEELSON_APP_ID: undefined,
	KEELSON_TENANT_ID: undefined,
	KEELSON_DEPLOY_ID: undefined,
	KEELSON_INTERNAL_MEDIA_BASE_URL: undefined,
	KEELSON_APP_MEDIA_TOKEN: undefined,
} as const;

// Fixed-contract error messages (must match src/config.ts verbatim).
const MSG = {
	partialMissingBase:
		'Incomplete remote Media configuration: both KEELSON_INTERNAL_MEDIA_BASE_URL and ' +
		'KEELSON_APP_MEDIA_TOKEN are required, but KEELSON_INTERNAL_MEDIA_BASE_URL is missing.',
	partialMissingToken:
		'Incomplete remote Media configuration: both KEELSON_INTERNAL_MEDIA_BASE_URL and ' +
		'KEELSON_APP_MEDIA_TOKEN are required, but KEELSON_APP_MEDIA_TOKEN is missing.',
	keelsonUnavailable:
		'KEELSON_MODE=keelson but Media is not configured ' +
		'(KEELSON_INTERNAL_MEDIA_BASE_URL and KEELSON_APP_MEDIA_TOKEN are unset); ' +
		'the Media capability is unavailable for this deployment.',
	refuseFallback:
		'Platform environment detected ' +
		'(KEELSON_APP_ID / KEELSON_TENANT_ID / KEELSON_DEPLOY_ID set) but Media is not configured; ' +
		'refusing to fall back to local storage. Set KEELSON_MODE=local for local development.',
	unknownMode: (mode: string) =>
		`Unrecognized KEELSON_MODE="${mode}"; expected "keelson" or "local" ` +
		'(or unset for local development).',
} as const;

/** Capture the thrown error's message (or undefined if nothing thrown). */
function messageOf(fn: () => unknown): string | undefined {
	try {
		fn();
		return undefined;
	} catch (err) {
		return (err as Error).message;
	}
}

const REMOTE_ENV = {
	KEELSON_INTERNAL_MEDIA_BASE_URL: 'http://media.example:8080',
	KEELSON_APP_MEDIA_TOKEN: 'tok',
} as const;

describe('resolveMode contract', () => {
	it("returns 'remote' in KEELSON_MODE=keelson with both Media env set", async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'keelson', ...REMOTE_ENV },
			async () => {
				const { resolveMode } = await import('../src/config.js');
				expect(resolveMode()).toBe('remote');
			},
		);
	});

	it('throws in KEELSON_MODE=keelson when Media env missing (exact message)', async () => {
		await withEnv({ ...CLEAN, KEELSON_MODE: 'keelson' }, async () => {
			const { resolveMode, MediaError } = await import('../src/config.js');
			expect(() => resolveMode()).toThrow(MediaError);
			expect(messageOf(() => resolveMode())).toBe(MSG.keelsonUnavailable);
		});
	});

	it('throws on partial config (only base URL) — exact message, any mode', async () => {
		await withEnv(
			{
				...CLEAN,
				KEELSON_INTERNAL_MEDIA_BASE_URL: 'http://media.example:8080',
			},
			async () => {
				const { resolveMode } = await import('../src/config.js');
				expect(messageOf(() => resolveMode())).toBe(MSG.partialMissingToken);
			},
		);
	});

	it('throws on partial config (only token) even in explicit local mode', async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'local', KEELSON_APP_MEDIA_TOKEN: 'tok' },
			async () => {
				const { resolveMode } = await import('../src/config.js');
				expect(messageOf(() => resolveMode())).toBe(MSG.partialMissingBase);
			},
		);
	});

	it("returns 'local' for explicit KEELSON_MODE=local even with platform env", async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'local', KEELSON_APP_ID: 'app_123' },
			async () => {
				const { resolveMode } = await import('../src/config.js');
				expect(resolveMode()).toBe('local');
			},
		);
	});

	it("returns 'local' for zero-config local development (no platform env)", async () => {
		await withEnv({ ...CLEAN }, async () => {
			const { resolveMode } = await import('../src/config.js');
			expect(resolveMode()).toBe('local');
		});
	});

	it('refuses local fallback when KEELSON_APP_ID visible (exact message)', async () => {
		await withEnv({ ...CLEAN, KEELSON_APP_ID: 'app_123' }, async () => {
			const { resolveMode } = await import('../src/config.js');
			expect(messageOf(() => resolveMode())).toBe(MSG.refuseFallback);
		});
	});

	it('refuses local fallback when only KEELSON_TENANT_ID visible', async () => {
		await withEnv({ ...CLEAN, KEELSON_TENANT_ID: 'tnt_1' }, async () => {
			const { resolveMode } = await import('../src/config.js');
			expect(messageOf(() => resolveMode())).toBe(MSG.refuseFallback);
		});
	});

	it('refuses local fallback when only KEELSON_DEPLOY_ID visible', async () => {
		await withEnv({ ...CLEAN, KEELSON_DEPLOY_ID: 'dpl_1' }, async () => {
			const { resolveMode } = await import('../src/config.js');
			expect(messageOf(() => resolveMode())).toBe(MSG.refuseFallback);
		});
	});

	it('throws on an unrecognized KEELSON_MODE (exact message)', async () => {
		await withEnv({ ...CLEAN, KEELSON_MODE: 'typo' }, async () => {
			const { resolveMode } = await import('../src/config.js');
			expect(messageOf(() => resolveMode())).toBe(MSG.unknownMode('typo'));
		});
	});

	it('throws on an unrecognized KEELSON_MODE even with valid Media env', async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'production', ...REMOTE_ENV },
			async () => {
				const { resolveMode } = await import('../src/config.js');
				expect(messageOf(() => resolveMode())).toBe(
					MSG.unknownMode('production'),
				);
			},
		);
	});

	it("returns 'remote' when unset mode but both Media env present (compat)", async () => {
		await withEnv({ ...CLEAN, ...REMOTE_ENV }, async () => {
			const { resolveMode } = await import('../src/config.js');
			expect(resolveMode()).toBe('remote');
		});
	});
});

describe('url() fail-closed parity', () => {
	it('throws in KEELSON_MODE=keelson when Media disabled/missing', async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'keelson', KEELSON_APP_ID: 'app_123' },
			async () => {
				const { url } = await import('../src/client.js');
				expect(messageOf(() => url('01ABC'))).toBe(MSG.keelsonUnavailable);
			},
		);
	});

	it('returns the path in explicit local mode', async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'local', KEELSON_MEDIA_URL_PREFIX: undefined },
			async () => {
				const { url } = await import('../src/client.js');
				expect(url('01ABC')).toBe('/media/01ABC');
			},
		);
	});

	it('returns the path in remote mode', async () => {
		await withEnv(
			{
				...CLEAN,
				KEELSON_MODE: 'keelson',
				...REMOTE_ENV,
				KEELSON_MEDIA_URL_PREFIX: undefined,
			},
			async () => {
				const { url } = await import('../src/client.js');
				expect(url('01ABC')).toBe('/media/01ABC');
			},
		);
	});
});

describe('put fail-closed', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'keelson-files-mode-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('KEELSON_MODE=keelson + missing env does not create a local file', async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'keelson', MEDIA_DIR: tmpDir },
			async () => {
				const { put } = await import('../src/client.js');
				const { MediaError } = await import('../src/config.js');
				await expect(put(Buffer.from('data'))).rejects.toThrow(MediaError);
				const entries = await readdir(tmpDir);
				expect(entries).toHaveLength(0);
			},
		);
	});
});
