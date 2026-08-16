/**
 * Shared test helpers for @keelsonhq/* SDK packages.
 *
 * Uses a mock-first pattern: unit tests replace network calls with deterministic
 * responses, while server tests bind only to a local ephemeral port.
 */

import { vi } from "vitest";

/**
 * Replace `globalThis.fetch` with a mock that returns a JSON response.
 *
 * @example
 * ```ts
 * const restore = mockFetchJson({ items: [] });
 * // ... call SDK function ...
 * restore();
 * ```
 */
export function mockFetchJson(
  payload: unknown,
  status = 200
): { restore: () => void; calls: Request[] } {
  const calls: Request[] = [];

  const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  });

  const original = globalThis.fetch;
  globalThis.fetch = mockFetch as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

/**
 * Replace `globalThis.fetch` with a mock that returns an error response.
 */
export function mockFetchError(
  status: number,
  body = ""
): { restore: () => void; calls: Request[] } {
  const calls: Request[] = [];

  const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    return new Response(body, {
      status,
      headers: { "Content-Type": "text/plain" }
    });
  });

  const original = globalThis.fetch;
  globalThis.fetch = mockFetch as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

/**
 * Set environment variables for the duration of a callback, then restore.
 *
 * Executes `fn` immediately and restores original env vars afterwards,
 * even if `fn` throws.
 *
 * @example
 * ```ts
 * await withEnv({ KEELSON_EMAIL_API_URL: "http://test" }, async () => {
 *   const url = getApiUrl();
 *   expect(url).toBe("http://test");
 * });
 * ```
 */
export async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>
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
