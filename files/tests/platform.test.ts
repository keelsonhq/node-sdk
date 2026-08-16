/**
 * Local-backend selection across platforms.
 *
 * Platform-independent branches use injected inputs. Integration assertions
 * against Linux descriptor portals are skipped on other operating systems;
 * runtime probes decide what each host actually supports.
 */

import { describe, expect, it } from 'vitest';
import { FilesError } from '../src/config.js';
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
			allowBestEffort: false,
			probePortal: async () => {
				probed = true;
				return true;
			},
		});
		expect(strategy).toEqual({ kind: 'portal', portal: '/proc/self/fd' });
		expect(probed).toBe(false);
	});

	it('Linux ignores the best-effort opt-in (no way to weaken it)', async () => {
		const strategy = await resolveLocalStrategy({
			platform: 'linux',
			allowBestEffort: true,
			probePortal: neverProbe,
		});
		expect(strategy).toEqual({ kind: 'portal', portal: '/proc/self/fd' });
	});

	it('a non-Linux platform with a working portal gets the TOCTOU-safe backend', async () => {
		const strategy = await resolveLocalStrategy({
			platform: 'darwin',
			allowBestEffort: false,
			portals: ['/dev/fd'],
			probePortal: alwaysProbe,
		});
		expect(strategy).toEqual({ kind: 'portal', portal: '/dev/fd' });
	});

	it('probes portals in order and takes the first that works', async () => {
		const tried: string[] = [];
		const strategy = await resolveLocalStrategy({
			platform: 'freebsd',
			allowBestEffort: false,
			portals: ['/nope', '/dev/fd', '/proc/self/fd'],
			probePortal: async (p) => {
				tried.push(p);
				return p === '/dev/fd';
			},
		});
		expect(strategy).toEqual({ kind: 'portal', portal: '/dev/fd' });
		expect(tried).toEqual(['/nope', '/dev/fd']);
	});

	it('fails closed without a portal when best-effort is not opted in', async () => {
		const promise = resolveLocalStrategy({
			platform: 'darwin',
			allowBestEffort: false,
			probePortal: neverProbe,
		});
		await expect(promise).rejects.toThrow(FilesError);
		await expect(promise).rejects.toThrow(
			/KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL=1/,
		);
	});

	it('falls back to best-effort only with the opt-in, and warns', async () => {
		const warnings: string[] = [];
		const strategy = await resolveLocalStrategy({
			platform: 'darwin',
			allowBestEffort: true,
			probePortal: neverProbe,
			detectNoFollowAny: async () => 0,
			warn: (m) => warnings.push(m),
		});
		expect(strategy).toEqual({ kind: 'besteffort', noFollowAny: 0 });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/NOT TOCTOU-safe/);
	});

	it('carries a detected whole-path no-symlink flag into the best-effort backend', async () => {
		const strategy = await resolveLocalStrategy({
			platform: 'darwin',
			allowBestEffort: true,
			probePortal: neverProbe,
			detectNoFollowAny: async () => 0x2000_0000,
			warn: () => {},
		});
		expect(strategy).toEqual({ kind: 'besteffort', noFollowAny: 0x2000_0000 });
	});

	it('Windows is unsupported, with no opt-in escape hatch', async () => {
		for (const allowBestEffort of [false, true]) {
			const promise = resolveLocalStrategy({
				platform: 'win32',
				allowBestEffort,
				probePortal: alwaysProbe,
			});
			await expect(promise).rejects.toThrow(FilesError);
			await expect(promise).rejects.toThrow(/WSL2 or a Linux devcontainer/);
		}
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
			await withEnv(
				{
					KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL:
						process.platform === 'linux' ? undefined : '1',
				},
				async () => {
					const a = getLocalStrategy();
					const b = getLocalStrategy();
					expect(a).toBe(b);
					await a;
				},
			);
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

describe('KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL parsing', () => {
	it('accepts 1 / true and rejects anything else', async () => {
		const { allowBestEffortLocal } = await import('../src/config.js');
		const cases: Array<[string | undefined, boolean]> = [
			['1', true],
			['true', true],
			['TRUE', true],
			[' 1 ', true],
			['0', false],
			['yes', false],
			['', false],
			[undefined, false],
		];
		for (const [value, expected] of cases) {
			await withEnv(
				{ KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL: value },
				async () => {
					expect(allowBestEffortLocal()).toBe(expected);
				},
			);
		}
	});
});
