/** Remote (runtime API) backend: token, request shape, validation, retries. */

import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { enqueue, get, TasksError } from '../src/index.js';
import {
	type Answer,
	BASE_URL,
	connectionRefused,
	installFakeApi,
	METADATA_URL,
	setEnv,
	TOKEN,
	timedOut,
	useCleanTasksState,
} from './helpers.js';

const TRANSIENT_503: Answer = [503, 'Service Unavailable'];
const ACCEPTED: Answer = [202, '{"task_id":"t-new"}'];

const decoder = new TextDecoder();
const text = (body: Uint8Array | null) =>
	body === null ? null : decoder.decode(body);

async function caught(promise: Promise<unknown>): Promise<TasksError> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(TasksError);
		return err as TasksError;
	}
	throw new Error('expected a TasksError');
}

describe('remote backend', () => {
	const state = useCleanTasksState();

	it('enqueue sends the payload and key with an identity token', async () => {
		const fake = installFakeApi(ACCEPTED);

		expect(
			await enqueue(
				'Generate-PDF',
				{ order_id: 1, note: 'é' },
				{ idempotencyKey: 'k-1' },
			),
		).toBe('t-new');

		expect(fake.requests).toHaveLength(1);
		const [request] = fake.requests;
		expect(request.method).toBe('POST');
		// The name is URL-encoded as given; the server normalizes it.
		expect(request.url).toBe(
			`${BASE_URL}/internal/apps/app_123/tasks/Generate-PDF/enqueue`,
		);
		expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(request.headers['content-type']).toBe('application/json');
		expect(text(request.body)).toBe(
			'{"payload":{"order_id":1,"note":"é"},"idempotency_key":"k-1"}',
		);
		expect(request.redirect).toBe('manual');
		expect(request.hasSignal).toBe(true);
		expect(fake.tokenRequests).toHaveLength(1);
		expect(fake.tokenRequests[0].headers['metadata-flavor']).toBe('Google');
		expect(fake.tokenRequests[0].hasSignal).toBe(true);
	});

	it('enqueue without a key omits it and defaults the payload to null', async () => {
		const fake = installFakeApi(ACCEPTED);
		await enqueue('a');
		await enqueue('a', undefined, {});
		expect(fake.requests.map((r) => text(r.body))).toEqual([
			'{"payload":null}',
			'{"payload":null}',
		]);
	});

	it('identity token audience is the base URL verbatim', async () => {
		const fake = installFakeApi(ACCEPTED);
		// A trailing slash stays in the audience but not in the request URL.
		setEnv({ KEELSON_TASKS_BASE_URL: `${BASE_URL}/` });
		await enqueue('a', null);

		expect(fake.audiences()).toEqual([`${BASE_URL}/`]);
		const tokenUrl = fake.tokenRequests[0].url;
		expect(tokenUrl.startsWith(`${METADATA_URL}?audience=`)).toBe(true);
		// The audience is fully URL-encoded in the query.
		expect(tokenUrl).toContain('audience=https%3A%2F%2F');
		expect(fake.requests[0].url.startsWith(`${BASE_URL}/internal/apps/`)).toBe(
			true,
		);
	});

	it('fetches an identity token for every HTTP call', async () => {
		const fake = installFakeApi(TRANSIENT_503, ACCEPTED);
		await enqueue('a', null, { idempotencyKey: 'k' });
		expect(fake.tokenRequests).toHaveLength(2);
		expect(fake.requests).toHaveLength(2);
	});

	it('get URL-encodes the task id', async () => {
		const body = {
			task_id: 'a/b c',
			name: 'a',
			status: 'queued',
			claimed_attempts: 0,
			last_failure_code: null,
			created_at: '2026-10-02T03:04:05Z',
			finished_at: null,
		};
		const fake = installFakeApi([200, JSON.stringify(body)]);
		expect((await get('a/b c')).task_id).toBe('a/b c');
		expect(fake.requests[0].method).toBe('GET');
		expect(fake.requests[0].url).toBe(
			`${BASE_URL}/internal/apps/app_123/tasks/a%2Fb%20c`,
		);
		expect(fake.requests[0].body).toBeNull();
	});

	it('retries transient errors only with an idempotency key', async () => {
		// Without a key: never retried (a lost response may hide an accepted task).
		for (const answer of [
			TRANSIENT_503,
			[502, ''] as Answer,
			[504, ''] as Answer,
			connectionRefused(),
			timedOut(),
		]) {
			const fake = installFakeApi(answer, ACCEPTED);
			state.slept.length = 0;
			const err = await caught(enqueue('a', { x: 1 }));
			expect(err.code).toBe('TASKS_UNAVAILABLE_TRANSIENT');
			expect(err.message).toContain('idempotencyKey');
			expect(fake.requests).toHaveLength(1);
			expect(state.slept).toEqual([]);
		}

		// With a key: two transient failures, then success on the third attempt.
		let fake = installFakeApi(TRANSIENT_503, connectionRefused(), ACCEPTED);
		state.slept.length = 0;
		expect(await enqueue('a', { x: 1 }, { idempotencyKey: 'k' })).toBe('t-new');
		expect(fake.requests).toHaveLength(3);
		expect(state.slept).toEqual([500, 1000]);
		// Every attempt sends the same body.
		expect(new Set(fake.requests.map((r) => text(r.body))).size).toBe(1);

		// Three transient failures: no fourth attempt.
		fake = installFakeApi(TRANSIENT_503);
		state.slept.length = 0;
		const err = await caught(enqueue('a', { x: 1 }, { idempotencyKey: 'k' }));
		expect([err.code, err.status]).toEqual([
			'TASKS_UNAVAILABLE_TRANSIENT',
			503,
		]);
		expect(fake.requests).toHaveLength(3);
		expect(state.slept).toEqual([500, 1000]);
	});

	it.each([
		[[403, '<html>Forbidden</html>'] as Answer, 'TASKS_FORBIDDEN'],
		[[401, ''] as Answer, 'TASKS_UNAUTHORIZED'],
		[
			[
				429,
				'{"error":{"code":"TASK_BACKLOG_LIMIT_EXCEEDED","message":"x"}}',
			] as Answer,
			'TASK_BACKLOG_LIMIT_EXCEEDED',
		],
		[
			[503, '{"error":{"code":"TASKS_UNAVAILABLE","message":"x"}}'] as Answer,
			'TASKS_UNAVAILABLE',
		],
		[[500, ''] as Answer, 'TASKS_SERVER_ERROR'],
	])('enqueue with a key does not retry permanent errors (%j → %s)', async (answer, code) => {
		const fake = installFakeApi(answer, ACCEPTED);
		const err = await caught(enqueue('a', null, { idempotencyKey: 'k' }));
		expect(err.code).toBe(code);
		expect(fake.requests).toHaveLength(1);
		expect(state.slept).toEqual([]);
	});

	it('the forbidden message explains permission propagation', async () => {
		installFakeApi([403, '<html>Forbidden</html>']);
		const err = await caught(enqueue('a', null));
		expect(err.message).toContain('few minutes');
		expect(err.message).toContain('tasks:');
	});

	it('surfaces the envelope message', async () => {
		installFakeApi([
			404,
			'{"error":{"code":"TASK_NOT_DECLARED","message":"Task is not declared."}}',
		]);
		const err = await caught(enqueue('nope', null));
		expect([err.code, err.status, err.message]).toEqual([
			'TASK_NOT_DECLARED',
			404,
			'Task is not declared.',
		]);
	});

	it('checks the payload limit on the exact body bytes', async () => {
		const fake = installFakeApi(ACCEPTED);
		const key = 'order-1';
		const overhead = new TextEncoder().encode(
			'{"payload":"","idempotency_key":"order-1"}',
		).byteLength;
		// "é" is 2 bytes in UTF-8: counting UTF-16 code units would measure
		// differently.
		const fill = 65536 - overhead;
		const payload = 'é'.repeat(Math.floor(fill / 2)) + 'x'.repeat(fill % 2);

		await enqueue('a', payload, { idempotencyKey: key });
		expect(fake.requests[0].body?.byteLength).toBe(65536);

		const err = await caught(
			enqueue('a', `${payload}x`, { idempotencyKey: key }),
		);
		expect(err.code).toBe('TASK_PAYLOAD_TOO_LARGE');
		expect(err.status).toBeNull();
		// The key counts too: the same payload without it fits.
		await enqueue('a', `${payload}x`);
		expect(fake.requests).toHaveLength(2);
		expect(fake.requests[1].body?.byteLength).toBe(
			65536 - ',"idempotency_key":"order-1"'.length + 1,
		);
	});

	it.each([
		'',
		'x'.repeat(129),
		'tab\there',
		'naïve',
		'line\n',
		'\x7f',
		3,
	])('rejects an invalid idempotency key before sending (%j)', async (key) => {
		const fake = installFakeApi(ACCEPTED);
		const err = await caught(
			enqueue('a', null, { idempotencyKey: key as string }),
		);
		expect(err.code).toBe('TASK_INVALID_REQUEST');
		expect(fake.requests).toEqual([]);
		expect(fake.tokenRequests).toEqual([]);
	});

	it('accepts the idempotency key boundaries', async () => {
		const fake = installFakeApi(ACCEPTED);
		for (const key of [' ', '~', 'x'.repeat(128)]) {
			await enqueue('a', null, { idempotencyKey: key });
		}
		expect(fake.requests).toHaveLength(3);
	});

	it('rejects an unserializable payload as an invalid request', async () => {
		const fake = installFakeApi(ACCEPTED);
		const loop: unknown[] = [];
		loop.push(loop);
		for (const payload of [
			loop,
			10n,
			() => 1,
			Symbol('s'),
			{
				toJSON() {
					throw new Error('boom');
				},
			},
		]) {
			const err = await caught(enqueue('a', payload));
			expect(err.code).toBe('TASK_INVALID_REQUEST');
			expect(err.cause).toBeUndefined();
		}
		expect(fake.requests).toEqual([]);
	});

	it.each([
		'',
		'   ',
		null,
		3,
	])('rejects an empty name as an invalid request (%j)', async (name) => {
		const fake = installFakeApi(ACCEPTED);
		const err = await caught(enqueue(name as string, null));
		expect(err.code).toBe('TASK_INVALID_REQUEST');
		expect(fake.requests).toEqual([]);
	});

	it.each([
		'',
		null,
	])('rejects an empty task id as an invalid request (%j)', async (taskId) => {
		const fake = installFakeApi([200, '{}']);
		const err = await caught(get(taskId as string));
		expect(err.code).toBe('TASK_INVALID_REQUEST');
		expect(fake.requests).toEqual([]);
	});

	it.each([
		['http-error', [404, 'not found'] as Answer],
		['empty', [200, ''] as Answer],
		['whitespace', [200, 'two words'] as Answer],
		['unreachable', connectionRefused()],
		['timeout', timedOut()],
	])('does not retry an identity token failure (%s)', async (_name, tokenAnswer) => {
		const fake = installFakeApi(ACCEPTED);
		fake.tokenAnswer = tokenAnswer;
		const err = await caught(get('t-1'));
		expect(err.code).toBe('TASKS_IDENTITY_TOKEN_ERROR');
		expect(err.status).toBeNull();
		expect(fake.tokenRequests).toHaveLength(1);
		expect(fake.requests).toEqual([]);
		expect(state.slept).toEqual([]);
	});

	it('error message never contains the payload', async () => {
		const marker = 'PAYLOAD-SECRET-7f3a';
		installFakeApi(TRANSIENT_503);
		const errors: TasksError[] = [];
		const capture = async (promise: Promise<unknown>) => {
			errors.push(await caught(promise));
		};
		const loop: unknown[] = [marker];
		loop.push(loop);

		await capture(enqueue('a', loop)); // not serializable
		await capture(enqueue('a', { secret: marker.repeat(10000) })); // too large
		await capture(enqueue('a', { secret: marker }, { idempotencyKey: '\n' }));
		await capture(enqueue('a', { secret: marker })); // transient, no key
		await capture(enqueue('a', { secret: marker }, { idempotencyKey: 'k' }));
		installFakeApi([
			400,
			'{"error":{"code":"TASK_INVALID_REQUEST","message":"bad"}}',
		]);
		await capture(enqueue('a', { secret: marker }));
		installFakeApi([202, 'not json']);
		await capture(enqueue('a', { secret: marker }));

		expect(errors).toHaveLength(7);
		for (const error of errors) {
			expect(String(error)).not.toContain(marker);
			expect(error.message).not.toContain(marker);
			expect(error.stack ?? '').not.toContain(marker);
			// No chained error carries the payload either.
			expect(error.cause).toBeUndefined();
		}
	});

	it('resolves the mode on every call', async () => {
		const fake = installFakeApi(ACCEPTED);
		await enqueue('a', null);
		setEnv({ KEELSON_APP_ID: 'app_456' });
		await enqueue('a', null);
		expect(fake.requests.map((r) => r.url.split('/')[5])).toEqual([
			'app_123',
			'app_456',
		]);
		delete process.env.KEELSON_TASKS_BASE_URL;
		const err = await caught(enqueue('a', null));
		expect(err.code).toBe('TASKS_NOT_CONFIGURED');
		expect(err.message).toContain('tasks:');
	});
});

