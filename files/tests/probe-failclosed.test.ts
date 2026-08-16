/**
 * Probe fail-closed regressions.
 *
 * Both probes decide a security property from a failing `open`. Two ways that
 * inference can go wrong, both of which would adopt an unsafe portal / flag:
 *
 * 1. The open SUCCEEDS but something afterwards throws (e.g. `close`) — the
 *    symlink WAS followed, so this is not a rejection.
 * 2. The open fails for an unrelated reason (`EIO`, `EINTR`, `EMFILE`,
 *    `EACCES`, …) — proves nothing about symlink handling, and a probe run
 *    under momentary I/O pressure must not be credited as a passed check.
 *
 * The injected failure scenarios cannot be produced reliably against the real
 * filesystem, so
 * `node:fs/promises.open` is mocked for the specific symlink path each probe
 * checks, while every other path passes through to the real implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mode =
	| { kind: 'passthrough' }
	| { kind: 'follow' } // open succeeds; close then throws
	| { kind: 'errno'; code: string };

const state = vi.hoisted(() => ({ mode: { kind: 'passthrough' } as Mode }));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	const realOpen = actual.open as (...a: unknown[]) => unknown;
	return {
		...actual,
		open: async (path: unknown, ...rest: unknown[]) => {
			const p = String(path);
			// The symlink `probePortal` and `probeNoFollowAnyFlag` each expect to be
			// rejected. Everything else keeps its real behaviour.
			const isProbedSymlink = p.endsWith('/link') || p.endsWith('/link/f');
			if (!isProbedSymlink || state.mode.kind === 'passthrough') {
				return realOpen(path, ...rest);
			}
			if (state.mode.kind === 'follow') {
				return {
					fd: -1,
					close: async () => {
						throw new Error('close failed');
					},
				};
			}
			const err = new Error(
				`injected ${state.mode.code}`,
			) as NodeJS.ErrnoException;
			err.code = state.mode.code;
			throw err;
		},
	};
});

const { probeNoFollowAnyFlag, probePortal } = await import(
	'../src/localstrategy.js'
);

const NOFOLLOW_ANY_CANDIDATE = 0x2000_0000;

beforeEach(() => {
	state.mode = { kind: 'passthrough' };
});
afterEach(() => {
	state.mode = { kind: 'passthrough' };
	vi.clearAllMocks();
});

describe('positive control (mock installed, but passing through)', () => {
	it.skipIf(process.platform !== 'linux')(
		'probePortal still accepts /proc/self/fd',
		async () => {
			// Guards the errno allowlist itself: with O_DIRECTORY the real rejection
			// errno on this host is ENOTDIR, not ELOOP. An allowlist of only ELOOP
			// would fail this test rather than fail silently.
			expect(await probePortal('/proc/self/fd')).toBe(true);
		},
	);
});

describe('a followed symlink is never a rejection', () => {
	it('probePortal rejects a portal that opens the symlink, even if close throws', async () => {
		state.mode = { kind: 'follow' };
		expect(await probePortal('/proc/self/fd')).toBe(false);
	});

	it('probeNoFollowAnyFlag rejects a flag that opens through the symlink, even if close throws', async () => {
		state.mode = { kind: 'follow' };
		expect(await probeNoFollowAnyFlag(NOFOLLOW_ANY_CANDIDATE)).toBe(false);
	});
});

describe('an unrelated open failure is never a rejection', () => {
	// Each of these leaves the rest of the probe working normally, so a `true`
	// result could only come from crediting the injected error as evidence.
	for (const code of ['EACCES', 'EIO', 'EINTR', 'EMFILE', 'ENOMEM']) {
		it(`probePortal fails closed when the symlink open returns ${code}`, async () => {
			state.mode = { kind: 'errno', code };
			expect(await probePortal('/proc/self/fd')).toBe(false);
		});

		it(`probeNoFollowAnyFlag fails closed when the symlink open returns ${code}`, async () => {
			state.mode = { kind: 'errno', code };
			expect(await probeNoFollowAnyFlag(NOFOLLOW_ANY_CANDIDATE)).toBe(false);
		});
	}

	it.skipIf(process.platform !== 'linux')(
		'probePortal still accepts a genuine ELOOP rejection',
		async () => {
			// The allowlist must accept the real thing, not just reject everything.
			state.mode = { kind: 'errno', code: 'ELOOP' };
			expect(await probePortal('/proc/self/fd')).toBe(true);
		},
	);

	it('probeNoFollowAnyFlag accepts a genuine ELOOP rejection', async () => {
		// Injecting ELOOP exercises the documented accept path without assuming
		// that the current kernel implements O_NOFOLLOW_ANY.
		state.mode = { kind: 'errno', code: 'ELOOP' };
		expect(await probeNoFollowAnyFlag(NOFOLLOW_ANY_CANDIDATE)).toBe(true);
	});
});
