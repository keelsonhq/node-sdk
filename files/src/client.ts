/**
 * Data-files `files` client — write / read / delete / list.
 *
 * Mirrors the Python `keelson_files` and Go `files` SDKs with identical
 * semantics: overwrite `write`, `read` returns `null` when absent (only a 404
 * is missing), idempotent `delete`, lexicographically-sorted `list`.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	unlink,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
	FilesError,
	getBucket,
	getFilesDir,
	getFilesPrefix,
	getMetadataUrl,
	getStorageBase,
	MAX_OBJECT_SIZE_BYTES,
	resolveMode,
} from './config.js';
import { getLocalStrategy } from './localstrategy.js';

const SDK_USER_AGENT = 'Keelson-Node-SDK/0.1.0';
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Key and prefix validation for relative, UTF-8 object paths
// ---------------------------------------------------------------------------

// One filesystem path component is limited to NAME_MAX (255 bytes on ext4 /
// APFS / most POSIX filesystems); the literal-file layout maps each key segment
// to a filename, so each segment must fit.
const SEGMENT_MAX_BYTES = 255;

function hasControlChar(value: string): boolean {
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		// Unicode control chars (category Cc): C0, DEL, and C1 (U+0080–U+009F).
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

function utf8ByteLength(value: string): number {
	return Buffer.byteLength(value, 'utf-8');
}

/** True when `value` contains no unpaired UTF-16 surrogate (i.e. it has a
 * well-formed UTF-8 encoding). A lone surrogate would be silently replaced by
 * U+FFFD on the local FS and throw a `URIError` on the remote path, so it is
 * rejected as a typed `FilesError` up front (matches Python/Go). */
