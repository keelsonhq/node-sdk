/**
 * Shared test helpers: env scoping, a fake metadata server + runtime API on
 * `globalThis.fetch`, and a fake `keelson` CLI on PATH.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { resolveParityFixturesDir } from '../../test-fixtures.js';
import {
	resetLocalStateForTesting,
	setSleepForTesting,
} from '../src/client.js';

export const BASE_URL = 'https://keelson-runtime-api-abc123-an.a.run.app';
export const METADATA_URL = 'http://metadata.example/identity';
export const TOKEN = 'header.claims.signature';

export const REMOTE_ENV = {
	KEELSON_MODE: 'keelson',
	KEELSON_TASKS_BASE_URL: BASE_URL,
	KEELSON_APP_ID: 'app_123',
	KEELSON_TASKS_METADATA_URL: METADATA_URL,
} as const;

const SCOPED_ENVS = [
	'KEELSON_MODE',
	'KEELSON_TASKS_BASE_URL',
	'KEELSON_APP_ID',
	'KEELSON_WORKSPACE_ID',
	'KEELSON_TENANT_ID',
	'KEELSON_DEPLOY_ID',
	'KEELSON_TASKS_METADATA_URL',
	'PATH',
	'FAKE_KEELSON_LOG',
	'FAKE_KEELSON_STDOUT',
	'FAKE_KEELSON_EXIT',
	'FAKE_KEELSON_SLEEP_MS',
];

export function loadFixture<T = Record<string, unknown>>(name: string): T {
	return JSON.parse(
		readFileSync(
			resolve(resolveParityFixturesDir(import.meta.url), name),
			'utf-8',
		),
	) as T;
}

/**
 * Per test: clear the Tasks env (restored afterwards), forget local state,
 * record retry waits instead of sleeping, and restore `fetch`.
 */
export function useCleanTasksState(): { slept: number[] } {
	const state = { slept: [] as number[] };
	const saved: Record<string, string | undefined> = {};
	const originalFetch = globalThis.fetch;
	let previousSleep: ((ms: number) => Promise<void>) | null = null;
	beforeEach(() => {
		for (const name of SCOPED_ENVS) {
			saved[name] = process.env[name];
			if (name !== 'PATH') delete process.env[name];
		}
		resetLocalStateForTesting();
		state.slept.length = 0;
		previousSleep = setSleepForTesting(async (ms) => {
			state.slept.push(ms);
		});
	});
	afterEach(() => {
		for (const name of SCOPED_ENVS) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
		resetLocalStateForTesting();
		if (previousSleep) setSleepForTesting(previousSleep);
		globalThis.fetch = originalFetch;
	});
	return state;
}

export function setEnv(vars: Record<string, string>): void {
	for (const [name, value] of Object.entries(vars)) process.env[name] = value;
}

/** A scripted answer: `[status, body]`, or an error for fetch to throw. */
export type Answer = [number, string] | Error;

export interface RecordedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Uint8Array | null;
	redirect: RequestRedirect | undefined;
	hasSignal: boolean;
}

/** Records every request; answers from `answers` (FIFO, last one sticks). */
export class FakeApi {
	answers: Answer[];
	requests: RecordedRequest[] = [];
	tokenRequests: RecordedRequest[] = [];
	tokenAnswer: Answer = [200, TOKEN];

	constructor(...answers: Answer[]) {
		this.answers = answers.length ? answers : [[202, '{"task_id":"t-1"}']];
	}

	install(): this {
		globalThis.fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input.toString();
				const recorded: RecordedRequest = {
					method: (init?.method ?? 'GET').toUpperCase(),
					url,
					headers: Object.fromEntries(
						Object.entries((init?.headers ?? {}) as Record<string, string>).map(
							([k, v]) => [k.toLowerCase(), v],
						),
					),
					body: (init?.body as Uint8Array | null | undefined) ?? null,
					redirect: init?.redirect,
					hasSignal: init?.signal instanceof AbortSignal,
				};
				if (url.startsWith(METADATA_URL)) {
					this.tokenRequests.push(recorded);
					return answer(this.tokenAnswer);
				}
				this.requests.push(recorded);
				const next =
					this.answers.length === 1 ? this.answers[0] : this.answers.shift();
				return answer(next as Answer);
			},
		) as typeof fetch;
		return this;
	}

	audiences(): string[] {
		return this.tokenRequests.map(
			(request) => new URL(request.url).searchParams.get('audience') ?? '',
		);
	}
}

