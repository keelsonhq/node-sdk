import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { del, list, read, write } from '../src/client.js';
import { FilesError } from '../src/config.js';
import { clearTokenCache, FakeGcs, REMOTE_ENV, withEnv } from './helpers.js';

describe('GCS (remote) backend', () => {
	let fake: FakeGcs;
	let restore: () => void;
	beforeEach(async () => {
		fake = new FakeGcs();
		restore = fake.install().restore;
		await clearTokenCache();
	});
	afterEach(() => {
		restore();
	});

	it('write stores under the injected object prefix', async () => {
		await withEnv(REMOTE_ENV, async () => {
			await write('seen.json', '[]');
			expect(fake.store.has('tenants/t/apps/a/files/seen.json')).toBe(true);
		});
	});

	it('write/read round-trips', async () => {
		await withEnv(REMOTE_ENV, async () => {
			await write('k', new Uint8Array([9, 8, 7]));
			expect(await read('k')).toEqual(new Uint8Array([9, 8, 7]));
		});
	});

	it('read of a missing object returns null (404)', async () => {
		await withEnv(REMOTE_ENV, async () => {
			expect(await read('absent')).toBeNull();
		});
	});

	it('delete is idempotent on a 404', async () => {
		await withEnv(REMOTE_ENV, async () => {
			await expect(del('absent')).resolves.toBeUndefined();
		});
	});

	it('delete removes the object', async () => {
		await withEnv(REMOTE_ENV, async () => {
			await write('k', 'v');
			await del('k');
			expect(fake.store.has('tenants/t/apps/a/files/k')).toBe(false);
		});
	});

	it('list strips the prefix and sorts', async () => {
		await withEnv(REMOTE_ENV, async () => {
			await write('b.txt', 'b');
			await write('a.txt', 'a');
			await write('cache/z.json', 'z');
			expect(await list()).toEqual(['a.txt', 'b.txt', 'cache/z.json']);
		});
	});

	it('list absorbs paging', async () => {
		await withEnv(REMOTE_ENV, async () => {
			fake.pageSize = 2;
			for (let i = 0; i < 5; i++) await write(`k${i}.txt`, String(i));
			expect(await list()).toEqual([
				'k0.txt',
				'k1.txt',
				'k2.txt',
				'k3.txt',
				'k4.txt',
			]);
		});
	});

	for (const status of [401, 403, 429, 500, 503]) {
		it(`treats ${status} as an error, not missing`, async () => {
			await withEnv(REMOTE_ENV, async () => {
				fake.forceStatus.GET = status;
				await expect(read('k')).rejects.toThrow(FilesError);
			});
		});
	}

	it('caches the ADC token across calls', async () => {
		await withEnv(REMOTE_ENV, async () => {
			await write('a', '1');
			await write('b', '2');
			await read('a');
			expect(fake.tokenFetches).toBe(1);
		});
	});

	it('enforces the size limit before uploading', async () => {
		await withEnv(REMOTE_ENV, async () => {
			await expect(
				write('big', new Uint8Array(10 * 1024 * 1024 + 1)),
			).rejects.toThrow(FilesError);
			expect(fake.store.size).toBe(0);
		});
	});

	it('wraps a malformed token response in FilesError', async () => {
		await withEnv(REMOTE_ENV, async () => {
			fake.badTokenJson = true;
			await expect(read('k')).rejects.toThrow(
				/malformed access-token response/,
			);
		});
	});

	it('wraps a malformed list response in FilesError', async () => {
		await withEnv(REMOTE_ENV, async () => {
			fake.badListJson = true;
			await expect(list()).rejects.toThrow(/malformed list response/);
		});
	});

	it('wraps a valid-JSON `null` token response in FilesError (not TypeError)', async () => {
		await withEnv(REMOTE_ENV, async () => {
			fake.nullTokenJson = true;
			await expect(read('k')).rejects.toThrow(FilesError);
		});
	});

	it('wraps a valid-JSON `null` list response in FilesError (not TypeError)', async () => {
		await withEnv(REMOTE_ENV, async () => {
			fake.nullListJson = true;
			await expect(list()).rejects.toThrow(FilesError);
		});
	});

	for (const body of [
		'null',
		'[]',
		'{"items": "not-an-array"}',
		'{"items": null}',
		'{"items": [null]}',
		'{"items": [{}]}',
		'{"items": [{"name": null}]}',
		'{"items": [{"name": 42}]}',
		'{"nextPageToken": null}',
		'{"nextPageToken": 5}',
	]) {
		it(`wraps valid-JSON wrong-schema list \`${body}\` in FilesError`, async () => {
			await withEnv(REMOTE_ENV, async () => {
				fake.listBody = body;
				await expect(list()).rejects.toThrow(FilesError);
			});
		});
	}

	it('percent-encodes the GCS object name (shared fixture)', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const { resolveParityFixturesDir } = await import('../../test-fixtures.js');
		const fx = JSON.parse(
			readFileSync(
				resolve(
					resolveParityFixturesDir(import.meta.url),
					'files_gcs_object_encoding.json',
				),
				'utf-8',
			),
		) as {
			files_prefix: string;
			key: string;
			object_name: string;
			encoded_object: string;
		};
		await withEnv(
			{ ...REMOTE_ENV, KEELSON_FILES_PREFIX: fx.files_prefix },
			async () => {
				await write(fx.key, 'v');
				expect(fake.store.has(fx.object_name)).toBe(true);
				expect(fake.calls.some((c) => c.url.includes(fx.encoded_object))).toBe(
					true,
				);
				expect(
					new TextDecoder().decode((await read(fx.key)) ?? undefined),
				).toBe('v');
			},
		);
	});
});
