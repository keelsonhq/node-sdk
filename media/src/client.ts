/**
 * Media SDK client — put, get, open, delete, exists, url, stat.
 *
 * Mirrors the Python keelson_media SDK with identical semantics.
 */

import {
	stat as fsStat,
	mkdir,
	readFile,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
	MediaError,
	getMediaDir,
	getMediaToken,
	getInternalBaseUrl,
	getUrlPrefix,
	resolveMode,
} from './config.js';
import type { MediaStat, PutOptions } from './types.js';
import { newUlid } from './ulid.js';

// ---------------------------------------------------------------------------
// file_id validation
// ---------------------------------------------------------------------------

function normalizeFileId(fileId: string): string {
	const value = (fileId ?? '').trim();
	if (!value) throw new MediaError('file_id is required.');
	if (value.startsWith('http://') || value.startsWith('https://')) {
		throw new MediaError('file_id must not be a URL.');
	}
	const stripped = value.replace(/^\/+/, '');
	if (
		!stripped ||
		stripped.includes('/') ||
		stripped === '.' ||
		stripped === '..'
	) {
		throw new MediaError('file_id is invalid.');
	}
	return stripped;
}

// ---------------------------------------------------------------------------
// Helpers: internal HTTP
// ---------------------------------------------------------------------------

function internalUrl(fileId: string): string {
	const base = getInternalBaseUrl().replace(/\/+$/, '');
	return `${base}/__keelson/internal/files/${encodeURIComponent(fileId)}`;
}

