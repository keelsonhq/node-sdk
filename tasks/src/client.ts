/**
 * Keelson Tasks SDK — enqueue background tasks declared under `tasks:`.
 *
 * Backends:
 *
 * - Keelson (remote): `POST` / `GET` on the runtime API at
 *   `KEELSON_TASKS_BASE_URL`, authenticated with an OIDC id token from the
 *   metadata server whose audience is that URL. The command then runs later on
 *   a separate instance, with platform retries.
 * - local: `enqueue` starts `keelson dev task run <name> --payload - --json`
 *   (the CLI on PATH), which runs the declared command once, synchronously,
 *   and prints one JSON result. Results are kept in this process only, so
 *   `get` knows only tasks enqueued here. No retry.
 *
 * Mode resolution: `KEELSON_MODE` is the single mode signal, and the SDK never
 * silently falls back to local execution on Keelson. See {@link resolveMode}.
 *
 * Errors are one type, {@link TasksError}, branched on `code`: the runtime
 * API's codes pass through (`TASK_NOT_DECLARED`, `TASKS_UNAVAILABLE`, ...),
 * and the SDK's own codes start with `TASKS_` (`TASKS_UNAVAILABLE_TRANSIENT`,
 * `TASKS_FORBIDDEN`, ...). The payload never appears in an error message.
 */

import { spawn } from 'node:child_process';

const SDK_USER_AGENT = 'Keelson-Node-SDK/0.1.0';

/** Per HTTP call (metadata server and runtime API). */
const TIMEOUT_MS = 15_000;

/** The platform's limit, measured on the whole request body the server receives. */
export const MAX_BODY_BYTES = 65536;
/** 1-128 printable ASCII characters (U+0020-U+007E). */
const IDEMPOTENCY_KEY_RE = /^[\x20-\x7e]{1,128}$/;

/** Transient failures: 3 attempts in total, waiting 0.5 s then 1 s. */
const RETRY_DELAYS_MS = [500, 1000] as const;

// The identity endpoint, up to (not including) `?audience=`. The env override
// is an SDK-internal test seam, NOT part of the platform-injected env contract.
const DEFAULT_METADATA_URL =
	'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

const INSTALL_URL = 'https://keelson.dev/install.sh';

/** Platform-owned identifiers whose presence means the app is running on Keelson. */
const CORE_IDENTIFIER_ENVS = [
	'KEELSON_APP_ID',
	'KEELSON_WORKSPACE_ID',
	'KEELSON_TENANT_ID',
	'KEELSON_DEPLOY_ID',
] as const;

/** Declared task names (keelson-yaml-spec § 4A), after trim + lowercase. */
const TASK_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RFC3339_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** CLI error codes that mean the same as the runtime API's and pass through. */
const LOCAL_PASSTHROUGH_CODES = new Set([
	'TASK_NOT_DECLARED',
	'TASK_INVALID_REQUEST',
	'TASK_PAYLOAD_TOO_LARGE',
]);

/**
 * Every Tasks failure. Branch on `code`; `status` is the HTTP status of the
 * runtime API response, or `null` when there was none.
 */
export class TasksError extends Error {
	readonly code: string;
	readonly status: number | null;

	constructor(code: string, message: string, status: number | null = null) {
		super(message);
		this.name = 'TasksError';
		this.code = code;
		this.status = status;
	}
}

/**
 * A task's state, with the runtime API's field names (§ 9.3). Timestamps are
 * RFC 3339 strings.
 */
export interface TaskStatus {
	task_id: string;
	name: string;
	status: string;
	claimed_attempts: number;
	last_failure_code: string | null;
	created_at: string;
	finished_at: string | null;
}

