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

import {
	type ChildProcessWithoutNullStreams,
	execFile,
	spawn,
} from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
const LOCK_HELPER_START_TIMEOUT_MS = 30_000;
const LOCAL_TEMP_TIMEOUT_MS = 10_000;
const LOCK_HOLD_MS = 50;
const LOCK_HELPER_EXIT_TIMEOUT_MS = 2_000;
const LOCK_HELPER_KILL_TIMEOUT_MS = 2_000;
const LOCK_HELPER_CLEANUP_TIMEOUT_MS = LOCK_HELPER_KILL_TIMEOUT_MS * 2;
const WINDOWS_LOCK_TEST_MARGIN_MS = 5_000;
const WINDOWS_LOCK_TEST_TIMEOUT_MS =
	LOCK_HELPER_START_TIMEOUT_MS +
	LOCAL_TEMP_TIMEOUT_MS +
	LOCK_HOLD_MS +
	LOCK_HELPER_EXIT_TIMEOUT_MS +
	LOCK_HELPER_CLEANUP_TIMEOUT_MS +
	WINDOWS_LOCK_TEST_MARGIN_MS;

function spawnWindowsLockHelper(
	target: string,
): ChildProcessWithoutNullStreams {
	const script = [
		'$stream = [IO.File]::Open($env:KEELSON_LOCK_TARGET, "Open", "Read", "Read")',
		'[Console]::Out.WriteLine("ready")',
		'[Console]::Out.Flush()',
		'try { $null = [Console]::In.ReadLine() } finally { $stream.Dispose() }',
	].join('; ');
	return spawn('powershell.exe', ['-NoProfile', '-Command', script], {
		env: { ...process.env, KEELSON_LOCK_TARGET: target },
		stdio: 'pipe',
	});
}

async function waitForLockHelper(
	child: ChildProcessWithoutNullStreams,
): Promise<void> {
	await new Promise<void>((resolveReady, rejectReady) => {
		let stdout = '';
		const cleanup = () => {
			clearTimeout(timeout);
			child.stdout.off('data', onData);
			child.off('error', onError);
			child.off('exit', onExit);
		};
		const onData = (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (!stdout.includes('ready')) return;
			cleanup();
			resolveReady();
		};
		const onError = (error: Error) => {
			cleanup();
			rejectReady(error);
		};
		const onExit = (code: number | null) => {
			cleanup();
			rejectReady(new Error(`lock helper exited before ready (${code})`));
		};
		const timeout = setTimeout(() => {
			cleanup();
			rejectReady(
				new Error(
					`lock helper did not start within ${LOCK_HELPER_START_TIMEOUT_MS} ms`,
				),
			);
		}, LOCK_HELPER_START_TIMEOUT_MS);
		child.stdout.on('data', onData);
		child.once('error', onError);
		child.once('exit', onExit);
	});
}

type LockHelperExit = { code: number | null; signal: NodeJS.Signals | null };

async function waitForLockHelperExit(
	child: ChildProcessWithoutNullStreams,
	timeoutMs = LOCK_HELPER_EXIT_TIMEOUT_MS,
): Promise<LockHelperExit> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	return await new Promise<LockHelperExit>((resolveExit, rejectExit) => {
		let processError: Error | undefined;
		const cleanup = () => {
			clearTimeout(timeout);
			child.off('error', onError);
			child.off('exit', onExit);
		};
		const onError = (error: Error) => {
			processError = error;
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			resolveExit({ code, signal });
		};
		const timeout = setTimeout(() => {
			cleanup();
			const detail = processError ? `: ${processError.message}` : '';
			rejectExit(
				new Error(`lock helper did not exit within ${timeoutMs} ms${detail}`),
			);
		}, timeoutMs);
		child.once('error', onError);
		child.once('exit', onExit);
	});
}

async function stopLockHelper(
	child: ChildProcessWithoutNullStreams,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const killSent = child.kill();
	try {
		const { code, signal } = await waitForLockHelperExit(
			child,
			LOCK_HELPER_KILL_TIMEOUT_MS,
		);
		if (!killSent) {
			throw new Error(
				`lock helper kill failed before exit (code ${code}, signal ${signal})`,
			);
		}
	} catch (error) {
		const detail = error instanceof Error ? `: ${error.message}` : '';
		throw new Error(
			`failed to stop lock helper (kill returned ${killSent})${detail}`,
		);
	}
}

async function finishLockHelper(
	child: ChildProcessWithoutNullStreams,
): Promise<LockHelperExit> {
	try {
		return await waitForLockHelperExit(child);
	} catch (error) {
		await stopLockHelper(child);
		throw error;
	}
}

async function waitForLocalTemp(dir: string): Promise<void> {
	const deadline = Date.now() + LOCAL_TEMP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if ((await readdir(dir)).some((name) => name.startsWith('.keelson-tmp-')))
			return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(
		`temp file was not created within ${LOCAL_TEMP_TIMEOUT_MS} ms`,
	);
}

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
				const child = spawnWindowsLockHelper(target);
				try {
					await waitForLockHelper(child);
					await expect(del('held.txt')).rejects.toThrow(FilesError);
					expect(dec(await read('held.txt'))).toBe('keep');
				} finally {
					child.stdin.end('release\n');
					await stopLockHelper(child);
				}
			});
		},
		WINDOWS_LOCK_TEST_TIMEOUT_MS,
	);

	it.runIf(process.platform === 'win32')(
		'retries atomic replace until a short sharing violation is released',
		async () => {
			await withEnv(env, async () => {
				await write('held.txt', 'before');
				const target = join(dir, 'held.txt');
				const child = spawnWindowsLockHelper(target);
				try {
					await waitForLockHelper(child);
					let settled = false;
					let replacementError: unknown;
					const replacement = write('held.txt', 'after')
						.catch((error: unknown) => {
							replacementError = error;
						})
						.finally(() => {
							settled = true;
						});
					await waitForLocalTemp(dir);
					await new Promise((resolveDelay) =>
						setTimeout(resolveDelay, LOCK_HOLD_MS),
					);
					expect(settled).toBe(false);
					child.stdin.end('release\n');
					const { code, signal } = await finishLockHelper(child);
					expect(signal).toBeNull();
					expect(code).toBe(0);
					await replacement;
					expect(replacementError).toBeUndefined();
					expect(dec(await read('held.txt'))).toBe('after');
				} finally {
					await stopLockHelper(child);
				}
			});
		},
		WINDOWS_LOCK_TEST_TIMEOUT_MS,
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