function isWellFormed(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/** Compare two keys by their UTF-8 byte sequence, so ordering matches Go
 * (byte order) and Python (code-point order — identical to UTF-8 byte order).
 * JS's default string sort is UTF-16 code-unit order, which diverges for
 * non-BMP characters (surrogate range 0xD800–0xDFFF < 0xE000). */
function compareUtf8(a: string, b: string): number {
	const ba = Buffer.from(a, 'utf-8');
	const bb = Buffer.from(b, 'utf-8');
	return Buffer.compare(ba, bb);
}

function validateKey(key: string): string {
	if (typeof key !== 'string') throw new FilesError('key must be a string.');
	if (key === '') throw new FilesError('key is required.');
	if (!isWellFormed(key))
		throw new FilesError('key must be well-formed UTF-8 (no lone surrogates).');
	if (utf8ByteLength(key) > 512)
		throw new FilesError('key must be at most 512 UTF-8 bytes.');
	if (key.startsWith('/') || key.endsWith('/'))
		throw new FilesError("key must not start or end with '/'.");
	if (hasControlChar(key))
		throw new FilesError('key must not contain control characters.');
	for (const segment of key.split('/')) {
		if (segment === '')
			throw new FilesError('key must not contain empty segments.');
		if (segment === '.' || segment === '..')
			throw new FilesError("key must not contain '.' or '..' segments.");
		if (utf8ByteLength(segment) > SEGMENT_MAX_BYTES)
			throw new FilesError(
				`each key segment must be at most ${SEGMENT_MAX_BYTES} UTF-8 bytes.`,
			);
	}
	return key;
}

function validatePrefix(prefix: string): string {
	if (typeof prefix !== 'string')
		throw new FilesError('prefix must be a string.');
	if (prefix === '') return '';
	if (!isWellFormed(prefix))
		throw new FilesError(
			'prefix must be well-formed UTF-8 (no lone surrogates).',
		);
	if (utf8ByteLength(prefix) > 512)
		throw new FilesError('prefix must be at most 512 UTF-8 bytes.');
	if (prefix.startsWith('/'))
		throw new FilesError("prefix must not start with '/'.");
	if (hasControlChar(prefix))
		throw new FilesError('prefix must not contain control characters.');
	for (const segment of prefix.split('/')) {
		if (segment === '.' || segment === '..')
			throw new FilesError("prefix must not contain '.' or '..' segments.");
	}
	return prefix;
}

function toBytes(data: Uint8Array | string): Uint8Array {
	if (typeof data === 'string') return new TextEncoder().encode(data);
	if (data instanceof Uint8Array) return data;
	throw new FilesError('data must be a Uint8Array or string.');
}

// ---------------------------------------------------------------------------
// Local filesystem backend
// ---------------------------------------------------------------------------
//
// Local storage layout: each key maps to a literal file
// `<KEELSON_FILES_DIR>/<key>` — the key IS the real file path, for visual
// debuggability. Nested keys create parent directories.
//
// A key and a nested key that shadows it (both `cache` and `cache/item`) cannot
// coexist on a filesystem; that is an inherent limitation of the required
// literal layout and is surfaced as an explicit `FilesError` on `write`, while
// `read`/`delete` of a key shadowed by a directory are treated as missing /
// idempotent (matching the GCS 404).
//
// Confinement is TOCTOU-safe wherever a descriptor-relative path portal is
// available: every operation descends the key's path component-by-component
// relative to a held directory descriptor via `<portal>/<fd>/<name>`
// (openat-equivalent) with `O_NOFOLLOW`, then opens / renames / unlinks the
// final element relative to that descriptor. An ancestor swapped to a symlink
// after a check — even mid-operation — cannot redirect the operation outside
// the files dir. Linux always uses `/proc/self/fd`; other platforms probe at
// runtime (see `localstrategy.ts`) and, failing that, either fail closed or use
// the explicitly opted-in best-effort backend below. Temp files use a
// control-char prefix (never a valid key segment); the atomic rename is
// same-filesystem and `list` never surfaces them.

const TMP_PREFIX = '\x01tmp';
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

type FH = Awaited<ReturnType<typeof open>>;

function collisionError(key: string): FilesError {
	return new FilesError(
		`cannot write key "${key}" in local mode: it collides with a nested key ` +
			'on the filesystem (the object store allows both a key and keys under ' +
			'it, but the spec-mandated local file layout cannot represent both).',
	);
}

function escapeError(): FilesError {
	return new FilesError('resolved path escapes the files directory.');
}

function splitKey(key: string): { dirs: string[]; name: string } {
	const parts = key.split('/');
	const name = parts.pop() as string;
	return { dirs: parts, name };
}

function errCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException).code;
}

// ---------------------------------------------------------------------------
// TOCTOU-safe descriptor-relative backend (`<portal>/<fd>/<name>`)
// ---------------------------------------------------------------------------

function fdPath(portal: string, fh: FH, name: string): string {
	return `${portal}/${fh.fd}/${name}`;
}

async function openBaseDir(create: boolean): Promise<FH> {
	const base = resolve(getFilesDir());
	if (create) await mkdir(base, { recursive: true });
	return open(base, constants.O_RDONLY | O_DIRECTORY);
}

/** Descend `dirs` from `baseFh` with openat + O_NOFOLLOW, returning the parent
 * dir handle (caller closes it). Throws `escapeError` for a symlinked component
 * or an `ErrnoException` (ENOTDIR file component, ENOENT missing). */
async function descendToParent(
	portal: string,
	baseFh: FH,
	dirs: string[],
	create: boolean,
): Promise<FH> {
	let fh = baseFh;
	try {
		for (const comp of dirs) {
			if (create) {
				try {
					await mkdir(fdPath(portal, fh, comp));
				} catch (err) {
					if (errCode(err) !== 'EEXIST') throw err;
				}
			}
			// Classify a symlinked component for a clear message; O_NOFOLLOW below
			// enforces safety even if it is swapped in after this lstat.
			if ((await lstat(fdPath(portal, fh, comp))).isSymbolicLink())
				throw escapeError();
			const next = await open(
				fdPath(portal, fh, comp),
				constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
			);
			await fh.close();
			fh = next;
		}
		return fh;
	} catch (err) {
		await fh.close().catch(() => {});
		throw err;
	}
}

