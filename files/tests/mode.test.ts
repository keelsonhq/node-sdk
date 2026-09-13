import { describe, expect, it } from 'vitest';
import { FilesError, resolveMode } from '../src/config.js';
import { withEnv } from './helpers.js';

const CLEAN = {
	KEELSON_MODE: undefined,
	KEELSON_APP_ID: undefined,
	KEELSON_WORKSPACE_ID: undefined,
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

const MISSING_IDENTITY_MESSAGE =
	'KEELSON_MODE=keelson but the platform identity is missing ' +
	'(KEELSON_APP_ID and KEELSON_WORKSPACE_ID must be set; ' +
	'KEELSON_TENANT_ID remains a deprecated alias); ' +
	'the Files capability is unavailable for this deployment.';
const REFUSE_FALLBACK_MESSAGE =
	'Platform environment detected ' +
	'(KEELSON_APP_ID / KEELSON_WORKSPACE_ID (or deprecated KEELSON_TENANT_ID alias) / ' +
	'KEELSON_DEPLOY_ID set) but KEELSON_MODE is unset; ' +
	'refusing to fall back to local storage. Set KEELSON_MODE=local for local ' +
	'development or KEELSON_MODE=keelson for platform storage.';

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

	it('remote in KEELSON_MODE=keelson with workspace identity', async () => {
		await withEnv(
			{
				...CLEAN,
				KEELSON_MODE: 'keelson',
				...REMOTE,
				KEELSON_WORKSPACE_ID: 'w',
				KEELSON_TENANT_ID: undefined,
			},
			() => {
				expect(resolveMode()).toBe('remote');
			},
		);
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
				expect(messageOf(resolveMode)).toBe(MISSING_IDENTITY_MESSAGE);
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
		'KEELSON_WORKSPACE_ID',
		'KEELSON_TENANT_ID',
		'KEELSON_DEPLOY_ID',
	]) {
		it(`refuses local fallback when ${v} visible`, async () => {
			await withEnv({ ...CLEAN, [v]: 'x' }, () => {
				expect(messageOf(resolveMode)).toBe(REFUSE_FALLBACK_MESSAGE);
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
