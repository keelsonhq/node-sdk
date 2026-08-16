import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveParityFixturesDir } from '../../test-fixtures.js';
import { del, list, read } from '../src/client.js';
import { FilesError } from '../src/config.js';
import { clearTokenCache, FakeGcs, REMOTE_ENV, withEnv } from './helpers.js';

function loadFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(
			resolve(resolveParityFixturesDir(import.meta.url), name),
			'utf-8',
		),
	);
}

describe('parity fixtures', () => {
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

	it('list ordering + prefix stripping', async () => {
		const fx = loadFixture('files_list_ordering.json') as {
			files_prefix: string;
			object_names: string[];
			expected: string[];
		};
		for (const name of fx.object_names) fake.store.set(name, new Uint8Array(1));
		await withEnv(
			{ ...REMOTE_ENV, KEELSON_FILES_PREFIX: fx.files_prefix },
			async () => {
				expect(await list()).toEqual(fx.expected);
			},
		);
	});

	it('missing read + error statuses', async () => {
		const fx = loadFixture('files_missing_read.json') as {
			error_statuses: number[];
		};
		await withEnv(REMOTE_ENV, async () => {
			expect(await read('absent')).toBeNull();
			await expect(del('absent')).resolves.toBeUndefined();
			for (const status of fx.error_statuses) {
				fake.forceStatus.GET = status;
				await expect(read('k')).rejects.toThrow(FilesError);
			}
		});
	});
});
