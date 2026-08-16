import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveParityFixturesDir } from '../../test-fixtures.js';
import { read, write } from '../src/client.js';
import { FilesError } from '../src/config.js';
import { setLocalStrategyForTests } from '../src/localstrategy.js';
import { withEnv } from './helpers.js';

const fixture = JSON.parse(
	readFileSync(
		resolve(
			resolveParityFixturesDir(import.meta.url),
			'files_key_validation.json',
		),
		'utf-8',
	),
) as {
	valid: string[];
	invalid: Array<{ key: string; reason: string }>;
};

describe('key validation (shared fixture)', () => {
	let root: string;
	let dir: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'keelson-files-keys-'));
		dir = join(root, 'files');
		if (process.platform !== 'linux') {
			setLocalStrategyForTests(async () => ({
				kind: 'besteffort',
				noFollowAny: 0,
			}));
		}
	});
	afterEach(async () => {
		setLocalStrategyForTests(null);
		await rm(root, { recursive: true, force: true });
	});

	for (const { key, reason } of fixture.invalid) {
		it(`rejects: ${reason}`, async () => {
			await withEnv(
				{ KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir },
				async () => {
					await expect(write(key, 'x')).rejects.toThrow(FilesError);
				},
			);
		});
	}

	it('accepts and round-trips every valid key', async () => {
		await withEnv(
			{ KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir },
			async () => {
				for (const key of fixture.valid) {
					await write(key, 'ok');
					expect(await read(key)).toEqual(new TextEncoder().encode('ok'));
				}
			},
		);
	});

	it('rejects a key over 512 UTF-8 bytes', async () => {
		await withEnv(
			{ KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir },
			async () => {
				await expect(write('a'.repeat(513), 'x')).rejects.toThrow(FilesError);
			},
		);
	});

	it('counts bytes not characters for multibyte keys', async () => {
		await withEnv(
			{ KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir },
			async () => {
				// 171 * 3 bytes = 513 bytes, but 171 chars.
				await expect(write('あ'.repeat(171), 'x')).rejects.toThrow(FilesError);
			},
		);
	});

	it('rejects keys with a lone surrogate (ill-formed UTF-8)', async () => {
		await withEnv(
			{ KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir },
			async () => {
				for (const bad of ['\ud800', 'a\udc00b', '\udfff']) {
					await expect(write(bad, 'x')).rejects.toThrow(FilesError);
				}
			},
		);
	});

	it('rejects C1 control characters (category Cc)', async () => {
		await withEnv(
			{ KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir },
			async () => {
				for (const bad of ['a\u0085b', 'a\u009fb']) {
					await expect(write(bad, 'x')).rejects.toThrow(FilesError);
				}
			},
		);
	});

	it('rejects a single segment over 255 UTF-8 bytes', async () => {
		await withEnv(
			{ KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir },
			async () => {
				await expect(write('a'.repeat(256), 'x')).rejects.toThrow(FilesError);
				// but a 255-byte segment is accepted.
				await expect(write('a'.repeat(255), 'x')).resolves.toBeUndefined();
			},
		);
	});
});