async function writeLocalFd(
	portal: string,
	key: string,
	data: Uint8Array,
): Promise<void> {
	const { dirs, name } = splitKey(key);
	let parentFh: FH;
	try {
		parentFh = await descendToParent(
			portal,
			await openBaseDir(true),
			dirs,
			true,
		);
	} catch (err) {
		const code = errCode(err);
		if (code === 'ENOTDIR' || code === 'EEXIST') throw collisionError(key);
		throw err; // escapeError (FilesError) or other
	}
	try {
		const tmp = `${TMP_PREFIX}${randomBytes(12).toString('hex')}`;
		const tmpFh = await open(
			fdPath(portal, parentFh, tmp),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
			0o644,
		);
		// Once the temp exists, unlink it on ANY subsequent failure (write /
		// close / rename) so a partial temp never lingers.
		try {
			try {
				await tmpFh.writeFile(data);
			} finally {
				await tmpFh.close();
			}
			await rename(
				fdPath(portal, parentFh, tmp),
				fdPath(portal, parentFh, name),
			);
		} catch (err) {
			await unlink(fdPath(portal, parentFh, tmp)).catch(() => {});
			const code = errCode(err);
			if (code === 'EISDIR' || code === 'ENOTEMPTY') throw collisionError(key);
			throw err;
		}
	} finally {
		await parentFh.close();
	}
}

async function readLocalFd(
	portal: string,
	key: string,
): Promise<Uint8Array | null> {
	const { dirs, name } = splitKey(key);
	let baseFh: FH;
	try {
		baseFh = await openBaseDir(false);
	} catch (err) {
		if (errCode(err) === 'ENOENT') return null;
		throw err;
	}
	let parentFh: FH;
	try {
		parentFh = await descendToParent(portal, baseFh, dirs, false);
	} catch (err) {
		const code = errCode(err);
		if (code === 'ENOENT' || code === 'ENOTDIR') return null;
		throw err; // escapeError
	}
	try {
		let fh: FH;
		try {
			fh = await open(
				fdPath(portal, parentFh, name),
				constants.O_RDONLY | O_NOFOLLOW,
			);
		} catch (err) {
			const code = errCode(err);
			if (code === 'ENOENT' || code === 'ENOTDIR') return null;
			if (code === 'ELOOP') throw escapeError();
			throw err;
		}
		try {
			return new Uint8Array(await fh.readFile());
		} catch (err) {
			if (errCode(err) === 'EISDIR') return null; // shadowed by a directory
			throw err;
		} finally {
			await fh.close();
		}
	} finally {
		await parentFh.close();
	}
}

async function deleteLocalFd(portal: string, key: string): Promise<void> {
	const { dirs, name } = splitKey(key);
	let baseFh: FH;
	try {
		baseFh = await openBaseDir(false);
	} catch (err) {
		if (errCode(err) === 'ENOENT') return;
		throw err;
	}
	let parentFh: FH;
	try {
		parentFh = await descendToParent(portal, baseFh, dirs, false);
	} catch (err) {
		// Symlinked ancestor (FilesError) or absent/file component → nothing to
		// delete inside the files dir → idempotent no-op.
		if (err instanceof FilesError) return;
		const code = errCode(err);
		if (code === 'ENOENT' || code === 'ENOTDIR') return;
		throw err;
	}
	try {
		await unlink(fdPath(portal, parentFh, name));
	} catch (err) {
		const code = errCode(err);
		if (
			code === 'ENOENT' ||
			code === 'ENOTDIR' ||
			code === 'EISDIR' ||
			code === 'EPERM' ||
			code === 'ENOTEMPTY'
		) {
			return;
		}
		throw err;
	} finally {
		await parentFh.close();
	}
}

