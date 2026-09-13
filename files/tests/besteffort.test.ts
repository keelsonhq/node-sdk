/**
 * The path-based local-development backend.
 *
 * It is selected only on a non-Linux platform with no working descriptor
 * portal, so it is forced here via the strategy seam and exercised on Linux.
 * That measures the backend's own logic — the same functional contract and the
 * same non-racing confinement rejections as the portal backend. It does NOT
 * measure the check-then-act windows that make this backend "best effort"; by
 * construction those cannot be closed without a `dir_fd`.
 */

import { execFile, spawn } from 'node:child_process';
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { del, list, read, write } from '../src/client.js';
import { FilesError } from '../src/config.js';
import { setLocalStrategyForTests } from '../src/localstrategy.js';
import { withEnv } from './helpers.js';

const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const execFileAsync = promisify(execFile);

async function linkDirectory(target: string, path: string): Promise<void> {
	const { symlink } = await import('node:fs/promises');
	await symlink(
		target,
		path,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
}

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

	it('concurrent readers never observe a partial replacement', async () => {
		await withEnv(env, async () => {
			const a = 'a'.repeat(64 * 1024);
			const b = 'b'.repeat(64 * 1024);
			await write('state', a);
			const writer = (async () => {
				for (let i = 0; i < 30; i++) await write('state', i % 2 ? a : b);
			})();
			const reader = (async () => {
				for (let i = 0; i < 100; i++) {
					const value = dec(await read('state'));
					expect(value === a || value === b).toBe(true);
				}
			})();
			await Promise.all([writer, reader]);
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
					if (
						e.name.startsWith('\x01') ||
						/^\.keelson-tmp-[0-9a-f]{24}$/.test(e.name)
					)
						return true;
					if (e.isDirectory() && (await anyTemp(join(d, e.name)))) return true;
				}
				return false;
			}
			expect(await anyTemp(dir)).toBe(false);
		});
	});

	it('rejects a symlinked ancestor rather than writing outside the files dir', async () => {
		const { mkdir: mkdirp } = await import('node:fs/promises');
		const outside = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				await linkDirectory(outside, join(dir, 'escape'));
				await expect(write('escape/pwned', 'x')).rejects.toThrow(FilesError);
				expect(await readdir(outside)).toEqual([]);
			});
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === 'win32')(
		'read does not follow a symlinked key file',
		async () => {
			const {
				symlink,
				mkdir: mkdirp,
				writeFile,
			} = await import('node:fs/promises');
			const outsideRoot = await mkdtemp(
				join(tmpdir(), 'keelson-files-be-out-'),
			);
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
		},
	);

	it('read does not follow a symlinked ancestor', async () => {
		const { mkdir: mkdirp, writeFile } = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		await writeFile(join(outsideRoot, 'secret'), 'outside-secret');
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				await linkDirectory(outsideRoot, join(dir, 'safe'));
				await expect(read('safe/secret')).rejects.toThrow(FilesError);
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('delete through a symlinked ancestor is a no-op, not an external unlink', async () => {
		const { mkdir: mkdirp, writeFile, stat } = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		await writeFile(join(outsideRoot, 'secret'), 'outside-secret');
		try {
			await withEnv(env, async () => {
				await mkdirp(dir, { recursive: true });
				await linkDirectory(outsideRoot, join(dir, 'safe'));
				await expect(del('safe/secret')).resolves.toBeUndefined();
				await expect(stat(join(outsideRoot, 'secret'))).resolves.toBeDefined();
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it('list does not follow or surface symlinks', async () => {
		const { mkdir: mkdirp, writeFile } = await import('node:fs/promises');
		const outsideRoot = await mkdtemp(join(tmpdir(), 'keelson-files-be-out-'));
		try {
			await withEnv(env, async () => {
				await write('real', 'v');
				const planted = join(outsideRoot, 'planted');
				await mkdirp(planted, { recursive: true });
				await writeFile(join(planted, 'deep.json'), 'x');
				await linkDirectory(planted, join(dir, 'linked'));
				expect(await list()).toEqual(['real']);
			});
		} finally {
			await rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === 'win32')(
		'deletes a read-only file only when it is actually removed',
		async () => {
			await withEnv(env, async () => {
				await write('locked.txt', 'keep');
				const target = join(dir, 'locked.txt');
				await execFileAsync('attrib.exe', ['+R', target]);
				try {
					await expect(del('locked.txt')).resolves.toBeUndefined();
					expect(await read('locked.txt')).toBeNull();
				} finally {
					await execFileAsync('attrib.exe', ['-R', target]).catch(() => {});
				}
			});
		},
	);

	it.runIf(process.platform === 'win32')(
		'reports a sharing violation instead of claiming deletion succeeded',
		async () => {
			await withEnv(env, async () => {
				await write('held.txt', 'keep');
				const target = join(dir, 'held.txt');
				const ready = join(root, 'lock-ready');
				const script = [
					'$stream = [IO.File]::Open($env:KEELSON_LOCK_TARGET, "Open", "Read", "Read")',
					'[IO.File]::WriteAllText($env:KEELSON_LOCK_READY, "ready")',
					'try { Start-Sleep -Seconds 30 } finally { $stream.Dispose() }',
				].join('; ');
				const child = spawn(
					'powershell.exe',
					['-NoProfile', '-Command', script],
					{
						env: {
							...process.env,
							KEELSON_LOCK_TARGET: target,
							KEELSON_LOCK_READY: ready,
						},
						stdio: 'ignore',
					},
				);
				try {
					for (let attempt = 0; attempt < 500; attempt++) {
						try {
							await access(ready);
							break;
						} catch {
							if (attempt === 499) throw new Error('lock helper did not start');
							await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
						}
					}
					await expect(del('held.txt')).rejects.toThrow(FilesError);
					expect(dec(await read('held.txt'))).toBe('keep');
				} finally {
					child.kill();
					await new Promise<void>((resolveExit) => {
						child.once('exit', () => resolveExit());
						setTimeout(resolveExit, 2000);
					});
				}
			});
		},
		10_000,
	);

	it.runIf(process.platform === 'win32')(
		'retries atomic replace until a short sharing violation is released',
		async () => {
			await withEnv(env, async () => {
				await write('held.txt', 'before');
				const target = join(dir, 'held.txt');
				const ready = join(root, 'replace-lock-ready');
				const script = [
					'$stream = [IO.File]::Open($env:KEELSON_LOCK_TARGET, "Open", "Read", "Read")',
					'[IO.File]::WriteAllText($env:KEELSON_LOCK_READY, "ready")',
					'$deadline = [DateTime]::UtcNow.AddSeconds(10)',
					'try { while (-not (Get-ChildItem -LiteralPath $env:KEELSON_LOCK_DIR -Filter ".keelson-tmp-*" -Force)) { if ([DateTime]::UtcNow -ge $deadline) { throw "temp file was not created" }; Start-Sleep -Milliseconds 5 }; Start-Sleep -Milliseconds 40 } finally { $stream.Dispose() }',
				].join('; ');
				const child = spawn(
					'powershell.exe',
					['-NoProfile', '-Command', script],
					{
						env: {
							...process.env,
							KEELSON_LOCK_TARGET: target,
							KEELSON_LOCK_READY: ready,
							KEELSON_LOCK_DIR: dir,
						},
						stdio: 'ignore',
					},
				);
				try {
					for (let attempt = 0; attempt < 500; attempt++) {
						try {
							await access(ready);
							break;
						} catch {
							if (attempt === 499) throw new Error('lock helper did not start');
							await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
						}
					}
					await expect(write('held.txt', 'after')).resolves.toBeUndefined();
					expect(dec(await read('held.txt'))).toBe('after');
					const exitCode =
						child.exitCode ??
						(await new Promise<number | null>((resolveExit) => {
							child.once('exit', (code) => resolveExit(code));
						}));
					expect(exitCode).toBe(0);
				} finally {
					if (child.exitCode === null) {
						child.kill();
						await new Promise<void>((resolveExit) => {
							child.once('exit', () => resolveExit());
							setTimeout(resolveExit, 2000);
						});
					}
				}
			});
		},
		10_000,
	);

	it.runIf(process.platform === 'win32')(
		'hides internal temp artifacts case-insensitively',
		async () => {
			await withEnv(env, async () => {
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, '.KEELSON-TMP-0123456789ABCDEF01234567'),
					'internal',
				);
				expect(await list()).toEqual([]);
			});
		},
	);

	it.runIf(process.platform === 'win32')(
		'treats case variants as the same local key on default Windows filesystems',
		async () => {
			await withEnv(env, async () => {
				await write('Report', 'first');
				await write('report', 'second');
				expect(dec(await read('REPORT'))).toBe('second');
			});
		},
	);

	it('tolerates a files dir reached through a symlinked ancestor', async () => {
		// macOS `os.tmpdir()` is behind /var → /private/var; the base is
		// realpath-ed so that must not be mistaken for an escape.
		const { mkdir: mkdirp } = await import('node:fs/promises');
		const real = join(root, 'real-files');
		await mkdirp(real, { recursive: true });
		const linked = join(root, 'linked-files');
		await linkDirectory(real, linked);
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
