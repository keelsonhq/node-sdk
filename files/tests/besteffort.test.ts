/**
 * The opted-in best-effort (path-based) local backend.
 *
 * It is selected only on a non-Linux platform with no working descriptor
 * portal, so it is forced here via the strategy seam and exercised on Linux.
 * That measures the backend's own logic — the same functional contract and the
 * same non-racing confinement rejections as the portal backend. It does NOT
 * measure the check-then-act windows that make this backend "best effort"; by
 * construction those cannot be closed without a `dir_fd`.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { del, list, read, write } from '../src/client.js';
import { FilesError } from '../src/config.js';
import { setLocalStrategyForTests } from '../src/localstrategy.js';
import { withEnv } from './helpers.js';

const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

describe('best-effort local backend', () => {
	let root: string;
	let dir: string;
	let env: Record<string, string | undefined>;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'keelson-files-be-'));
		dir = join(root, 'files');
		env = { KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir };
		// `noFollowAny: 0` is the honest default: no whole-path flag is available
		// on this host, which is also the worst case the fallback must handle.
		setLocalStrategyForTests(async () => ({
			kind: 'besteffort',
			noFollowAny: 0,
		}));
	});

	afterEach(async () => {
		setLocalStrategyForTests(null);
		await rm(root, { recursive: true, force: true });
	});

	it('write/read round-trips a string as UTF-8', async () => {
		await withEnv(env, async () => {
			await write('u.txt', '日本語');
			expect(await read('u.txt')).toEqual(new TextEncoder().encode('日本語'));
		});
	});

	it('write/read round-trips bytes', async () => {
		await withEnv(env, async () => {
			await write('b.bin', new Uint8Array([0, 1, 2]));
			expect(await read('b.bin')).toEqual(new Uint8Array([0, 1, 2]));
		});
	});

	it('overwrites in place', async () => {
		await withEnv(env, async () => {
			await write('state', 'one');
			await write('state', 'two');
			expect(dec(await read('state'))).toBe('two');
		});
	});

	it('read of a missing key returns null', async () => {
		await withEnv(env, async () => {
			expect(await read('nope')).toBeNull();
		});
	});

	it('creates nested parent directories', async () => {
		await withEnv(env, async () => {
			await write('cache/hn/latest.json', '{}');
			expect(dec(await read('cache/hn/latest.json'))).toBe('{}');
		});
	});

	it('delete is idempotent', async () => {
		await withEnv(env, async () => {
			await write('x', '1');
			await del('x');
			expect(await read('x')).toBeNull();
			await expect(del('x')).resolves.toBeUndefined();
		});
	});

	it('list is recursive, prefix-filtered and lexicographically sorted', async () => {
		await withEnv(env, async () => {
			await write('b.txt', 'b');
			await write('a.txt', 'a');
			await write('cache/z.json', 'z');
			await write('cache/a.json', 'a');
			expect(await list()).toEqual([
				'a.txt',
				'b.txt',
				'cache/a.json',
				'cache/z.json',
			]);
			expect(await list('cache/')).toEqual(['cache/a.json', 'cache/z.json']);
		});
	});

	it('list on an empty/missing dir returns []', async () => {
		await withEnv(env, async () => {
			expect(await list()).toEqual([]);
		});
	});

	it('read of a key shadowed by a directory is missing (null)', async () => {
		await withEnv(env, async () => {
			await write('cache/item', 'child');
			expect(await read('cache')).toBeNull();
		});
	});

	it('delete of a key shadowed by a directory is an idempotent no-op', async () => {
		await withEnv(env, async () => {
			await write('cache/item', 'child');
			await expect(del('cache')).resolves.toBeUndefined();
			expect(dec(await read('cache/item'))).toBe('child');
		});
	});

	it('reports both key/nested-key collision orders as a clear error', async () => {
		await withEnv(env, async () => {
			await write('cache/item', 'child');
			await expect(write('cache', 'parent')).rejects.toThrow(
				/collides with a nested key/,
			);
			await write('flat', 'v');
			await expect(write('flat/child', 'x')).rejects.toThrow(
				/collides with a nested key/,
			);
			expect(dec(await read('cache/item'))).toBe('child');
			expect(dec(await read('flat'))).toBe('v');
		});
	});

	it('leaves no temp artifact when a write fails', async () => {
		await withEnv(env, async () => {
			await write('cache/item', 'child');
			await expect(write('cache', 'parent')).rejects.toThrow(FilesError);
			async function anyTemp(d: string): Promise<boolean> {
				for (const e of await readdir(d, { withFileTypes: true })) {
					if (e.name.startsWith('\x01')) return true;
					if (e.isDirectory() && (await anyTemp(join(d, e.name)))) return true;
				}
				return false;
			}
			expect(await anyTemp(dir)).toBe(false);
		});
	});

	it('rejects a symlinked ancestor rather than writing outside the files dir', async () => {
		const { symlink, mkdir: mkdirp } = await import('node:fs/promises');
		const outside = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				await symlink(outside, join(dir, 'escape'), 'dir');
				await expect(write('escape/pwned', 'x')).rejects.toThrow(FilesError);
				expect(await readdir(outside)).toEqual([]);
			});
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it('read does not follow a symlinked key file', async () => {
		const {
			symlink,
			mkdir: mkdirp,
			writeFile,
		} = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		const secret = join(outsideRoot, 'secret');
		await writeFile(secret, 'secret-outside');
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				await symlink(secret, join(dir, 'leak'));
				await expect(read('leak')).rejects.toThrow(FilesError);
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('read does not follow a symlinked ancestor', async () => {
		const {
			symlink,
			mkdir: mkdirp,
			writeFile,
		} = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		await writeFile(join(outsideRoot, 'secret'), 'outside-secret');
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				await symlink(outsideRoot, join(dir, 'safe'), 'dir');
				await expect(read('safe/secret')).rejects.toThrow(FilesError);
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('delete through a symlinked ancestor is a no-op, not an external unlink', async () => {
		const {
			symlink,
			mkdir: mkdirp,
			writeFile,
			stat,
		} = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		await writeFile(join(outsideRoot, 'secret'), 'outside-secret');
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				await symlink(outsideRoot, join(dir, 'safe'), 'dir');
				await expect(del('safe/secret')).resolves.toBeUndefined();
				await expect(stat(join(outsideRoot, 'secret'))).resolves.toBeDefined();
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('list does not follow or surface symlinks', async () => {
		const {
			symlink,
			mkdir: mkdirp,
			writeFile,
		} = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		try {
			await withEnv(env, async () => {
				await write('real', 'v');
				const planted = join(outsideRoot, 'planted');
				await mkdirp(planted, { recursive: true });
				await writeFile(join(planted, 'deep.json'), 'x');
				await symlink(planted, join(dir, 'linked'), 'dir');
				expect(await list()).toEqual(['real']);
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('tolerates a files dir reached through a symlinked ancestor', async () => {
		// macOS `os.tmpdir()` is behind /var → /private/var; the base is
		// realpath-ed so that must not be mistaken for an escape.
		const { symlink, mkdir: mkdirp } = await import('node:fs/promises');
		const real = join(root, 'real-files');
		await mkdirp(real, { recursive: true });
		const linked = join(root, 'linked-files');
		await symlink(real, linked, 'dir');
		await withEnv(
			{ ...env, KEELSON_FILES_DIR: join(linked, 'sub') },
			async () => {
				await write('a/b.txt', 'v');
				expect(dec(await read('a/b.txt'))).toBe('v');
				expect(await list()).toEqual(['a/b.txt']);
			},
		);
	});
});