async function listLocalFd(portal: string, prefix: string): Promise<string[]> {
	let baseFh: FH;
	try {
		baseFh = await openBaseDir(false);
	} catch (err) {
		if (errCode(err) === 'ENOENT') return [];
		throw err;
	}
	const keys: string[] = [];
	async function walk(dirFh: FH, relPrefix: string): Promise<void> {
		const entries = await readdir(`${portal}/${dirFh.fd}`, {
			withFileTypes: true,
		});
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const rel = `${relPrefix}${entry.name}`;
			if (entry.isDirectory()) {
				let subFh: FH;
				try {
					subFh = await open(
						fdPath(portal, dirFh, entry.name),
						constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
					);
				} catch {
					continue;
				}
				try {
					await walk(subFh, `${rel}/`);
				} finally {
					await subFh.close();
				}
			} else if (entry.isFile()) {
				if (entry.name.startsWith(TMP_PREFIX)) continue;
				if (rel.startsWith(prefix)) keys.push(rel);
			}
		}
	}
	try {
		await walk(baseFh, '');
	} finally {
		await baseFh.close();
	}
	keys.sort(compareUtf8);
	return keys;
}

// ---------------------------------------------------------------------------
// Best-effort path-based backend (explicit opt-in only — see localstrategy.ts)
// ---------------------------------------------------------------------------
//
// Used only on a platform with no working descriptor-relative portal AND with
// `KEELSON_FILES_ALLOW_BESTEFFORT_LOCAL=1` set. It resolves the files dir with
// `realpath`, re-checks every key component with `lstat` (rejecting symlinks),
// and opens the final element with `O_NOFOLLOW` (plus a whole-path no-symlink
// flag when one was observed to work). `mkdir` / `rename` / `unlink` take no
// such flag and Node exposes no `dir_fd`, so a check-then-act window remains:
// this is a local-development fallback, never a confinement guarantee.

async function baseDirPath(create: boolean): Promise<string> {
	const base = resolve(getFilesDir());
	if (create) await mkdir(base, { recursive: true });
	// realpath the base itself so a symlinked ancestor of the files dir (e.g.
	// macOS `/var` → `/private/var`) does not trip the per-component checks.
	return realpath(base);
}

/** Walk `dirs` under `base`, rejecting any symlinked component, and return the
 * parent directory path. Throws `escapeError` for a symlink, or an
 * `ErrnoException` (ENOENT missing, ENOTDIR file component). */
async function descendPath(
	base: string,
	dirs: string[],
	create: boolean,
): Promise<string> {
	let current = base;
	for (const comp of dirs) {
		const next = join(current, comp);
		if (create) {
			try {
				await mkdir(next);
			} catch (err) {
				if (errCode(err) !== 'EEXIST') throw err;
			}
		}
		const st = await lstat(next);
		if (st.isSymbolicLink()) throw escapeError();
		if (!st.isDirectory()) {
			const err = new Error(
				`not a directory: ${next}`,
			) as NodeJS.ErrnoException;
			err.code = 'ENOTDIR';
			throw err;
		}
		current = next;
	}
	// Defence in depth: the walked path must still be inside the files dir.
	if (current !== base && !current.startsWith(base + sep)) throw escapeError();
	return current;
}

async function writeLocalPath(
	noFollowAny: number,
	key: string,
	data: Uint8Array,
): Promise<void> {
	const { dirs, name } = splitKey(key);
	let parent: string;
	try {
		parent = await descendPath(await baseDirPath(true), dirs, true);
	} catch (err) {
		const code = errCode(err);
		if (code === 'ENOTDIR' || code === 'EEXIST') throw collisionError(key);
		throw err;
	}
	const tmp = join(parent, `${TMP_PREFIX}${randomBytes(12).toString('hex')}`);
	const tmpFh = await open(
		tmp,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			O_NOFOLLOW |
			noFollowAny,
		0o644,
	);
	try {
		try {
			await tmpFh.writeFile(data);
		} finally {
			await tmpFh.close();
		}
		// `rename` replaces a symlink at the destination rather than following it.
		await rename(tmp, join(parent, name));
	} catch (err) {
		await unlink(tmp).catch(() => {});
		const code = errCode(err);
		if (code === 'EISDIR' || code === 'ENOTEMPTY') throw collisionError(key);
		throw err;
	}
}