export interface EnqueueOptions {
	/**
	 * 1-128 printable ASCII characters. A repeat with the same key returns the
	 * existing `task_id`, and lets the SDK retry transient failures.
	 */
	idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export interface RemoteTarget {
	audience: string;
	apiBase: string;
	appId: string;
}

function env(name: string): string {
	return (process.env[name] ?? '').trim();
}

function notConfigured(message: string): TasksError {
	return new TasksError('TASKS_NOT_CONFIGURED', message);
}

/**
 * Resolve the backend: a {@link RemoteTarget} for Keelson, `null` for local.
 *
 * - `KEELSON_MODE=keelson` → remote. `KEELSON_TASKS_BASE_URL` and
 *   `KEELSON_APP_ID` are required; either missing → `TASKS_NOT_CONFIGURED`.
 * - `KEELSON_MODE=local` → local.
 * - `KEELSON_MODE` unset → local, unless a platform identifier is visible, in
 *   which case the silent local fallback is refused. The remote env is **not**
 *   consulted here.
 * - Any other value → `TASKS_NOT_CONFIGURED`.
 */
export function resolveMode(): RemoteTarget | null {
	const mode = env('KEELSON_MODE').toLowerCase();
	if (mode === 'keelson') {
		const baseUrl = env('KEELSON_TASKS_BASE_URL');
		if (!baseUrl) {
			throw notConfigured(
				'KEELSON_MODE=keelson but KEELSON_TASKS_BASE_URL is unset; the ' +
					'platform injects it when keelson.yaml declares tasks: and the ' +
					'app is deployed.',
			);
		}
		const appId = env('KEELSON_APP_ID');
		if (!appId) {
			throw notConfigured(
				'KEELSON_MODE=keelson but KEELSON_APP_ID is unset; the Tasks ' +
					'capability is unavailable for this deployment.',
			);
		}
		return { audience: baseUrl, apiBase: baseUrl.replace(/\/+$/, ''), appId };
	}

	if (mode === 'local') return null;

	if (mode === '') {
		if (CORE_IDENTIFIER_ENVS.some((name) => env(name) !== '')) {
			throw notConfigured(
				'Platform environment detected (KEELSON_APP_ID / ' +
					'KEELSON_WORKSPACE_ID (or deprecated KEELSON_TENANT_ID alias) / ' +
					'KEELSON_DEPLOY_ID set) but KEELSON_MODE is unset; refusing to ' +
					'fall back to running tasks locally. Set KEELSON_MODE=local for ' +
					'local development or KEELSON_MODE=keelson on the platform.',
			);
		}
		return null;
	}

	throw notConfigured(
		`Unrecognized KEELSON_MODE="${mode}"; expected "keelson" or "local" ` +
			'(or unset for local development).',
	);
}

// ---------------------------------------------------------------------------
// Request validation (both modes)
// ---------------------------------------------------------------------------

function invalid(message: string): TasksError {
	return new TasksError('TASK_INVALID_REQUEST', message);
}

function checkName(name: unknown): string {
	if (typeof name !== 'string' || name.trim() === '') {
		throw invalid('The task name must be a non-empty string.');
	}
	return name;
}

function checkIdempotencyKey(key: unknown): string | undefined {
	if (key === undefined || key === null) return undefined;
	if (typeof key !== 'string' || !IDEMPOTENCY_KEY_RE.test(key)) {
		throw invalid(
			'The idempotency key must be 1-128 printable ASCII characters ' +
				'(U+0020-U+007E).',
		);
	}
	return key;
}

/** Serialize to JSON text. Never quotes the value in an error. */
function stringify(value: unknown): string {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		// Circular references, BigInt, or a throwing toJSON.
		text = undefined;
	}
	if (typeof text !== 'string') {
		throw invalid(
			'The task payload cannot be serialized as JSON (circular references, ' +
				'BigInt, functions, symbols and undefined are not allowed).',
		);
	}
	return text;
}

const encoder = new TextEncoder();

/**
 * The enqueue body and the payload text alone (what the local CLI reads).
 * The payload text is spliced in verbatim so both carry the same bytes.
 */
