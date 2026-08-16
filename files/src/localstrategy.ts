/**
 * Local-mode backend selection for the data-files `files` SDK.
 *
 * Local mode needs `openat`-equivalent, descriptor-relative path resolution to
 * make path confinement TOCTOU-safe. Node's `fs` exposes no `dir_fd` parameter
 * (unlike Python's `os.open(..., dir_fd=)` or Go's `os.Root`), so the Node SDK
 * emulates it by re-opening a held directory descriptor through a **portal**
 * directory — `/proc/self/fd/<fd>/<name>`. That is a runtime workaround for a
 * Node limitation, not a deliberate Linux-only policy.
 *
 * Selection order:
 *
 * 1. **Linux** — `/proc/self/fd`, unconditionally and without probing, so the
 *    Linux code path and its cost are byte-for-byte what they were before
 *    cross-platform support existed.
 * 2. **Other POSIX** (macOS, *BSD, …) — probe the portal candidates at runtime.
 *    A portal is accepted only after it demonstrates every operation the
 *    backend performs, including that `O_NOFOLLOW` through the portal actually
 *    rejects a symlink. If one passes, the platform gets the same TOCTOU-safe
 *    backend Linux gets.
 * 3. **Other POSIX, no working portal** — a path-based best-effort backend,
 *    behind the explicit `KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL=1` opt-in plus a
 *    stderr warning. It re-checks every component with `lstat` and opens with
 *    `O_NOFOLLOW`, but check-then-act windows remain on `mkdir` / `rename` /
 *    `unlink`, so it is never selected silently.
 * 4. **Windows** — unsupported, with no opt-in escape hatch: there is no
 *    `O_NOFOLLOW`, so not even a best-effort defence exists. Run local mode
 *    under WSL2 or a Linux devcontainer.
 *
 * Nothing here is on the production code path: production is always
 * `KEELSON_MODE=keelson` (remote GCS) on Linux.
 */

import { constants } from 'node:fs';
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowBestEffortLocal, FilesError } from './config.js';

type FileHandle = Awaited<ReturnType<typeof open>>;

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

/** Portal directories that may expose descriptor-relative path resolution.
 * `/proc/self/fd` is the Linux one; `/dev/fd` is the traditional POSIX spelling
 * and is what a non-Linux platform would have to provide. Whether any given
 * platform's `/dev/fd` supports *traversal* (`/dev/fd/<fd>/<name>`) rather than
 * only naming the descriptor itself is decided by the probe, not by assumption. */
export const PORTAL_CANDIDATES = ['/dev/fd', '/proc/self/fd'] as const;

/** macOS 11+ `O_NOFOLLOW_ANY`: fails the open if ANY path component is a
 * symlink. Node does not re-export it, and this value is NOT trusted — it is
 * only ever used after `detectNoFollowAny` observes the kernel behave that way. */
export const O_NOFOLLOW_ANY_CANDIDATES = [0x2000_0000] as const;

export type LocalStrategy =
	/** TOCTOU-safe descriptor-relative backend via `<portal>/<fd>/<name>`. */
	| { kind: 'portal'; portal: string }
	/** Path-based fallback. `noFollowAny` is 0 unless a whole-path no-symlink
	 * open flag was observed to work, in which case final opens use it. */
	| { kind: 'besteffort'; noFollowAny: number };

// ---------------------------------------------------------------------------
// Probes (real filesystem behaviour — no hardcoded platform assumptions)
// ---------------------------------------------------------------------------

/**
 * Open `path` with `flags` and report whether it was rejected *because of the
 * symlink*, which is the only outcome that proves anything about confinement.
 *
 * Two ways this returns false:
 * - the open SUCCEEDED — the symlink was followed, whatever `close` does next;
 * - the open failed with an errno that is not symlink-rejection evidence
 *   (`EIO` / `EINTR` / `EMFILE` / `EACCES` / …). A transient or unrelated
 *   failure must never be credited as a passed security check, or a probe run
 *   under momentary I/O pressure could adopt an unsafe portal or flag.
 */
