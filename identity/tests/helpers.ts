/**
 * Shared test helpers for @keelsonhq/identity SDK.
 *
 * Since the SDK uses Node's http module (not fetch), we spin up a
 * real local HTTP server to capture requests and return canned responses.
 * This exercises the actual transport layer — including Host header
 * preservation — rather than just mocking an interface.
 */

import http from "node:http";

export interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

export interface MockServer {
  /** Base URL of the mock server, e.g. "http://127.0.0.1:12345" */
  baseUrl: string;
  /** All requests received by the server. */
  calls: CapturedRequest[];
  /** Shut down the server. */
  close: () => Promise<void>;
}

/**
 * Start a local HTTP server that returns a JSON response for every request.
 */
export async function startMockServer(
  payload: unknown,
  status = 200,
): Promise<MockServer> {
  const calls: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    calls.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
    });

    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to get server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Start a local HTTP server that returns a plain-text error response.
 */
export async function startMockErrorServer(
  status: number,
  body = "",
): Promise<MockServer> {
  const calls: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    calls.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
    });

    res.writeHead(status, {
      "Content-Type": "text/plain",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to get server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
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
