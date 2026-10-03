/** Local backend: `keelson dev task run` per enqueue, results in-process. */

import { spawnSync } from 'node:child_process';
import { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { enqueue, get, TasksError } from '../src/index.js';
import {
	installFakeCli,
	taskResult,
	useCleanTasksState,
	useTempDir,
} from './helpers.js';

async function caught(promise: Promise<unknown>): Promise<TasksError> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(TasksError);
		return err as TasksError;
	}
	throw new Error('expected a TasksError');
}

// The fake CLI is a POSIX shebang script.
describe.skipIf(process.platform === 'win32')('local backend', () => {
	useCleanTasksState();
	const tmp = useTempDir();

	it('local enqueue runs the CLI and get returns the result', async () => {
		const fake = installFakeCli(tmp.path);

		const taskId = await enqueue('Generate-PDF', { order_id: 1, note: 'é' });

		const calls = fake.calls();
		expect(calls).toHaveLength(1);
		// The name goes as given (the CLI normalizes it); only the payload is on stdin.
		expect(calls[0].argv).toEqual([
			'dev',
			'task',
			'run',
			'Generate-PDF',
			'--payload',
			'-',
			'--json',
		]);
		expect(calls[0].stdin).toBe('{"order_id":1,"note":"é"}');
		// The CLI runs in the app's working directory (keelson.yaml is found there).
		expect(realpathSync(calls[0].cwd)).toBe(realpathSync(process.cwd()));
		const status = await get(taskId);
		expect({ ...status }).toStrictEqual({
			task_id: taskId,
			name: 'generate-pdf',
			status: 'succeeded',
			claimed_attempts: 1,
			last_failure_code: null,
			created_at: '2026-10-02T03:04:05.000000Z',
			finished_at: '2026-10-02T03:04:06.000000Z',
		});
		expect('exit_code' in status).toBe(false);
	});

	it('a failed command is not an enqueue error', async () => {
		// The CLI exits 1 when the command failed; stdout alone decides.
		installFakeCli(
			tmp.path,
			taskResult({
				status: 'failed',
				last_failure_code: 'exit_nonzero',
				exit_code: 3,
			}),
		);
		process.env.FAKE_KEELSON_EXIT = '1';
		const status = await get(await enqueue('generate-pdf'));
		expect([status.status, status.last_failure_code]).toEqual([
			'failed',
			'exit_nonzero',
		]);
	});

	it('the payload defaults to null', async () => {
		const fake = installFakeCli(tmp.path);
		await enqueue('generate-pdf');
		expect(fake.calls()[0].stdin).toBe('null');
	});

	it('CLI stderr goes to the app stderr, not into the result', async () => {
		installFakeCli(tmp.path);
		// Run the built SDK in a child Node so its fd 2 can be captured: the
		// SDK hands its own stderr to the CLI.
		const outDir = join(tmp.path, 'dist');
		const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
		const build = spawnSync(
			process.execPath,
			[
				tsc,
				'-p',
				fileURLToPath(new URL('..', import.meta.url)),
				'--outDir',
				outDir,
			],
			{ encoding: 'utf8' },
		);
		expect(build.status, build.stdout).toBe(0);
		const script = join(tmp.path, 'run.mjs');
		writeFileSync(
			script,
			`const { enqueue } = await import(${JSON.stringify(
				pathToFileURL(join(outDir, 'index.js')).href,
			)});\nprocess.stdout.write(await enqueue('generate-pdf'));\n`,
		);
		const result = spawnSync(process.execPath, [script], {
			encoding: 'utf8',
			env: process.env,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain('fake-cli-stderr');
		expect(result.stdout).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('does not block the event loop while the CLI runs', async () => {
		installFakeCli(tmp.path);
		process.env.FAKE_KEELSON_SLEEP_MS = '300';
		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 20);
		try {
			await enqueue('generate-pdf');
		} finally {
			clearInterval(timer);
		}
		expect(ticks).toBeGreaterThan(3);
	});

	it('local same key does not rerun the CLI', async () => {
		const fake = installFakeCli(tmp.path);

		const first = await enqueue(
			'generate-pdf',
			{ n: 1 },
			{ idempotencyKey: 'k1' },
		);
		// Same normalized name + key: the existing task_id, no new run.
		expect(
			await enqueue(' Generate-PDF ', { n: 2 }, { idempotencyKey: 'k1' }),
		).toBe(first);
		expect(fake.calls()).toHaveLength(1);

		// A different key, or no key, runs again.
		const otherKey = await enqueue(
			'generate-pdf',
			{ n: 1 },
			{ idempotencyKey: 'k2' },
		);
		const noKey1 = await enqueue('generate-pdf', { n: 1 });
		const noKey2 = await enqueue('generate-pdf', { n: 1 });
		expect(fake.calls()).toHaveLength(4);
		expect(new Set([first, otherKey, noKey1, noKey2]).size).toBe(4);
	});

	it('a failed CLI run does not claim the key', async () => {
		const fake = installFakeCli(tmp.path, {
			error: { code: 'TASK_NOT_DECLARED', message: 'no' },
		});
		await caught(enqueue('generate-pdf', null, { idempotencyKey: 'k1' }));
		fake.setStdout(taskResult());
		const taskId = await enqueue('generate-pdf', null, {
			idempotencyKey: 'k1',
		});
		expect((await get(taskId)).status).toBe('succeeded');
		expect(fake.calls()).toHaveLength(2);
	});

	it('concurrent calls with the same key keep the first mapping', async () => {
		const fake = installFakeCli(tmp.path);
		const results = await Promise.all([
			enqueue('generate-pdf', null, { idempotencyKey: 'k' }),
			enqueue('generate-pdf', null, { idempotencyKey: 'k' }),
		]);
		// Both ran the CLI; each gets its own task, and both are readable.
		expect(fake.calls()).toHaveLength(2);
		expect(new Set(results).size).toBe(2);
		for (const taskId of results) {
			expect((await get(taskId)).status).toBe('succeeded');
		}
		// Later calls with the key return whichever finished first.
		const again = await enqueue('generate-pdf', null, { idempotencyKey: 'k' });
		expect(results).toContain(again);
		expect(fake.calls()).toHaveLength(2);
	});

	it('get of an unknown id is TASK_NOT_FOUND', async () => {
		installFakeCli(tmp.path);
		const err = await caught(get('0b9f3f8e-5c1d-4a7b-9e2f-1d2c3b4a5f60'));
		expect([err.code, err.status]).toEqual(['TASK_NOT_FOUND', null]);
	});

	it('local missing CLI error has the install hint', async () => {
		process.env.KEELSON_MODE = 'local';
		process.env.PATH = tmp.path;
		const err = await caught(enqueue('generate-pdf', { order_id: 1 }));
		expect(err.code).toBe('TASKS_LOCAL_CLI_NOT_FOUND');
		expect(err.message).toContain('`keelson` was not found');
		expect(err.message).toContain('https://keelson.dev/install.sh');
	});

	it('a CLI that is not executable is TASKS_LOCAL_CLI_FAILED', async () => {
		installFakeCli(tmp.path);
		// Present on PATH but not executable.
		chmodSync(join(tmp.path, 'bin', 'keelson'), 0o644);
		const err = await caught(enqueue('generate-pdf'));
		expect(err.code).toBe('TASKS_LOCAL_CLI_FAILED');
		expect(err.message).toContain('EACCES');
	});

	it.each([
		'--json',
		'-x',
		'bad name',
		'a'.repeat(64),
		'ä',
		'a_b',
	])('an undeclarable name is TASK_NOT_DECLARED without running the CLI (%j)', async (name) => {
		const fake = installFakeCli(tmp.path);
		const err = await caught(enqueue(name));
		expect(err.code).toBe('TASK_NOT_DECLARED');
		expect(fake.calls()).toEqual([]);
	});

	it('runs the same prechecks as remote', async () => {
		const fake = installFakeCli(tmp.path);
		const loop: unknown[] = [];
		loop.push(loop);
		for (const [promise, code] of [
			[enqueue('generate-pdf', 'x'.repeat(65536)), 'TASK_PAYLOAD_TOO_LARGE'],
			[enqueue('generate-pdf', loop), 'TASK_INVALID_REQUEST'],
			[
				enqueue('generate-pdf', null, { idempotencyKey: '' }),
				'TASK_INVALID_REQUEST',
			],
			[enqueue('', null), 'TASK_INVALID_REQUEST'],
		] as const) {
			expect((await caught(promise)).code).toBe(code);
		}
		expect(fake.calls()).toEqual([]);
	});

	it('local CLI error message never contains the payload', async () => {
		const marker = 'PAYLOAD-SECRET-7f3a';
		const fake = installFakeCli(tmp.path);
		for (const stdout of [
			{ error: { code: 'task_interrupted', message: 'stopped' } },
			{ error: { code: 'TASK_INVALID_REQUEST', message: 'bad' } },
			{ task: { task_id: 'x' } },
			null,
		]) {
			if (stdout === null) fake.setStdoutText('garbage\n');
			else fake.setStdout(stdout);
			const err = await caught(enqueue('generate-pdf', { secret: marker }));
			expect(String(err)).not.toContain(marker);
			expect(err.message).not.toContain(marker);
			expect(err.cause).toBeUndefined();
		}
		expect(
			fake.calls().every((call) => JSON.parse(call.stdin).secret === marker),
		).toBe(true);
	});
});
