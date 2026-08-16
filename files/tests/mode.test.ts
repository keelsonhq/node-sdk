import { describe, expect, it } from 'vitest';
import { FilesError, resolveMode } from '../src/config.js';
import { withEnv } from './helpers.js';

const CLEAN = {
	KEELSON_MODE: undefined,
	KEELSON_APP_ID: undefined,
	KEELSON_TENANT_ID: undefined,
	KEELSON_DEPLOY_ID: undefined,
	KEELSON_FILES_BUCKET: undefined,
	KEELSON_FILES_PREFIX: undefined,
} as const;

const REMOTE = {
	KEELSON_FILES_BUCKET: 'b',
	KEELSON_FILES_PREFIX: 'tenants/t/apps/a/files/',
	KEELSON_APP_ID: 'a',
	KEELSON_TENANT_ID: 't',
} as const;

function messageOf(fn: () => unknown): string | undefined {
	try {
		fn();
		return undefined;
	} catch (err) {
		return (err as Error).message;
	}
}

describe('resolveMode contract', () => {
	it('remote in KEELSON_MODE=keelson with both env', async () => {
		await withEnv({ ...CLEAN, KEELSON_MODE: 'keelson', ...REMOTE }, () => {
			expect(resolveMode()).toBe('remote');
		});
	});

	it('throws in keelson mode with missing env', async () => {
		await withEnv({ ...CLEAN, KEELSON_MODE: 'keelson' }, () => {
			expect(() => resolveMode()).toThrow(FilesError);
			expect(messageOf(resolveMode)).toContain('capability is unavailable');
		});
	});

	it('throws in keelson mode when the platform identity is missing', async () => {
		await withEnv(
			{
				...CLEAN,
				KEELSON_MODE: 'keelson',
				KEELSON_FILES_BUCKET: 'b',
				KEELSON_FILES_PREFIX: 'tenants/t/apps/a/files/',
			},
			() => {
				expect(messageOf(resolveMode)).toContain(
					'platform identity is missing',
				);
			},
		);
	});

	it('throws on partial config (only bucket)', async () => {
		await withEnv({ ...CLEAN, KEELSON_FILES_BUCKET: 'b' }, () => {
			expect(messageOf(resolveMode)).toContain(
				'KEELSON_FILES_PREFIX is missing',
			);
		});
	});

	it('throws on partial config (only prefix) even in local mode', async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'local', KEELSON_FILES_PREFIX: 'p/' },
			() => {
				expect(messageOf(resolveMode)).toContain(
					'KEELSON_FILES_BUCKET is missing',
				);
			},
		);
	});

	it('local for explicit local mode even with platform env', async () => {
		await withEnv(
			{ ...CLEAN, KEELSON_MODE: 'local', KEELSON_APP_ID: 'app_1' },
			() => {
				expect(resolveMode()).toBe('local');
			},
		);
	});

	it('local for zero-config development', async () => {
		await withEnv({ ...CLEAN }, () => {
			expect(resolveMode()).toBe('local');
		});
	});

	for (const v of [
		'KEELSON_APP_ID',
		'KEELSON_TENANT_ID',
		'KEELSON_DEPLOY_ID',
	]) {
		it(`refuses local fallback when ${v} visible`, async () => {
			await withEnv({ ...CLEAN, [v]: 'x' }, () => {
				expect(messageOf(resolveMode)).toContain('refusing to fall back');
			});
		});
	}

	it('local when unset mode even with the remote env present (mode is the only signal)', async () => {
		// bucket/prefix present but no platform env and no KEELSON_MODE →
		// zero-config local; the remote env is NOT consulted to infer remote.
		await withEnv(
			{
				...CLEAN,
				KEELSON_FILES_BUCKET: 'b',
				KEELSON_FILES_PREFIX: 'tenants/t/apps/a/files/',
			},
			() => {
				expect(resolveMode()).toBe('local');
			},
		);
	});

	it('throws on an unrecognized mode', async () => {
		await withEnv({ ...CLEAN, KEELSON_MODE: 'production' }, () => {
			expect(messageOf(resolveMode)).toContain('Unrecognized KEELSON_MODE');
		});
	});
});
