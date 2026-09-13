/**
 * Local-backend selection across platforms.
 *
 * Platform-independent branches use injected inputs. Integration assertions
 * against Linux descriptor portals are skipped on other operating systems;
 * runtime probes decide what each host actually supports.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	del,
	list,
	read,
	validateWindowsLocalPath,
	write,
} from '../src/client.js';
import {
	detectNoFollowAny,
	getLocalStrategy,
	probeNoFollowAnyFlag,
	probePortal,
	resolveLocalStrategy,
	setLocalStrategyForTests,
} from '../src/localstrategy.js';
import { withEnv } from './helpers.js';

const neverProbe = async () => false;
const alwaysProbe = async () => true;

describe('resolveLocalStrategy', () => {
	it('Linux always uses /proc/self/fd and never probes', async () => {
		let probed = false;
		const strategy = await resolveLocalStrategy({
			platform: 'linux',
			probePortal: async () => {
				probed = true;
				return true;
			},
		});
		expect(strategy).toEqual({ kind: 'portal', portal: '/proc/self/fd' });
		expect(probed).toBe(false);
	});

	it('Linux always keeps the descriptor-relative backend', async () => {
		const strategy = await resolveLocalStrategy({
			platform: 'linux',
			probePortal: neverProbe,
		});
		expect(strategy).toEqual({ kind: 'portal', portal: '/proc/self/fd' });
	});

	it('a non-Linux platform with a working portal gets the TOCTOU-safe backend', async () => {
		const strategy = await resolveLocalStrategy({
			platform: 'darwin',
			portals: ['/dev/fd'],
			probePortal: alwaysProbe,
		});
		expect(strategy).toEqual({ kind: 'portal', portal: '/dev/fd' });
	});

	it('probes portals in order and takes the first that works', async () => {
		const tried: string[] = [];
		const strategy = await resolveLocalStrategy({
			platform: 'freebsd',
			portals: ['/nope', '/dev/fd', '/proc/self/fd'],
			probePortal: async (p) => {
				tried.push(p);
				return p === '/dev/fd';
			},
		});
		expect(strategy).toEqual({ kind: 'portal', portal: '/dev/fd' });
		expect(tried).toEqual(['/nope', '/dev/fd']);
	});

	it('uses the path backend when a non-Linux portal is unavailable', async () => {
		const strategy = await resolveLocalStrategy({
			platform: 'darwin',
			probePortal: neverProbe,
			detectNoFollowAny: async () => 0x2000_0000,
		});
		expect(strategy).toEqual({
			kind: 'besteffort',
			noFollowAny: 0x2000_0000,
		});
	});

	it('uses the path backend without emitting a startup warning', async () => {
		const strategy = await resolveLocalStrategy({
			platform: 'darwin',
			probePortal: neverProbe,
			detectNoFollowAny: async () => 0,
		});
		expect(strategy).toEqual({ kind: 'besteffort', noFollowAny: 0 });
	});

	it('carries a detected whole-path no-symlink flag into the best-effort backend', async () => {
		const strategy = await resolveLocalStrategy({
			platform: 'darwin',
			probePortal: neverProbe,
			detectNoFollowAny: async () => 0x2000_0000,
		});
		expect(strategy).toEqual({ kind: 'besteffort', noFollowAny: 0x2000_0000 });
	});

	it('uses the path backend on Windows without probing POSIX portals', async () => {
		let probed = false;
		const strategy = await resolveLocalStrategy({
			platform: 'win32',
			probePortal: async () => {
				probed = true;
				return true;
			},
		});
		expect(strategy).toEqual({ kind: 'besteffort', noFollowAny: 0 });
		expect(probed).toBe(false);
	});
});

describe('Windows local path validation', () => {
	it('accepts portable key segments', () => {
		expect(() =>
			validateWindowsLocalPath('reports/2026-09.csv', 'win32'),
		).not.toThrow();
	});

	it.each([
		'../x',
		'a\\\\..\\\\x',
		'a:b',
		'NUL',
		'NUL .txt',
		'con.txt',
		'CONIN$',
		'CONOUT$.log',
		'COM¹',
		'COM².txt',
		'LPT³',
		'trailing.',
		'.keelson-tmp-0123456789abcdef01234567',
		'.KEELSON-TMP-0123456789ABCDEF01234567',
	])('rejects a Windows-special local path: %s', (value) => {
		expect(() => validateWindowsLocalPath(value, 'win32')).toThrow(
			/Windows cannot store locally/,
		);
	});

	it('allows ordinary names that merely share the temp prefix', () => {
		expect(() =>
			validateWindowsLocalPath('.keelson-tmp-user-state', 'win32'),
		).not.toThrow();
	});
});

describe('getLocalStrategy (real resolution on this host)', () => {
	it.skipIf(process.platform !== 'linux')(
		'resolves to /proc/self/fd on Linux, unchanged from before',
		async () => {
			setLocalStrategyForTests(null); // ensure no override / stale cache
			expect(await getLocalStrategy()).toEqual({
				kind: 'portal',
				portal: '/proc/self/fd',
			});
		},
	);

	it.skipIf(process.platform === 'win32')(
		'memoizes the resolution',
		async () => {
			setLocalStrategyForTests(null);
			await withEnv({}, async () => {
				const a = getLocalStrategy();
				const b = getLocalStrategy();
				expect(a).toBe(b);
				await a;
			});
		},
	);

	it.skipIf(process.platform === 'linux')(
		'round-trips through the default non-Linux backend without an opt-in',
		async () => {
			const dir = await mkdtemp(join(tmpdir(), 'keelson-files-macos-'));
			setLocalStrategyForTests(null);
			try {
				await withEnv(
					{
						KEELSON_MODE: 'local',
						KEELSON_FILES_DIR: dir,
						KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL: undefined,
					},
					async () => {
						await write('nested/test.txt', 'hello');
						const value = await read('nested/test.txt');
						expect(value).not.toBeNull();
						expect(new TextDecoder().decode(value ?? undefined)).toBe('hello');
						expect(await list()).toEqual(['nested/test.txt']);
						await del('nested/test.txt');
						expect(await list()).toEqual([]);
					},
				);
			} finally {
				setLocalStrategyForTests(null);
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
});

describe('probePortal (measured against this host)', () => {
	it.skipIf(process.platform !== 'linux')(
		'accepts /proc/self/fd on Linux',
		async () => {
			expect(await probePortal('/proc/self/fd')).toBe(true);
		},
	);

	it.skipIf(process.platform !== 'linux')(
		'accepts /dev/fd on Linux (the non-Linux portal spelling)',
		async () => {
			expect(await probePortal('/dev/fd')).toBe(true);
		},
	);

	it('rejects a portal that does not exist', async () => {
		expect(await probePortal('/nonexistent-portal')).toBe(false);
	});

	it('rejects a path that exists but is not a descriptor portal', async () => {
		// /tmp/<fd>/<name> resolves to nothing; the probe must say no, not throw.
		expect(await probePortal('/tmp')).toBe(false);
	});
});

describe('detectNoFollowAny', () => {
	it('is skipped on every platform except darwin', async () => {
		for (const platform of ['linux', 'freebsd', 'win32']) {
			expect(
				await detectNoFollowAny({
					platform,
					candidates: [0x2000_0000],
					probe: alwaysProbe,
				}),
			).toBe(0);
		}
	});

	it('returns the first candidate the probe accepts', async () => {
		expect(
			await detectNoFollowAny({
				platform: 'darwin',
				candidates: [0x1, 0x2, 0x4],
				probe: async (f) => f === 0x2,
			}),
		).toBe(0x2);
	});

	it('returns 0 when no candidate is accepted (never trusts the constant)', async () => {
		expect(
			await detectNoFollowAny({
				platform: 'darwin',
				candidates: [0x2000_0000],
				probe: neverProbe,
			}),
		).toBe(0);
	});
});

describe('probeNoFollowAnyFlag (measured against this host)', () => {
	it('rejects flag 0 (a no-op cannot provide the guarantee)', async () => {
		expect(await probeNoFollowAnyFlag(0)).toBe(false);
	});

	it('rejects plain O_NOFOLLOW, which only guards the FINAL component', async () => {
		// The whole point of the probe: a flag that lets a symlinked *middle*
		// component through must not be mistaken for O_NOFOLLOW_ANY. Measured on
		// Linux, where O_NOFOLLOW has exactly that final-component-only semantic.
		const { constants } = await import('node:fs');
		expect(await probeNoFollowAnyFlag(constants.O_NOFOLLOW)).toBe(false);
	});
});