async function readLocalPath(
	noFollowAny: number,
	key: string,
): Promise<Uint8Array | null> {
	const { dirs, name } = splitKey(key);
	let parent: string;
	try {
		parent = await descendPath(await baseDirPath(false), dirs, false);
	} catch (err) {
		const code = errCode(err);
		if (code === 'ENOENT' || code === 'ENOTDIR') return null;
		throw err; // escapeError
	}
	let fh: FH;
	try {
		fh = await open(
			join(parent, name),
			constants.O_RDONLY | O_NOFOLLOW | noFollowAny,
		);
	} catch (err) {
		const code = errCode(err);
		if (code === 'ENOENT' || code === 'ENOTDIR') return null;
		if (code === 'ELOOP') throw escapeError();
		throw err;
	}
	try {
		return new Uint8Array(await fh.readFile());
	} catch (err) {
		if (errCode(err) === 'EISDIR') return null; // shadowed by a directory
		throw err;
	} finally {
		await fh.close();
	}
}

async function deleteLocalPath(key: string): Promise<void> {
	const { dirs, name } = splitKey(key);
	let parent: string;
	try {
		parent = await descendPath(await baseDirPath(false), dirs, false);
	} catch (err) {
		if (err instanceof FilesError) return; // symlinked ancestor → nothing ours
		const code = errCode(err);
		if (code === 'ENOENT' || code === 'ENOTDIR') return;
		throw err;
	}
	try {
		// `unlink` never follows a symlink at the final component.
		await unlink(join(parent, name));
	} catch (err) {
		const code = errCode(err);
		if (
			code === 'ENOENT' ||
			code === 'ENOTDIR' ||
			code === 'EISDIR' ||
			code === 'EPERM' ||
			code === 'ENOTEMPTY'
		) {
			return;
		}
		throw err;
	}
}

async function listLocalPath(prefix: string): Promise<string[]> {
	let base: string;
	try {
		base = await baseDirPath(false);
	} catch (err) {
		if (errCode(err) === 'ENOENT') return [];
		throw err;
	}
	const keys: string[] = [];
	async function walk(dir: string, relPrefix: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const rel = `${relPrefix}${entry.name}`;
			if (entry.isDirectory()) {
				await walk(join(dir, entry.name), `${rel}/`);
			} else if (entry.isFile()) {
				if (entry.name.startsWith(TMP_PREFIX)) continue;
				if (rel.startsWith(prefix)) keys.push(rel);
			}
		}
	}
	await walk(base, '');
	keys.sort(compareUtf8);
	return keys;
}

// ---------------------------------------------------------------------------
// Local dispatch
// ---------------------------------------------------------------------------
//
// `getLocalStrategy()` throws a typed `FilesError` on a platform where neither
// a portal nor an opted-in fallback is available, so local mode still fails
// closed — it just no longer fails closed on every non-Linux platform by
// assumption.

async function writeLocal(key: string, data: Uint8Array): Promise<void> {
	const s = await getLocalStrategy();
	return s.kind === 'portal'
		? writeLocalFd(s.portal, key, data)
		: writeLocalPath(s.noFollowAny, key, data);
}
async function readLocal(key: string): Promise<Uint8Array | null> {
	const s = await getLocalStrategy();
	return s.kind === 'portal'
		? readLocalFd(s.portal, key)
		: readLocalPath(s.noFollowAny, key);
}
async function deleteLocal(key: string): Promise<void> {
	const s = await getLocalStrategy();
	return s.kind === 'portal'
		? deleteLocalFd(s.portal, key)
		: deleteLocalPath(key);
}
async function listLocal(prefix: string): Promise<string[]> {
	const s = await getLocalStrategy();
	return s.kind === 'portal'
		? listLocalFd(s.portal, prefix)
		: listLocalPath(prefix);
}

