/** Parity: the shared `tasks_*.json` fixtures, through the real SDK paths. */

import { describe, expect, it } from 'vitest';
import { httpError, resolveMode } from '../src/client.js';
import { enqueue, get, TasksError } from '../src/index.js';
import {
	connectionRefused,
	installFakeApi,
	installFakeCli,
	loadFixture,
	setEnv,
	timedOut,
	useCleanTasksState,
	useTempDir,
} from './helpers.js';

interface ModeCase {
	name: string;
	env: Record<string, string>;
	expected: {
		mode?: 'remote' | 'local';
		audience?: string;
		api_base?: string;
		app_id?: string;
		error_code?: string;
	};
}

interface HttpCase {
	name: string;
	status: number;
	body: string;
	expected: { code: string; status: number; transient: boolean };
}

interface TransportCase {
	name: string;
	failure: 'connection_error' | 'timeout';
	expected: { code: string; transient: boolean };
}

interface ResponseCase {
	name: string;
	status?: number;
	body: string;
	expected: {
		status?: Record<string, unknown>;
		task_id?: string;
		error_code?: string;
	};
}

interface LocalCase {
	name: string;
	stdout?: unknown;
	stdout_text?: string;
	sdk: {
		task_id?: string;
		status?: Record<string, unknown>;
		error_code?: string;
	};
}

const MODE = loadFixture<{ env_vars: string[]; cases: ModeCase[] }>(
	'tasks_mode_resolution.json',
);
const ERRORS = loadFixture<{ http: HttpCase[]; transport: TransportCase[] }>(
	'tasks_error_mapping.json',
);
const RESPONSES = loadFixture<{ get: ResponseCase[]; enqueue: ResponseCase[] }>(
	'tasks_get_response.json',
);
const LOCAL = loadFixture<{
	argv: string[];
	task_keys: string[];
	cases: LocalCase[];
}>('tasks_local_cli_result.json');

async function caught(promise: Promise<unknown>): Promise<TasksError> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(TasksError);
		return err as TasksError;
	}
	throw new Error('expected a TasksError');
}

function caughtSync(fn: () => unknown): TasksError {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(TasksError);
		return err as TasksError;
	}
	throw new Error('expected a TasksError');
}

function setModeEnv(c: ModeCase): void {
	for (const name of MODE.env_vars) delete process.env[name];
	setEnv(c.env);
}

describe('parity: tasks_mode_resolution.json', () => {
	useCleanTasksState();

	it.each(
		MODE.cases.map((c) => [c.name, c] as const),
	)('mode resolution matches the parity fixture: %s', (_name, c) => {
		setModeEnv(c);
		// --- Cross-language parity assertions ---
		if (c.expected.error_code !== undefined) {
			const err = caughtSync(() => resolveMode());
			expect(err.code).toBe(c.expected.error_code);
			expect(err.status).toBeNull();
			return;
		}
		const resolved = resolveMode();
		if (c.expected.mode === 'local') {
			expect(resolved).toBeNull();
		} else {
			expect(resolved).toEqual({
				audience: c.expected.audience,
				apiBase: c.expected.api_base,
				appId: c.expected.app_id,
			});
		}
	});

	const modeErrors = MODE.cases.filter(
		(c) => c.expected.error_code !== undefined,
	);
	it.each(
		modeErrors.map((c) => [c.name, c] as const),
	)('public calls fail closed per the mode fixture: %s', async (_name, c) => {
		setModeEnv(c);
		process.env.PATH = '';
		for (const call of [() => enqueue('a', null), () => get('t')]) {
			const err = await caught(call());
			expect(err.code).toBe('TASKS_NOT_CONFIGURED');
		}
	});
});

