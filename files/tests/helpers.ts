/**
 * Shared test helpers: env scoping + an in-memory fake GCS/metadata server
 * installed on `globalThis.fetch`.
 */

import { vi } from 'vitest';

export const REMOTE_ENV = {
	KEELSON_MODE: 'keelson',
	KEELSON_FILES_BUCKET: 'example-bucket',
	KEELSON_FILES_PREFIX: 'tenants/t/apps/a/files/',
	KEELSON_FILES_STORAGE_BASE: 'https://storage.example',
	KEELSON_FILES_METADATA_URL: 'http://metadata.example/token',
	// Fail closed: platform identity is required in KEELSON_MODE=keelson.
	KEELSON_APP_ID: 'a',
	KEELSON_TENANT_ID: 't',
} as const;

/** Set env vars for the duration of a callback, then restore. */
export async function withEnv(
	vars: Record<string, string | undefined>,
	fn: () => void | Promise<void>,
): Promise<void> {
	const originals: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(vars)) {
		originals[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await fn();
	} finally {
		for (const [key, value] of Object.entries(originals)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

export class FakeGcs {
	store = new Map<string, Uint8Array>();
	calls: Array<{ method: string; url: string }> = [];
	tokenFetches = 0;
	expiresIn = 3600;
	pageSize: number | null = null;
	/** Force a status for the next matching method (metadata excluded). */
	forceStatus: Partial<Record<string, number>> = {};
	/** Malformed-payload injection (200 OK but not valid JSON). */
	badTokenJson = false;
	badListJson = false;
	/** Valid-JSON-but-wrong-schema injection (200 OK, body `null`). */
	nullTokenJson = false;
	nullListJson = false;
	/** Raw body override for list responses (valid JSON, wrong schema). */
	listBody: string | null = null;

	install(): { restore: () => void } {
		const original = globalThis.fetch;
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const rawUrl = typeof input === 'string' ? input : input.toString();
			const url = new URL(rawUrl);
			const method = (init?.method ?? 'GET').toUpperCase();
			this.calls.push({ method, url: rawUrl });

			if (url.host === 'metadata.example') {
				this.tokenFetches += 1;
				if (this.badTokenJson) return new Response('not-json', { status: 200 });
				if (this.nullTokenJson) return new Response('null', { status: 200 });
				return new Response(
					JSON.stringify({
						access_token: `tok-${this.tokenFetches}`,
						expires_in: this.expiresIn,
					}),
					{ status: 200 },
				);
			}

			const forced = this.forceStatus[method];
			if (forced) return new Response('forced', { status: forced });

			const path = url.pathname;
			// Upload: POST /upload/.../o?uploadType=media&name=<enc>
			if (method === 'POST' && path.startsWith('/upload/')) {
				const name = decodeURIComponent(url.searchParams.get('name') ?? '');
				const body = init?.body
					? new Uint8Array(init.body as ArrayBuffer)
					: new Uint8Array(0);
				this.store.set(name, body);
				return new Response('{}', { status: 200 });
			}

			// List: GET /.../o?prefix=<enc>[&pageToken=..]
			if (method === 'GET' && path.endsWith('/o')) {
				if (this.listBody !== null)
					return new Response(this.listBody, { status: 200 });
				const prefix = decodeURIComponent(url.searchParams.get('prefix') ?? '');
				const pageToken = url.searchParams.get('pageToken');
				const names = [...this.store.keys()]
					.filter((n) => n.startsWith(prefix))
					.sort();
				const start = pageToken ? Number(pageToken) : 0;
				let payload: {
					items: Array<{ name: string }>;
					nextPageToken?: string;
				};
				if (this.pageSize !== null) {
					const page = names.slice(start, start + this.pageSize);
					const nextStart = start + this.pageSize;
					payload = { items: page.map((n) => ({ name: n })) };
					if (nextStart < names.length)
						payload.nextPageToken = String(nextStart);
				} else {
					payload = { items: names.map((n) => ({ name: n })) };
				}
				if (this.badListJson) return new Response('not-json', { status: 200 });
				if (this.nullListJson) return new Response('null', { status: 200 });
				return new Response(JSON.stringify(payload), { status: 200 });
			}

			// Object GET / DELETE: /.../o/<enc>
			const marker = '/o/';
			const idx = path.indexOf(marker);
			const name =
				idx >= 0 ? decodeURIComponent(path.slice(idx + marker.length)) : '';
			if (method === 'GET') {
				const value = this.store.get(name);
				if (!value) return new Response('not found', { status: 404 });
				return new Response(value, { status: 200 });
			}
			if (method === 'DELETE') {
				if (!this.store.has(name))
					return new Response('not found', { status: 404 });
				this.store.delete(name);
				return new Response('', { status: 200 });
			}
			return new Response('unexpected', { status: 400 });
		});
		globalThis.fetch = mock as typeof fetch;
		return {
			restore: () => {
				globalThis.fetch = original;
			},
		};
	}
}

/** Clear the module-level token cache between tests. */
export async function clearTokenCache(): Promise<void> {
	const { clearTokenCache } = await import('../src/client.js');
	clearTokenCache();
}