function requestBody(
	payload: unknown,
	idempotencyKey: string | undefined,
): { body: Uint8Array; payloadText: string } {
	const payloadText = stringify(payload);
	const keyPart =
		idempotencyKey === undefined
			? ''
			: `,"idempotency_key":${JSON.stringify(idempotencyKey)}`;
	const body = encoder.encode(`{"payload":${payloadText}${keyPart}}`);
	if (body.byteLength > MAX_BODY_BYTES) {
		throw new TasksError(
			'TASK_PAYLOAD_TOO_LARGE',
			`The enqueue request body is ${body.byteLength} bytes; the limit is ` +
				`${MAX_BODY_BYTES}. Store large data elsewhere (for example in the ` +
				'database) and pass its ID in the payload.',
		);
	}
	return { body, payloadText };
}

// ---------------------------------------------------------------------------
// Response parsing (both modes)
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isRfc3339(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const m = RFC3339_RE.exec(value);
	if (m === null) return false;
	const [year, month, day, hour, minute, second] = m
		.slice(1, 7)
		.map((part) => Number(part));
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return false;
	}
	if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) {
		return false;
	}
	return true;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map a § 9.3 object to {@link TaskStatus}, or `null` when invalid. Unknown
 * fields are ignored; an unknown `status` value is kept.
 */