describe('parity: tasks_error_mapping.json', () => {
	const state = useCleanTasksState();

	it.each(
		ERRORS.http.map((c) => [c.name, c] as const),
	)('http errors map per the parity fixture: %s', async (_name, c) => {
		// --- Cross-language parity assertions ---
		const { error, transient } = httpError(c.status, c.body);
		expect([error.code, error.status, transient]).toEqual([
			c.expected.code,
			c.expected.status,
			c.expected.transient,
		]);

		// The same answer through get (always retried on transient errors).
		const fake = installFakeApi([c.status, c.body]);
		const err = await caught(get('t-1'));
		expect([err.code, err.status]).toEqual([
			c.expected.code,
			c.expected.status,
		]);
		expect(fake.requests).toHaveLength(c.expected.transient ? 3 : 1);
		expect(state.slept).toEqual(c.expected.transient ? [500, 1000] : []);
	});

	const failures = {
		connection_error: connectionRefused,
		timeout: timedOut,
	};
	it.each(
		ERRORS.transport.map((c) => [c.name, c] as const),
	)('transport errors map per the parity fixture: %s', async (_name, c) => {
		const fake = installFakeApi(failures[c.failure]());
		// --- Cross-language parity assertions ---
		const err = await caught(get('t-1'));
		expect(err.code).toBe(c.expected.code);
		expect(err.status).toBeNull();
		expect(fake.requests).toHaveLength(c.expected.transient ? 3 : 1);
		expect(state.slept).toEqual(c.expected.transient ? [500, 1000] : []);
	});
});

describe('parity: tasks_get_response.json', () => {
	useCleanTasksState();

	it.each(
		RESPONSES.get.map((c) => [c.name, c] as const),
	)('get response parses per the parity fixture: %s', async (_name, c) => {
		installFakeApi([200, c.body]);
		// --- Cross-language parity assertions ---
		if (c.expected.error_code !== undefined) {
			const err = await caught(get('t-1'));
			expect(err.code).toBe(c.expected.error_code);
			expect(err.status).toBe(200);
			return;
		}
		const status = await get('t-1');
		// Exactly the seven fields: unknown response fields are dropped.
		expect({ ...status }).toStrictEqual(c.expected.status);
	});

	it.each(
		RESPONSES.enqueue.map((c) => [c.name, c] as const),
	)('enqueue response parses per the parity fixture: %s', async (_name, c) => {
		installFakeApi([c.status as number, c.body]);
		// --- Cross-language parity assertions ---
		if (c.expected.error_code !== undefined) {
			const err = await caught(enqueue('generate-pdf', { order_id: 1 }));
			expect(err.code).toBe(c.expected.error_code);
			expect(err.status).toBe(c.status);
			return;
		}
		expect(await enqueue('generate-pdf', { order_id: 1 })).toBe(
			c.expected.task_id,
		);
	});
});

describe.skipIf(process.platform === 'win32')(
	'parity: tasks_local_cli_result.json',
	() => {
		useCleanTasksState();
		const tmp = useTempDir();

		it('the fixture argv and task keys match the SDK', () => {
			expect(LOCAL.argv).toEqual([
				'dev',
				'task',
				'run',
				'<name>',
				'--payload',
				'-',
				'--json',
			]);
			// The seven get fields are exactly the task keys minus the local two.
			const fields = Object.keys(
				LOCAL.cases.find((c) => c.sdk.status)?.sdk.status ?? {},
			).sort();
			expect(fields).toEqual(
				LOCAL.task_keys
					.filter((k) => k !== 'exit_code' && k !== 'timed_out')
					.sort(),
			);
		});

		it.each(
			LOCAL.cases.map((c) => [c.name, c] as const),
		)('local CLI result maps per the parity fixture: %s', async (_name, c) => {
			const fake = installFakeCli(tmp.path);
			if (c.stdout_text !== undefined) fake.setStdoutText(c.stdout_text);
			else fake.setStdout(c.stdout);
			// --- Cross-language parity assertions ---
			if (c.sdk.error_code !== undefined) {
				const err = await caught(enqueue('generate-pdf', { order_id: 1 }));
				expect(err.code).toBe(c.sdk.error_code);
				expect(err.status).toBeNull();
				if (c.sdk.error_code === 'TASKS_LOCAL_CLI_FAILED') {
					expect(err.message).toContain('keelson upgrade');
				}
				return;
			}
			const taskId = await enqueue('generate-pdf', { order_id: 1 });
			expect(taskId).toBe(c.sdk.task_id);
			expect({ ...(await get(taskId)) }).toStrictEqual(c.sdk.status);
			const calls = fake.calls();
			expect(calls).toHaveLength(1);
			expect(calls[0].argv).toEqual(
				LOCAL.argv.map((arg) => (arg === '<name>' ? 'generate-pdf' : arg)),
			);
		});
	},
);
