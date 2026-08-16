import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { del, list, read, write } from '../src/client.js';
import { FilesError, MAX_OBJECT_SIZE_BYTES } from '../src/config.js';
import {
	resolveLocalStrategy,
	setLocalStrategyForTests,
} from '../src/localstrategy.js';
import { withEnv } from './helpers.js';

const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

// The descriptor-portal backend is Linux-specific. Functional coverage for
// other POSIX hosts lives in besteffort.test.ts.
describe.skipIf(process.platform !== 'linux')('local backend', () => {
	let root: string;
	let dir: string;
	let env: Record<string, string | undefined>;
	beforeEach(async () => {
		// Nest the files dir under a disposable root for clean teardown.
		root = await mkdtemp(join(tmpdir(), 'keelson-files-local-'));
		dir = join(root, 'files');
		env = { KEELSON_MODE: 'local', KEELSON_FILES_DIR: dir };
	});
	afterEach(async () => {
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

	it('list is recursive and lexicographically sorted', async () => {
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
		});
	});

	it('list filters by prefix', async () => {
		await withEnv(env, async () => {
			await write('a.txt', 'a');
			await write('cache/z.json', 'z');
			expect(await list('cache/')).toEqual(['cache/z.json']);
		});
	});

	it('list on an empty/missing dir returns []', async () => {
		await withEnv(env, async () => {
			expect(await list()).toEqual([]);
		});
	});

	it('stores the key as a literal file with no temp artifact', async () => {
		await withEnv(env, async () => {
			await write('data.json', 'x');
			// The key is a literal file path so local data remains easy to inspect.
			expect((await stat(join(dir, 'data.json'))).isFile()).toBe(true);
			expect(await readdir(dir)).toEqual(['data.json']);
			expect(await list()).toEqual(['data.json']);
		});
	});

	it('a temp-looking key is a real key and appears in list', async () => {
		await withEnv(env, async () => {
			await write('.keelson-tmp-user-state', 'v');
			expect(dec(await read('.keelson-tmp-user-state'))).toBe('v');
			expect(await list()).toEqual(['.keelson-tmp-user-state']);
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

	it('write parent over a child directory is a clear error', async () => {
		await withEnv(env, async () => {
			await write('cache/item', 'child');
			await expect(write('cache', 'parent')).rejects.toThrow(
				/collides with a nested key/,
			);
			expect(dec(await read('cache/item'))).toBe('child');
		});
	});

	it('write child under a parent file is a clear error', async () => {
		await withEnv(env, async () => {
			await write('cache', 'parent');
			await expect(write('cache/item', 'child')).rejects.toThrow(
				/collides with a nested key/,
			);
			expect(dec(await read('cache'))).toBe('parent');
		});
	});

	it('leaves no temp artifact when a write fails', async () => {
		// A failed write (here a directory collision that fails the rename) must
		// unlink its temp file — the shared cleanup covers write/close/rename.
		const { readdir: rd } = await import('node:fs/promises');
		await withEnv(env, async () => {
			await write('cache/item', 'child'); // makes `cache` a directory
			await expect(write('cache', 'parent')).rejects.toThrow(FilesError);
			// No control-char temp file remains anywhere under the files dir.
			async function anyTemp(d: string): Promise<boolean> {
				for (const e of await rd(d, { withFileTypes: true })) {
					if (e.name.startsWith('\x01')) return true;
					if (e.isDirectory() && (await anyTemp(join(d, e.name)))) return true;
				}
				return false;
			}
			expect(await anyTemp(dir)).toBe(false);
		});
	});

	it('rejects a symlink-ancestor escape', async () => {
		const { symlink, mkdir: mkdirp } = await import('node:fs/promises');
		const outside = await mkdtemp(join(tmpdir(), 'keelson-files-outside-'));
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				try {
					await symlink(outside, join(dir, 'escape'), 'dir');
				} catch {
					return; // platform without symlink support
				}
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
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-ext-'));
		const secret = join(outsideRoot, 'secret-outside');
		await writeFile(secret, 'secret-outside');
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				try {
					await symlink(secret, join(dir, 'leak'));
				} catch {
					return; // platform without symlink support
				}
				await expect(read('leak')).rejects.toThrow(FilesError);
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('list does not follow symlinked directories', async () => {
		const {
			symlink,
			mkdir: mkdirp,
			writeFile,
		} = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-ext-'));
		try {
			await withEnv(env, async () => {
				await write('real', 'v');
				const planted = join(outsideRoot, 'planted');
				await mkdirp(planted, { recursive: true });
				await writeFile(join(planted, 'deep.json'), 'x');
				try {
					await symlink(planted, join(dir, 'linked'), 'dir');
				} catch {
					return; // platform without symlink support
				}
				expect(await list()).toEqual(['real']);
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('confines read/write/delete when an ancestor is swapped to a symlink', async () => {
		// TOCTOU: an ancestor directory swapped to an external symlink after a
		// key was written must not let any op escape the files dir.
		const {
			symlink,
			mkdir: mkdirp,
			writeFile,
			rm: rmp,
			stat: statp,
		} = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-ext-'));
		const outside = join(outsideRoot, 'outside');
		await mkdirp(outside, { recursive: true });
		await writeFile(join(outside, 'secret'), 'outside-secret');
		try {
			await withEnv(env, async () => {
				await write('safe/secret', 'inside');
				await rmp(join(dir, 'safe'), { recursive: true, force: true });
				try {
					await symlink(outside, join(dir, 'safe'), 'dir');
				} catch {
					return; // platform without symlink support
				}
				// read must not return the external content.
				const leaked = await read('safe/secret').catch(() => null);
				expect(leaked ? dec(leaked) : null).not.toBe('outside-secret');
				// write must not create files outside the files dir.
				await write('safe/planted', 'x').catch(() => {});
				await expect(statp(join(outside, 'planted'))).rejects.toThrow();
				// delete must not remove the external file.
				await del('safe/secret').catch(() => {});
				await expect(statp(join(outside, 'secret'))).resolves.toBeDefined();
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('rejects an oversize object', async () => {
		await withEnv(env, async () => {
			await expect(
				write('big', new Uint8Array(MAX_OBJECT_SIZE_BYTES + 1)),
			).rejects.toThrow(FilesError);
		});
	});

	it('fails closed when no local backend is available', async () => {
		// Inject platform-dependent inputs to exercise the non-Linux fail-closed
		// branch through the public API: no portal works and the best-effort opt-in
		// is absent.
		setLocalStrategyForTests(() =>
			resolveLocalStrategy({
				platform: 'darwin',
				allowBestEffort: false,
				probePortal: async () => false,
			}),
		);
		try {
			await withEnv(env, async () => {
				await expect(write('k', 'v')).rejects.toThrow(FilesError);
				await expect(read('k')).rejects.toThrow(
					/KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL/,
				);
				await expect(del('k')).rejects.toThrow(FilesError);
				await expect(list()).rejects.toThrow(FilesError);
			});
		} finally {
			setLocalStrategyForTests(null);
		}
	});

	it('uses a non-/proc portal when that is what resolves', async () => {
		// `/dev/fd` is a real portal spelling and is commonly a symlink to
		// /proc/self/fd on Linux. This verifies that the backend uses the selected
		// portal rather than hard-coding /proc.
		setLocalStrategyForTests(async () => ({
			kind: 'portal',
			portal: '/dev/fd',
		}));
		try {
			await withEnv(env, async () => {
				await write('cache/a.json', 'v');
				expect(dec(await read('cache/a.json'))).toBe('v');
				expect(await list()).toEqual(['cache/a.json']);
				await del('cache/a.json');
				expect(await read('cache/a.json')).toBeNull();
			});
		} finally {
			setLocalStrategyForTests(null);
		}
	});
});