function answer(value: Answer): Response {
	if (value instanceof Error) throw value;
	const [status, body] = value;
	return new Response(status === 204 || status === 304 ? null : body, {
		status,
	});
}

export function installFakeApi(...answers: Answer[]): FakeApi {
	setEnv(REMOTE_ENV);
	return new FakeApi(...answers).install();
}

/** What undici's fetch throws when the connection is refused. */
export function connectionRefused(): Error {
	return new TypeError('fetch failed', {
		cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
			code: 'ECONNREFUSED',
		}),
	});
}

/** What `AbortSignal.timeout` makes fetch throw. */
export function timedOut(): Error {
	return new DOMException(
		'The operation was aborted due to timeout',
		'TimeoutError',
	);
}

const FAKE_CLI = `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_KEELSON_LOG, JSON.stringify({
  argv: process.argv.slice(2), stdin, cwd: process.cwd(),
}) + '\\n');
process.stderr.write('fake-cli-stderr\\n');
const out = fs.readFileSync(process.env.FAKE_KEELSON_STDOUT, 'utf8')
  .replaceAll('@ID@', crypto.randomUUID());
const finish = () => {
  process.stdout.write(out);
  process.exitCode = Number(process.env.FAKE_KEELSON_EXIT || '0');
};
const delay = Number(process.env.FAKE_KEELSON_SLEEP_MS || '0');
if (delay > 0) setTimeout(finish, delay); else finish();
`;

export interface CliCall {
	argv: string[];
	stdin: string;
	cwd: string;
}

export class FakeCli {
	readonly root: string;
	readonly binDir: string;
	readonly log: string;
	readonly stdoutFile: string;

	constructor(root: string) {
		this.root = root;
		this.binDir = join(root, 'bin');
		this.log = join(root, 'cli.log');
		this.stdoutFile = join(root, 'cli.stdout');
	}

	setStdout(value: unknown): void {
		this.setStdoutText(`${JSON.stringify(value)}\n`);
	}

	setStdoutText(text: string): void {
		writeFileSync(this.stdoutFile, text, 'utf-8');
	}

	calls(): CliCall[] {
		if (!existsSync(this.log)) return [];
		return readFileSync(this.log, 'utf-8')
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => JSON.parse(line) as CliCall);
	}
}

export function taskResult(
	overrides: {
		task_id?: string;
		name?: string;
		status?: string;
		last_failure_code?: string | null;
		exit_code?: number | null;
	} = {},
): { task: Record<string, unknown> } {
	return {
		task: {
			task_id: overrides.task_id ?? '@ID@',
			name: overrides.name ?? 'generate-pdf',
			status: overrides.status ?? 'succeeded',
			claimed_attempts: 1,
			last_failure_code: overrides.last_failure_code ?? null,
			created_at: '2026-10-02T03:04:05.000000Z',
			finished_at: '2026-10-02T03:04:06.000000Z',
			exit_code: overrides.exit_code === undefined ? 0 : overrides.exit_code,
			timed_out: false,
		},
	};
}

/** A temp dir removed after the current test. */
export function useTempDir(): { path: string } {
	const dir = { path: '' };
	beforeEach(() => {
		dir.path = mkdtempSync(join(tmpdir(), 'keelson-tasks-'));
	});
	afterEach(() => {
		rmSync(dir.path, { recursive: true, force: true });
	});
	return dir;
}

/** Put a fake `keelson` alone on PATH and switch to local mode. */
export function installFakeCli(root: string, stdout?: unknown): FakeCli {
	const fake = new FakeCli(root);
	mkdirSync(fake.binDir, { recursive: true });
	const script = join(fake.binDir, 'keelson');
	writeFileSync(script, FAKE_CLI, 'utf-8');
	chmodSync(script, 0o755);
	fake.setStdout(stdout === undefined ? taskResult() : stdout);
	setEnv({
		PATH: fake.binDir,
		FAKE_KEELSON_LOG: fake.log,
		FAKE_KEELSON_STDOUT: fake.stdoutFile,
		KEELSON_MODE: 'local',
	});
	return fake;
}