// ---------------------------------------------------------------------------
// Against a real local HTTP server (the real fetch)
// ---------------------------------------------------------------------------

interface Hit {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: string;
}

async function withServer(
	routes: Record<string, [number, Record<string, string>, string]>,
	fn: (
		url: string,
		hits: Hit[],
		routes: Record<string, [number, Record<string, string>, string]>,
	) => Promise<void>,
): Promise<void> {
	const hits: Hit[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			hits.push({
				method: req.method ?? '',
				url: req.url ?? '',
				headers: req.headers,
				body: Buffer.concat(chunks).toString('utf8'),
			});
			const path = new URL(req.url ?? '/', 'http://x').pathname;
			const [status, headers, body] = routes[path] ?? [404, {}, ''];
			res.writeHead(status, headers);
			res.end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	setEnv({
		KEELSON_MODE: 'keelson',
		KEELSON_APP_ID: 'app_123',
		KEELSON_TASKS_BASE_URL: url,
		KEELSON_TASKS_METADATA_URL: `${url}/identity`,
	});
	try {
		await fn(url, hits, routes);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

describe('remote backend over real HTTP', () => {
	useCleanTasksState();

	it('round-trips enqueue and get', async () => {
		const routes: Record<string, [number, Record<string, string>, string]> = {
			'/identity': [200, {}, TOKEN],
			'/internal/apps/app_123/tasks/a/enqueue': [202, {}, '{"task_id":"t-9"}'],
			'/internal/apps/app_123/tasks/t-9': [
				404,
				{ 'Content-Type': 'application/json' },
				'{"error":{"code":"TASK_NOT_FOUND","message":"no"}}',
			],
		};
		await withServer(routes, async (url, hits) => {
			expect(await enqueue('a', [1, 2], { idempotencyKey: 'k' })).toBe('t-9');
			const err = await caught(get('t-9'));
			expect([err.code, err.status]).toEqual(['TASK_NOT_FOUND', 404]);

			const [tokenHit, enqueueHit] = hits;
			expect(
				new URL(tokenHit.url, url).searchParams.getAll('audience'),
			).toEqual([url]);
			expect(tokenHit.headers['metadata-flavor']).toBe('Google');
			expect(enqueueHit.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(enqueueHit.body).toBe('{"payload":[1,2],"idempotency_key":"k"}');
		});
	});

	it('does not follow a redirect', async () => {
		await withServer({}, async (url, hits, routes) => {
			// Routes are looked up per request, so filling them in now works.
			Object.assign(routes, {
				'/identity': [200, {}, TOKEN],
				'/internal/apps/app_123/tasks/a/enqueue': [
					302,
					{ Location: `${url}/elsewhere` },
					'',
				],
				'/elsewhere': [202, {}, '{"task_id":"stolen"}'],
			});
			const err = await caught(enqueue('a', null, { idempotencyKey: 'k' }));
			expect([err.code, err.status]).toEqual(['TASKS_HTTP_ERROR', 302]);
			expect(hits.every((hit) => !hit.url.startsWith('/elsewhere'))).toBe(true);
		});
	});
});