async function internalRequest(
	method: string,
	fileId: string,
	opts?: {
		body?: Uint8Array;
		contentType?: string;
		allowNotFound?: boolean;
		extraHeaders?: Record<string, string>;
	},
): Promise<{ status: number; body: Uint8Array; headers: Headers }> {
	const url = internalUrl(fileId);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${getMediaToken()}`,
	};
	if (opts?.contentType) headers['Content-Type'] = opts.contentType;
	if (opts?.extraHeaders) Object.assign(headers, opts.extraHeaders);

	const response = await fetch(url, {
		method,
		headers,
		body: opts?.body ?? null,
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		if (opts?.allowNotFound && response.status === 404) {
			return {
				status: 404,
				body: new Uint8Array(0),
				headers: response.headers,
			};
		}
		const text = await response.text();
		throw new MediaError(
			`${method} ${url} failed with ${response.status}: ${text}`,
		);
	}

	const body =
		method === 'HEAD'
			? new Uint8Array(0)
			: new Uint8Array(await response.arrayBuffer());
	return { status: response.status, body, headers: response.headers };
}

// ---------------------------------------------------------------------------
// Helpers: local filesystem
// ---------------------------------------------------------------------------

function localPath(fileId: string): string {
	return resolve(getMediaDir(), fileId);
}

function localMetaPath(fileId: string): string {
	return resolve(getMediaDir(), `${fileId}.meta.json`);
}

// ---------------------------------------------------------------------------
// Helpers: content type guessing
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, string> = {
	'.html': 'text/html',
	'.htm': 'text/html',
	'.css': 'text/css',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.json': 'application/json',
	'.xml': 'application/xml',
	'.txt': 'text/plain',
	'.csv': 'text/csv',
	'.md': 'text/markdown',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.gz': 'application/gzip',
	'.tar': 'application/x-tar',
	'.mp3': 'audio/mpeg',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
};

function guessContentType(filename: string): string | undefined {
	const dot = filename.lastIndexOf('.');
	if (dot < 0) return undefined;
	return EXTENSION_MAP[filename.slice(dot).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload file data and return the generated file_id.
 *
 * In Keelson mode, uploads via internal proxy.
 * In local mode, writes to `MEDIA_DIR` (default `./media`).
 */
export async function put(
	data: Uint8Array | Buffer,
	options?: PutOptions,
): Promise<string> {
	if (!(data instanceof Uint8Array)) {
		throw new MediaError('data must be a Uint8Array or Buffer.');
	}

	const fileId = newUlid();
	const guessedType = options?.filename
		? guessContentType(options.filename)
		: undefined;
	const effectiveType =
		options?.contentType ?? guessedType ?? 'application/octet-stream';

	if (resolveMode() === 'remote') {
		const extraHeaders: Record<string, string> = {};
		if (options?.filename)
			extraHeaders['X-Keelson-Filename'] = options.filename;
		await internalRequest('PUT', fileId, {
			body: data,
			contentType: effectiveType,
			extraHeaders,
		});
		// Verify upload succeeded (matches Python SDK behaviour).
		await internalRequest('HEAD', fileId);
		return fileId;
	}

	// Local fallback
	const target = localPath(fileId);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, data);
	await writeFile(
		localMetaPath(fileId),
		JSON.stringify({ content_type: effectiveType }),
		'utf-8',
	);
	return fileId;
}

/**
 * Download entire file contents.
 */
export async function get(fileId: string): Promise<Uint8Array> {
	const id = normalizeFileId(fileId);
	if (resolveMode() === 'remote') {
		const { body } = await internalRequest('GET', id);
		return body;
	}
	return readFile(localPath(id));
}

/**
 * Read file contents (alias for `get`).
 */
export async function read(fileId: string): Promise<Uint8Array> {
	return get(fileId);
}

/**
 * Read file contents (alias for `get`, matches Python SDK's `open`).
 */
export async function open(fileId: string): Promise<Uint8Array> {
	return get(fileId);
}

/**
 * Delete a file. No-op if the file does not exist.
 *
 * Exported as both `del` and `delete_` for convenience.
 * The entrypoint also re-exports this as `delete` via rename.
 */
export async function del(fileId: string): Promise<void> {
	const id = normalizeFileId(fileId);
	if (resolveMode() === 'remote') {
		await internalRequest('DELETE', id, { allowNotFound: true });
		return;
	}
	try {
		await unlink(localPath(id));
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	try {
		await unlink(localMetaPath(id));
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}

/**
 * Check whether a file exists.
 */
export async function exists(fileId: string): Promise<boolean> {
	const id = normalizeFileId(fileId);
	if (resolveMode() === 'remote') {
		const { status } = await internalRequest('HEAD', id, {
			allowNotFound: true,
		});
		return status === 200;
	}
	try {
		await fsStat(localPath(id));
		return true;
	} catch {
		return false;
	}
}

/**
 * Return metadata for a file without downloading its content.
 *
 * Throws `MediaError` if the file does not exist.
 */
export async function stat(fileId: string): Promise<MediaStat> {
	const id = normalizeFileId(fileId);
	if (resolveMode() === 'remote') {
		const { status, headers } = await internalRequest('HEAD', id);
		let contentType = headers.get('content-type') ?? 'application/octet-stream';
		if (contentType.includes(';'))
			contentType = contentType.split(';')[0].trim();
		const contentLength =
			parseInt(headers.get('content-length') ?? '0', 10) || 0;
		return { contentType, contentLength, status };
	}

	// Local fallback
	const path = localPath(id);
	let info: Awaited<ReturnType<typeof fsStat>>;
	try {
		info = await fsStat(path);
	} catch {
		throw new MediaError(`File not found: ${id}`);
	}

	let contentType = 'application/octet-stream';
	try {
		const raw = await readFile(localMetaPath(id), 'utf-8');
		const meta = JSON.parse(raw) as { content_type?: string };
		if (meta.content_type) contentType = meta.content_type;
	} catch {
		// No metadata file — use default.
	}
	return { contentType, contentLength: info.size, status: 200 };
}

/**
 * Return the public-facing URL path for a file.
 *
 * This is a relative path (e.g. `/media/01ABC...`). The host is determined
 * by the deployment context (Cloudflare Worker domain).
 *
 * Resolves the runtime mode first so a misconfigured / capability-unavailable
 * Keelson deployment fails closed here too, matching the Go client (whose
 * constructor rejects) and the rest of the Media API. In explicit local mode
 * and normal remote mode it returns the path as usual.
 */
export function url(fileId: string): string {
	resolveMode();
	const id = normalizeFileId(fileId);
	return `${getUrlPrefix()}${encodeURIComponent(id)}`;
}
