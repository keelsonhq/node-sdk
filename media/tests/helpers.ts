/**
 * Shared test helpers for @keelsonhq/media SDK tests.
 */

import { vi } from 'vitest';

/**
 * Replace `globalThis.fetch` with a mock that returns a custom response.
 *
 * The handler receives each Request and should return { status, body, headers }.
 * If no handler is given, returns 200 with empty body.
 */
export function mockFetch(
	handler?: (req: Request) => {
		status: number;
		body?: BodyInit | null;
		headers?: Record<string, string>;
	},
): { restore: () => void; calls: Request[] } {
	const calls: Request[] = [];

	const mockFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		calls.push(req);
		const result = handler?.(req) ?? { status: 200 };
		return new Response(result.body ?? null, {
			status: result.status,
			headers: result.headers,
		});
	});

	const original = globalThis.fetch;
	globalThis.fetch = mockFn as typeof fetch;

	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

/**
 * Replace `globalThis.fetch` with a mock that returns a binary body.
 */
export function mockFetchBinary(
	data: Uint8Array,
	status = 200,
	headers: Record<string, string> = {},
): { restore: () => void; calls: Request[] } {
	return mockFetch(() => ({
		status,
		body: data,
		headers: { 'Content-Type': 'application/octet-stream', ...headers },
	}));
}

/**
 * Set environment variables for the duration of a callback, then restore.
 */
export async function withEnv(
	vars: Record<string, string | undefined>,
	fn: () => void | Promise<void>,
): Promise<void> {
	const originals: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(vars)) {
		originals[key] = process.env[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		await fn();
	} finally {
		for (const [key, value] of Object.entries(originals)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

/** Standard env vars that enable Keelson mode. */
export const KEELSON_ENV = {
	KEELSON_MODE: 'keelson',
	KEELSON_INTERNAL_MEDIA_BASE_URL: 'http://media.example:8080',
	KEELSON_APP_MEDIA_TOKEN: 'test-token-123',
} as const;

/** Standard env vars for explicit local mode. */
export const LOCAL_ENV = {
	KEELSON_MODE: 'local',
	KEELSON_APP_ID: undefined,
	KEELSON_INTERNAL_MEDIA_BASE_URL: undefined,
	KEELSON_APP_MEDIA_TOKEN: undefined,
} as const;