export function parseStatus(obj: unknown): TaskStatus | null {
	if (!isObject(obj)) return null;
	const {
		task_id: taskId,
		name,
		status,
		claimed_attempts: attempts,
		last_failure_code: lastFailure,
		created_at: createdAt,
		finished_at: finishedAt,
	} = obj;
	if (
		!isNonEmptyString(taskId) ||
		!isNonEmptyString(name) ||
		!isNonEmptyString(status) ||
		typeof attempts !== 'number' ||
		!Number.isSafeInteger(attempts) ||
		attempts < 0 ||
		!isRfc3339(createdAt) ||
		!(lastFailure === null || typeof lastFailure === 'string') ||
		!(finishedAt === null || isRfc3339(finishedAt))
	) {
		return null;
	}
	return Object.freeze({
		task_id: taskId,
		name,
		status,
		claimed_attempts: attempts,
		last_failure_code: lastFailure,
		created_at: createdAt,
		finished_at: finishedAt,
	});
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function unexpected(status: number | null, what: string): TasksError {
	return new TasksError(
		'TASKS_UNEXPECTED_RESPONSE',
		`The Tasks API returned an unexpected ${what} response.`,
		status,
	);
}

function parseGetResponse(status: number, text: string): TaskStatus {
	const parsed = parseStatus(parseJson(text));
	if (parsed === null) throw unexpected(status, 'get');
	return parsed;
}

function parseEnqueueResponse(status: number, text: string): string {
	const obj = parseJson(text);
	const taskId = isObject(obj) ? obj.task_id : undefined;
	if (!isNonEmptyString(taskId)) throw unexpected(status, 'enqueue');
	return taskId;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** `[code, message]` from a `{"error": {"code": ...}}` body, or `null`. */
function envelope(text: string): [string, string] | null {
	const obj = parseJson(text);
	if (!isObject(obj) || !isObject(obj.error)) return null;
	const { code, message } = obj.error;
	if (!isNonEmptyString(code)) return null;
	return [code, isNonEmptyString(message) ? message : code];
}

function transientError(status: number | null, detail: string): TasksError {
	return new TasksError(
		'TASKS_UNAVAILABLE_TRANSIENT',
		`The Tasks API is temporarily unreachable (${detail}).`,
		status,
	);
}

/**
 * Classify a non-success response. The order is fixed (T-1037 design 3) and
 * the first hit wins.
 */
export function httpError(
	status: number,
	text: string,
): { error: TasksError; transient: boolean } {
	if (status === 401) {
		return {
			error: new TasksError(
				'TASKS_UNAUTHORIZED',
				'The Tasks API rejected the identity token (401).',
				status,
			),
			transient: false,
		};
	}
	if (status === 403) {
		return {
			error: new TasksError(
				'TASKS_FORBIDDEN',
				"This app's service account may not call the Tasks API (403). " +
					'Right after the first deploy that declares tasks:, the ' +
					'permission can take a few minutes to propagate.',
				status,
			),
			transient: false,
		};
	}
	const found = envelope(text);
	if (found !== null) {
		return {
			error: new TasksError(found[0], found[1], status),
			transient: false,
		};
	}
	if (TRANSIENT_STATUSES.has(status)) {
		return { error: transientError(status, `HTTP ${status}`), transient: true };
	}
	if (status >= 500 && status <= 599) {
		return {
			error: new TasksError(
				'TASKS_SERVER_ERROR',
				`The Tasks API failed with HTTP ${status}.`,
				status,
			),
			transient: false,
		};
	}
	return {
		error: new TasksError(
			'TASKS_HTTP_ERROR',
			`The Tasks API answered with HTTP ${status}.`,
			status,
		),
		transient: false,
	};
}

// ---------------------------------------------------------------------------
// Remote (runtime API) backend
// ---------------------------------------------------------------------------

let sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam: replace the retry wait. Returns the previous implementation. */
export function setSleepForTesting(
	impl: (ms: number) => Promise<void>,
): (ms: number) => Promise<void> {
	const previous = sleep;
	sleep = impl;
	return previous;
}

function metadataUrl(): string {
	return env('KEELSON_TASKS_METADATA_URL') || DEFAULT_METADATA_URL;
}

function describeError(err: unknown): string {
	if (err instanceof Error) {
		const cause = (err as { cause?: unknown }).cause;
		const detail =
			cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
		return `${err.name}: ${detail}`;
	}
	return String(err);
}

/** Fetch a fresh OIDC id token (never cached) for `audience`. */
async function identityToken(audience: string): Promise<string> {
	const url = `${metadataUrl()}?audience=${encodeURIComponent(audience)}`;
	let status: number;
	let text: string;
	try {
		const response = await fetch(url, {
			headers: { 'Metadata-Flavor': 'Google', 'User-Agent': SDK_USER_AGENT },
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		status = response.status;
		text = await response.text();
	} catch (err) {
		throw new TasksError(
			'TASKS_IDENTITY_TOKEN_ERROR',
			`Could not reach the metadata server for an identity token: ${describeError(err)}`,
		);
	}
	if (status < 200 || status > 299) {
		throw new TasksError(
			'TASKS_IDENTITY_TOKEN_ERROR',
			`The metadata server refused the identity token request (HTTP ${status}).`,
		);
	}
	const token = text.trim();
	if (token === '' || !/^[\x21-\x7e]+$/.test(token)) {
		throw new TasksError(
			'TASKS_IDENTITY_TOKEN_ERROR',
			'The metadata server returned no usable identity token.',
		);
	}
	return token;
}

interface CallOptions {
	method: 'GET' | 'POST';
	path: string;
	body: Uint8Array | null;
	okStatuses: ReadonlySet<number>;
	retry: boolean;
	noRetryHint?: string;
}

/** One runtime API call, retried on transient failures when `retry`. */
async function call(
	remote: RemoteTarget,
	opts: CallOptions,
): Promise<{ status: number; text: string }> {
	const url = `${remote.apiBase}${opts.path}`;
	const attempts = opts.retry ? RETRY_DELAYS_MS.length + 1 : 1;
	let error: TasksError | null = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${await identityToken(remote.audience)}`,
			'User-Agent': SDK_USER_AGENT,
		};
		if (opts.body !== null) headers['Content-Type'] = 'application/json';
		let status: number;
		let text: string;
		try {
			// Never follow a redirect: it would carry the bearer token elsewhere.
			const response = await fetch(url, {
				method: opts.method,
				headers,
				body: opts.body,
				redirect: 'manual',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			status = response.status;
			text = await response.text();
		} catch (err) {
			// Connection failures, timeouts, and a body cut off mid-read.
			error = transientError(null, describeError(err));
			continue;
		}
		if (opts.okStatuses.has(status)) return { status, text };
		const mapped = httpError(status, text);
		error = mapped.error;
		if (!mapped.transient) throw error;
	}
	if (error === null) throw new Error('unreachable: no attempt was made');
	if (!opts.retry && opts.noRetryHint) {
		throw new TasksError(
			error.code,
			`${error.message} ${opts.noRetryHint}`,
			error.status,
		);
	}
	throw error;
}

function tasksPath(remote: RemoteTarget, rest: string): string {
	return `/internal/apps/${encodeURIComponent(remote.appId)}/tasks/${rest}`;
}

async function enqueueRemote(
	remote: RemoteTarget,
	name: string,
	body: Uint8Array,
	idempotencyKey: string | undefined,
): Promise<string> {
	const { status, text } = await call(remote, {
		method: 'POST',
		path: tasksPath(remote, `${encodeURIComponent(name)}/enqueue`),
		body,
		okStatuses: new Set([200, 202]),
		// Without a key, a lost response may hide an accepted task: a resend
		// could enqueue it twice.
		retry: idempotencyKey !== undefined,
		noRetryHint:
			'Not retried: without an idempotency key the task may already have ' +
			'been accepted. Pass an idempotencyKey so the SDK can retry safely.',
	});
	return parseEnqueueResponse(status, text);
}

async function getRemote(
	remote: RemoteTarget,
	taskId: string,
): Promise<TaskStatus> {
	const { status, text } = await call(remote, {
		method: 'GET',
		path: tasksPath(remote, encodeURIComponent(taskId)),
		body: null,
		okStatuses: new Set([200]),
		retry: true,
	});
	return parseGetResponse(status, text);
}

// ---------------------------------------------------------------------------
// Local backend — `keelson dev task run` per enqueue, results kept in-process
// ---------------------------------------------------------------------------

// Node runs this on one thread, so the two maps need no lock.
const localResults = new Map<string, TaskStatus>();
const localKeys = new Map<string, string>();

/** Test seam: forget every local result and idempotency key. */
export function resetLocalStateForTesting(): void {
	localResults.clear();
	localKeys.clear();
}

function cliFailed(detail: string): TasksError {
	return new TasksError(
		'TASKS_LOCAL_CLI_FAILED',
		`\`keelson dev task run\` failed: ${detail} If the CLI is older than ` +
			'this SDK, run `keelson upgrade`.',
	);
}

function cliNotFound(): TasksError {
	return new TasksError(
		'TASKS_LOCAL_CLI_NOT_FOUND',
		'Local tasks run through the Keelson CLI, but `keelson` was not found ' +
			`on PATH. Install it with \`curl -fsSL ${INSTALL_URL} | sh\`, or set ` +
			'KEELSON_MODE=keelson on the platform.',
	);
}

/**
 * Start the CLI and wait for it without blocking the event loop (a
 * synchronous spawn would stall every other request of the dev server).
 */
function spawnCli(
	name: string,
	payloadText: string,
): Promise<{ stdout: string; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			// stderr is inherited: the task's logs show up in the dev server's
			// terminal. The exit code is not consulted; stdout alone decides.
			child = spawn(
				'keelson',
				['dev', 'task', 'run', name, '--payload', '-', '--json'],
				{ stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
			);
		} catch (err) {
			reject(cliFailed(`could not start keelson (${describeError(err)}).`));
			return;
		}
		const chunks: Buffer[] = [];
		let settled = false;
		child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.on('error', (err: NodeJS.ErrnoException) => {
			if (settled) return;
			settled = true;
			reject(
				err.code === 'ENOENT'
					? cliNotFound()
					: cliFailed(`could not start keelson (${err.code ?? err.message}).`),
			);
		});
		child.on('close', (exitCode) => {
			if (settled) return;
			settled = true;
			resolve({
				stdout: Buffer.concat(chunks).toString('utf8'),
				exitCode,
			});
		});
		// The CLI may exit without reading stdin; ignore the broken pipe.
		child.stdin?.on('error', () => {});
		child.stdin?.end(payloadText);
	});
}

async function runLocalCli(
	name: string,
	payloadText: string,
): Promise<TaskStatus> {
	const { stdout, exitCode } = await spawnCli(name, payloadText);
	const obj = parseJson(stdout.trim());
	if (!isObject(obj)) {
		throw cliFailed(
			`it exited with code ${exitCode} without a JSON result on stdout.`,
		);
	}
	if ('task' in obj) {
		const result = parseStatus(obj.task);
		if (result === null)
			throw cliFailed('its JSON result is not a valid task.');
		return result;
	}
	const error = obj.error;
	if (!isObject(error) || !isNonEmptyString(error.code)) {
		throw cliFailed('its JSON output has neither a task nor an error code.');
	}
	const detail = [error.message, error.hint]
		.filter((part): part is string => isNonEmptyString(part))
		.join(' ');
	if (LOCAL_PASSTHROUGH_CODES.has(error.code)) {
		throw new TasksError(error.code, detail || error.code);
	}
	throw cliFailed(detail ? `${error.code}: ${detail}` : `${error.code}.`);
}

async function enqueueLocal(
	name: string,
	payloadText: string,
	idempotencyKey: string | undefined,
): Promise<string> {
	const normalized = name.trim().toLowerCase();
	if (!TASK_NAME_RE.test(normalized)) {
		// No declaration can have this name; also keeps a name like "--json"
		// from being read as a CLI flag.
		throw new TasksError(
			'TASK_NOT_DECLARED',
			`Task ${JSON.stringify(normalized)} is not declared in keelson.yaml ` +
				"(task names are 1-63 of a-z, 0-9 and '-').",
		);
	}
	const key =
		idempotencyKey === undefined ? null : `${normalized}\n${idempotencyKey}`;
	if (key !== null) {
		const existing = localKeys.get(key);
		if (existing !== undefined) return existing;
	}
	// Concurrent calls with the same key may both run the CLI; the first to
	// finish keeps the key.
	const result = await runLocalCli(name, payloadText);
	localResults.set(result.task_id, result);
	if (key !== null && !localKeys.has(key)) localKeys.set(key, result.task_id);
	return result.task_id;
}

function getLocal(taskId: string): TaskStatus {
	const result = localResults.get(taskId);
	if (result === undefined) {
		throw new TasksError(
			'TASK_NOT_FOUND',
			'No task with this ID was enqueued in this process (local mode keeps ' +
				'results in memory only).',
		);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue one run of the task `name` declared under `tasks:` and return its
 * `task_id`.
 *
 * `payload` is any JSON value (default `null`); the command reads it from
 * stdin. With the same `idempotencyKey`, a repeat returns the existing
 * `task_id` instead of enqueueing again, and the SDK retries transient
 * failures. In local mode the command has already finished when this resolves
 * (its failure is reported by {@link get}, not thrown).
 */
export async function enqueue(
	name: string,
	payload: unknown = null,
	options: EnqueueOptions = {},
): Promise<string> {
	const remote = resolveMode();
	const checkedName = checkName(name);
	const idempotencyKey = checkIdempotencyKey(options?.idempotencyKey);
	const { body, payloadText } = requestBody(payload, idempotencyKey);
	if (remote !== null) {
		return enqueueRemote(remote, checkedName, body, idempotencyKey);
	}
	return enqueueLocal(checkedName, payloadText, idempotencyKey);
}

/** Return the current state of the task `taskId`. */
export async function get(taskId: string): Promise<TaskStatus> {
	const remote = resolveMode();
	if (!isNonEmptyString(taskId)) {
		throw invalid('taskId must be a non-empty string.');
	}
	if (remote !== null) return getRemote(remote, taskId);
	return getLocal(taskId);
}