async function openRejectedWith(
	path: string,
	flags: number,
	allowedCodes: readonly string[],
): Promise<boolean> {
	let opened: FileHandle | null = null;
	let code: string | undefined;
	try {
		opened = await open(path, flags);
	} catch (err) {
		code = (err as NodeJS.ErrnoException).code;
	}
	if (opened) {
		await opened.close().catch(() => {});
		return false;
	}
	return code !== undefined && allowedCodes.includes(code);
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	// realpath: on macOS `os.tmpdir()` is itself behind a symlink (/var →
	// /private/var), which would poison a whole-path symlink check.
	const root = await realpath(await mkdtemp(join(tmpdir(), 'keelson-probe-')));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Exercise every filesystem operation the descriptor-relative backend performs
 * through `portal`, and return true only if all of them behave. Critically,
 * this includes the security property: `O_NOFOLLOW` through the portal must
 * REJECT a symlinked child. Any throw means "not usable" — never a partial yes.
 */
export async function probePortal(portal: string): Promise<boolean> {
	// Without a real O_NOFOLLOW there is no confinement to verify.
	if (O_NOFOLLOW === 0 || O_DIRECTORY === 0) return false;
	try {
		return await withTempRoot(async (root) => {
			const dir = join(root, 'd');
			await mkdir(dir);
			await mkdir(join(dir, 'sub'));
			await writeFile(join(dir, 'f'), 'ok');
			await symlink(root, join(dir, 'link'), 'dir');

			const fh = await open(dir, constants.O_RDONLY | O_DIRECTORY);
			const p = `${portal}/${fh.fd}`;
			try {
				// 1. Descriptor-relative read resolves to the right file.
				if ((await readFile(`${p}/f`, 'utf-8')) !== 'ok') return false;
				// 2. lstat sees the child without following it.
				if (!(await lstat(`${p}/link`)).isSymbolicLink()) return false;
				// 3. O_NOFOLLOW through the portal REJECTS the symlink. This is the
				//    property the whole confinement guarantee rests on, so it is
				//    checked twice and only a symlink-rejection errno counts.
				//
				// 3a. Plain O_NOFOLLOW: POSIX specifies ELOOP, which is also the
				//     observed Linux errno for this operation.
				if (
					!(await openRejectedWith(
						`${p}/link`,
						constants.O_RDONLY | O_NOFOLLOW,
						['ELOOP'],
					))
				) {
					return false;
				}
				// 3b. The exact flag set the backend uses. Measured on Linux, adding
				//     O_DIRECTORY changes the errno to ENOTDIR: the kernel reports
				//     "not a directory" for the unfollowed symlink itself. That is
				//     equally positive evidence — `link` points AT a directory, so a
				//     followed symlink would have satisfied O_DIRECTORY and returned a
				//     handle. Both errnos mean the link was not traversed; anything
				//     else (including success) fails the probe.
				if (
					!(await openRejectedWith(
						`${p}/link`,
						constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
						['ELOOP', 'ENOTDIR'],
					))
				) {
					return false;
				}
				// 4. Descending into a real subdirectory works.
				const sub = await open(
					`${p}/sub`,
					constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
				);
				await sub.close();
				// 5. mkdir / create+write / rename / readdir / unlink all work.
				await mkdir(`${p}/made`);
				const tmpFh = await open(
					`${p}/tmp`,
					constants.O_WRONLY |
						constants.O_CREAT |
						constants.O_EXCL |
						O_NOFOLLOW,
					0o644,
				);
				try {
					await tmpFh.writeFile('x');
				} finally {
					await tmpFh.close();
				}
				await rename(`${p}/tmp`, `${p}/renamed`);
				if ((await readFile(join(dir, 'renamed'), 'utf-8')) !== 'x')
					return false;
				const names = (await readdir(p)).sort();
				if (!names.includes('f') || !names.includes('renamed')) return false;
				await unlink(`${p}/renamed`);
				return true;
			} finally {
				await fh.close().catch(() => {});
			}
		});
	} catch {
		return false;
	}
}

/**
 * Return true if opening a path whose MIDDLE component is a symlink fails when
 * `flag` is added, while an equivalent symlink-free path still opens. A flag
 * that only guards the final component (plain `O_NOFOLLOW`) fails this probe,
 * as does a flag the kernel silently ignores.
 */
export async function probeNoFollowAnyFlag(flag: number): Promise<boolean> {
	if (flag === 0) return false;
	try {
		return await withTempRoot(async (root) => {
			const real = join(root, 'real');
			await mkdir(real);
			await writeFile(join(real, 'f'), 'ok');
			await symlink(real, join(root, 'link'), 'dir');

			// Through the symlinked middle component: must be rejected with ELOOP,
			// the errno macOS documents for O_NOFOLLOW_ANY. A success means the flag
			// did not guard the path; any other errno is not evidence about symlink
			// handling. Requiring ELOOP exactly is the conservative direction: if a
			// real macOS were to reject with some other errno the flag is simply not
			// adopted, and the backend runs without it. NOT verified on real macOS.
			if (
				!(await openRejectedWith(
					join(root, 'link', 'f'),
					constants.O_RDONLY | flag,
					['ELOOP'],
				))
			) {
				return false;
			}
			// Symlink-free path: must still open (the flag must not break normal use).
			const good = await open(join(real, 'f'), constants.O_RDONLY | flag);
			await good.close();
			return true;
		});
	} catch {
		return false;
	}
}

/** Pick the first candidate flag the kernel actually honours, else 0. */
export async function detectNoFollowAny(opts: {
	platform: string;
	candidates?: readonly number[];
	probe?: (flag: number) => Promise<boolean>;
}): Promise<number> {
	// Only macOS is known to define a whole-path flag; probing elsewhere would
	// mean feeding an arbitrary bit to open() for no expected gain.
	if (opts.platform !== 'darwin') return 0;
	const probe = opts.probe ?? probeNoFollowAnyFlag;
	for (const flag of opts.candidates ?? O_NOFOLLOW_ANY_CANDIDATES) {
		if (await probe(flag)) return flag;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Strategy resolution (pure logic — every platform-dependent input injected)
// ---------------------------------------------------------------------------

export interface StrategyDeps {
	platform: string;
	allowBestEffort: boolean;
	probePortal?: (portal: string) => Promise<boolean>;
	detectNoFollowAny?: (platform: string) => Promise<number>;
	warn?: (message: string) => void;
	portals?: readonly string[];
}

const WINDOWS_MESSAGE =
	'local file storage is not supported on Windows: the platform has no ' +
	'O_NOFOLLOW, so path confinement cannot be enforced even on a best-effort ' +
	'basis. Run local mode under WSL2 or a Linux devcontainer, or use ' +
	'KEELSON_MODE=keelson (remote storage).';

function unsupportedMessage(platform: string): string {
	return (
		`local file storage on "${platform}" could not find a working ` +
		'descriptor-relative path portal ' +
		`(${PORTAL_CANDIDATES.join(', ')}), which is required for TOCTOU-safe ` +
		'path confinement. Set KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL=1 to opt in ' +
		'to a weaker path-based backend for local development, run local mode in ' +
		'a Linux container, or use KEELSON_MODE=keelson (remote storage).'
	);
}

const BEST_EFFORT_WARNING =
	'[keelson/files] WARNING: using the best-effort local backend ' +
	'(KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL=1). Path confinement is re-checked ' +
	'per component but is NOT TOCTOU-safe on this platform. Local development ' +
	'only — never a production configuration.';

/** Resolve the local backend for the given platform, or throw a `FilesError`
 * describing why local mode is unavailable. Every platform-dependent input is
 * injectable so non-Linux branches are unit-testable from Linux. */
export async function resolveLocalStrategy(
	deps: StrategyDeps,
): Promise<LocalStrategy> {
	// Linux keeps the exact pre-existing path: no probe, no detection, no cost.
	if (deps.platform === 'linux') {
		return { kind: 'portal', portal: '/proc/self/fd' };
	}
	if (deps.platform === 'win32') {
		throw new FilesError(WINDOWS_MESSAGE);
	}

	const probe = deps.probePortal ?? probePortal;
	for (const portal of deps.portals ?? PORTAL_CANDIDATES) {
		if (await probe(portal)) return { kind: 'portal', portal };
	}

	if (!deps.allowBestEffort) {
		throw new FilesError(unsupportedMessage(deps.platform));
	}
	const warn = deps.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
	warn(BEST_EFFORT_WARNING);
	const detect =
		deps.detectNoFollowAny ??
		((p: string) => detectNoFollowAny({ platform: p }));
	return { kind: 'besteffort', noFollowAny: await detect(deps.platform) };
}

// ---------------------------------------------------------------------------
// Process-wide cache + test seam
// ---------------------------------------------------------------------------

let cacheKey: string | null = null;
let cached: Promise<LocalStrategy> | null = null;
let override: (() => Promise<LocalStrategy>) | null = null;

/** Resolve (and memoize) the local backend for the current process. The probes
 * touch the filesystem, so this runs at most once per (platform, opt-in) pair. */
export function getLocalStrategy(): Promise<LocalStrategy> {
	if (override) return override();
	const allowBestEffort = allowBestEffortLocal();
	const key = `${process.platform}|${allowBestEffort}`;
	if (cacheKey !== key || cached === null) {
		cacheKey = key;
		cached = resolveLocalStrategy({
			platform: process.platform,
			allowBestEffort,
		}).catch((err) => {
			// Never memoize a failure: the operator may fix the env and retry.
			cacheKey = null;
			cached = null;
			throw err;
		});
	}
	return cached;
}

/** Test seam: force a strategy (or a throwing resolution) and clear the cache.
 * Pass `null` to restore normal resolution. */
export function setLocalStrategyForTests(
	factory: (() => Promise<LocalStrategy>) | null,
): void {
	override = factory;
	cacheKey = null;
	cached = null;
}