// ---------------------------------------------------------------------------
// GCS (remote) backend — ADC over the GCE metadata server
// ---------------------------------------------------------------------------

let tokenCache: { token: string; expiresAt: number } | null = null;

export function clearTokenCache(): void {
	tokenCache = null;
}

async function accessToken(): Promise<string> {
	const now = Date.now();
	if (tokenCache && now < tokenCache.expiresAt) return tokenCache.token;
	let response: Response;
	try {
		response = await fetch(getMetadataUrl(), {
			headers: { 'Metadata-Flavor': 'Google', 'User-Agent': SDK_USER_AGENT },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new FilesError(`failed to obtain ADC access token: ${String(err)}`);
	}
	if (!response.ok) {
		throw new FilesError(
			`metadata token request failed with ${response.status}.`,
		);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (err) {
		throw new FilesError(
			`malformed access-token response from the metadata server: ${String(err)}`,
		);
	}
	// Validate the payload SCHEMA, not just JSON syntax: a valid-JSON `null`
	// or wrong field type must surface as FilesError, never a TypeError.
	if (typeof payload !== 'object' || payload === null) {
		throw new FilesError(
			'malformed access-token response from the metadata server: not an object.',
		);
	}
	const { access_token: token, expires_in: expiresRaw } = payload as {
		access_token?: unknown;
		expires_in?: unknown;
	};
	if (typeof token !== 'string' || token === '') {
		throw new FilesError('metadata server returned no access_token.');
	}
	const expiresIn = typeof expiresRaw === 'number' ? expiresRaw : 0;
	tokenCache = {
		token,
		expiresAt: now + Math.max(0, expiresIn - 60) * 1000,
	};
	return tokenCache.token;
}

function objectName(key: string): string {
	return `${getFilesPrefix()}${key}`;
}

async function gcsRequest(
	method: string,
	url: string,
	opts?: {
		body?: Uint8Array;
		contentType?: string;
		allowNotFound?: boolean;
	},
): Promise<{ status: number; body: Uint8Array }> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${await accessToken()}`,
		'User-Agent': SDK_USER_AGENT,
	};
	if (opts?.contentType) headers['Content-Type'] = opts.contentType;
	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers,
			body: opts?.body ?? null,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw new FilesError(`${method} ${url} failed: ${String(err)}`);
	}
	// Only 404 is "missing"; 401 / 403 / 429 / 5xx are real failures.
	if (response.status === 404 && opts?.allowNotFound) {
		return { status: 404, body: new Uint8Array(0) };
	}
	if (!response.ok) {
		const text = await response.text();
		throw new FilesError(
			`${method} ${url} failed with ${response.status}: ${text}`,
		);
	}
	const body = new Uint8Array(await response.arrayBuffer());
	return { status: response.status, body };
}

function objectUrl(key: string): string {
	const obj = encodeURIComponent(objectName(key));
	return `${getStorageBase()}/storage/v1/b/${getBucket()}/o/${obj}`;
}

async function writeRemote(key: string, data: Uint8Array): Promise<void> {
	const obj = encodeURIComponent(objectName(key));
	const url = `${getStorageBase()}/upload/storage/v1/b/${getBucket()}/o?uploadType=media&name=${obj}`;
	await gcsRequest('POST', url, {
		body: data,
		contentType: 'application/octet-stream',
	});
}

async function readRemote(key: string): Promise<Uint8Array | null> {
	const { status, body } = await gcsRequest(
		'GET',
		`${objectUrl(key)}?alt=media`,
		{
			allowNotFound: true,
		},
	);
	return status === 404 ? null : body;
}

async function deleteRemote(key: string): Promise<void> {
	await gcsRequest('DELETE', objectUrl(key), { allowNotFound: true });
}

async function listRemote(prefix: string): Promise<string[]> {
	const filesPrefix = getFilesPrefix();
	const fullPrefix = encodeURIComponent(`${filesPrefix}${prefix}`);
	const base = `${getStorageBase()}/storage/v1/b/${getBucket()}/o`;
	const keys: string[] = [];
	let pageToken: string | undefined;
	do {
		let url = `${base}?prefix=${fullPrefix}`;
		if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
		const { body } = await gcsRequest('GET', url);
		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder().decode(body) || '{}');
		} catch (err) {
			throw new FilesError(`malformed list response from GCS: ${String(err)}`);
		}
		// Validate the payload SCHEMA (a valid-JSON `null` / array / wrong types
		// must be a FilesError, never a TypeError).
		if (
			typeof payload !== 'object' ||
			payload === null ||
			Array.isArray(payload)
		) {
			throw new FilesError('malformed list response from GCS: not an object.');
		}
		const { items, nextPageToken } = payload as {
			items?: unknown;
			nextPageToken?: unknown;
		};
		if (items !== undefined && !Array.isArray(items)) {
			throw new FilesError(
				'malformed list response from GCS: items not an array.',
			);
		}
		for (const item of items ?? []) {
			if (typeof item !== 'object' || item === null) {
				throw new FilesError(
					'malformed list response from GCS: item not an object.',
				);
			}
			const name = (item as { name?: unknown }).name;
			if (typeof name !== 'string') {
				throw new FilesError(
					'malformed list response from GCS: item name not a string.',
				);
			}
			if (!name.startsWith(filesPrefix)) continue;
			const key = name.slice(filesPrefix.length);
			if (key) keys.push(key);
		}
		if (nextPageToken !== undefined && typeof nextPageToken !== 'string') {
			throw new FilesError(
				'malformed list response from GCS: nextPageToken not a string.',
			);
		}
		pageToken = nextPageToken;
	} while (pageToken);
	keys.sort(compareUtf8);
	return keys;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Write `data` at `key`, overwriting any existing value. Strings are stored
 * as UTF-8. Write-through: once it resolves, the data is persisted. */
export async function write(
	key: string,
	data: Uint8Array | string,
): Promise<void> {
	const validated = validateKey(key);
	const bytes = toBytes(data);
	if (bytes.byteLength > MAX_OBJECT_SIZE_BYTES) {
		throw new FilesError(
			`object is ${bytes.byteLength} bytes, exceeding the ${MAX_OBJECT_SIZE_BYTES}-byte limit.`,
		);
	}
	if (resolveMode() === 'remote') {
		await writeRemote(validated, bytes);
	} else {
		await writeLocal(validated, bytes);
	}
}

/** Read the bytes at `key`, or `null` when absent (only a 404 maps to `null`;
 * 401 / 403 / 429 / 5xx throw). */
export async function read(key: string): Promise<Uint8Array | null> {
	const validated = validateKey(key);
	return resolveMode() === 'remote'
		? readRemote(validated)
		: readLocal(validated);
}

/** Delete `key`. Idempotent: no error when the key does not exist. */
export async function del(key: string): Promise<void> {
	const validated = validateKey(key);
	if (resolveMode() === 'remote') {
		await deleteRemote(validated);
	} else {
		await deleteLocal(validated);
	}
}

/** Return every key (optionally under `prefix`) in lexicographic order.
 * Paging is absorbed internally. */
export async function list(prefix = ''): Promise<string[]> {
	const validated = validatePrefix(prefix);
	return resolveMode() === 'remote'
		? listRemote(validated)
		: listLocal(validated);
}
