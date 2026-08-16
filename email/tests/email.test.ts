/**
 * Tests for @keelsonhq/email SDK.
 *
 * Validates payload construction, env-var guards, address coercion,
 * webhook server routing, handler dispatch, and attachment download.
 * Follows the mock-first pattern — no real HTTP calls except for the
 * webhook server tests which use a local HTTP server.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import http from "node:http";
import { mockFetchJson, mockFetchError, withEnv } from "./helpers.js";
import { getApiUrl, getToken, EmailError } from "../src/config.js";
import type { InboundMessage, EmailEventPayload } from "../src/types.js";

// ---------------------------------------------------------------------------
// Config: env var guards
// ---------------------------------------------------------------------------

describe("getApiUrl", () => {
  it("returns trimmed URL without trailing slash", async () => {
    await withEnv({ KEELSON_EMAIL_API_URL: "  http://test/  " }, () => {
      expect(getApiUrl()).toBe("http://test");
    });
  });

  it("throws EmailError when not set", async () => {
    await withEnv({ KEELSON_EMAIL_API_URL: undefined }, () => {
      expect(() => getApiUrl()).toThrow(EmailError);
    });
  });

  it("throws EmailError when empty string", async () => {
    await withEnv({ KEELSON_EMAIL_API_URL: "   " }, () => {
      expect(() => getApiUrl()).toThrow(EmailError);
    });
  });
});

describe("getToken", () => {
  it("returns trimmed token", async () => {
    await withEnv({ KEELSON_EMAIL_TOKEN: "  tok123  " }, () => {
      expect(getToken()).toBe("tok123");
    });
  });

  it("throws EmailError when not set", async () => {
    await withEnv({ KEELSON_EMAIL_TOKEN: undefined }, () => {
      expect(() => getToken()).toThrow(EmailError);
    });
  });
});

// ---------------------------------------------------------------------------
// Root export surface guard
// ---------------------------------------------------------------------------

describe("root exports", () => {
  it("re-exports all public functions from index.ts", async () => {
    const mod = await import("../src/index.js");
    // Functions from server.ts
    expect(typeof mod.onReceive).toBe("function");
    expect(typeof mod.onEvent).toBe("function");
    expect(typeof mod.serve).toBe("function");
    // Functions from verify.ts
    expect(typeof mod.verifyWebhook).toBe("function");
    expect(typeof mod.verifyWebhookBytes).toBe("function");
    expect(typeof mod.verifyEventWebhook).toBe("function");
    expect(typeof mod.verifyEventWebhookBytes).toBe("function");
    // Functions from attachment.ts
    expect(typeof mod.downloadAttachment).toBe("function");
    // Functions from send.ts
    expect(typeof mod.send).toBe("function");
    // Error class from config.ts
    expect(typeof mod.EmailError).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// send: payload construction (mock fetch)
// ---------------------------------------------------------------------------

describe("send", () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
  });

  it("sends POST to /v1/email/send with auth header", async () => {
    await withEnv(
      {
        KEELSON_EMAIL_API_URL: "http://test-email",
        KEELSON_EMAIL_TOKEN: "tok"
      },
      async () => {
        const mock = mockFetchJson({ id: "msg-1" });
        restore = mock.restore;
        const { send } = await import("../src/send.js");
        await send({ to: "a@b.com", subject: "Hi", text: "Body" });
        expect(mock.calls).toHaveLength(1);
        const req = mock.calls[0];
        expect(req.url).toContain("/v1/email/send");
        expect(req.method).toBe("POST");
        expect(req.headers.get("authorization")).toBe("Bearer tok");
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers for webhook server tests
// ---------------------------------------------------------------------------

type ReserveResult =
  | { status: "acquired"; token: string }
  | { status: "pending" }
  | { status: "completed" };

/**
 * A durable idempotency store modelling the token-fenced reserve/commit/release
 * state machine (what an app's DB-backed store would do). `now` is injectable so
 * tests can expire the pending lease deterministically.
 */
function makeDurableStore(leaseSeconds = 300) {
  type Entry = {
    state: "pending" | "completed";
    expiry: number;
    token: string;
  };
  const state = new Map<string, Entry>();
  let counter = 0;
  let now = 1_000_000;
  return {
    state,
    setNow(t: number) {
      now = t;
    },
    reserve(id: string): ReserveResult {
      const e = state.get(id);
      if (e && e.expiry > now) {
        return e.state === "completed" ? { status: "completed" } : { status: "pending" };
      }
      const token = String(++counter);
      state.set(id, { state: "pending", expiry: now + leaseSeconds, token });
      return { status: "acquired", token };
    },
    commit(id: string, token: string): void {
      const e = state.get(id);
      if (!e || e.token !== token) return; // CAS mismatch → no-op
      state.set(id, { state: "completed", expiry: now + 300, token });
    },
    release(id: string, token: string): void {
      const e = state.get(id);
      if (!e || e.token !== token) return; // CAS mismatch → no-op
      state.delete(id);
    }
  };
}

function makeInboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    delivery_id: "d-1",
    attempt: 1,
    received_at: "2025-01-01T00:00:00Z",
    sent_at: null,
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "Bob", address: "bob@example.com" }],
    cc: [],
    reply_to: null,
    subject: "Hello",
    text: "Body text",
    html: null,
    provider_message_id: null,
    in_reply_to: null,
    references: [],
    envelope_to: "bob@example.com",
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    spam: { score: 0, verdict: "clean", reasons: [] },
    attachments: [],
    ...overrides
  };
}

function makeEventPayload(overrides: Partial<EmailEventPayload> = {}): EmailEventPayload {
  return {
    event_id: "e-1",
    event_type: "bounce",
    email_address: "fail@example.com",
    resend_email_id: null,
    bounce_type: "hard",
    detail: "Mailbox not found",
    timestamp: "2025-01-01T00:00:00Z",
    ...overrides
  };
}

// deterministic fake secret for tests
const TEST_WEBHOOK_SECRET = `whsec_${Buffer.from("fake-test-webhook-key!!", "utf-8").toString("base64")}`;

function signWebhook(
  payload: unknown,
  secret = TEST_WEBHOOK_SECRET,
  timestamp = Math.floor(Date.now() / 1000)
): Record<string, string> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const msgId = "msg_test_123";
  const signed = `${msgId}.${timestamp}.${body}`;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(signed).digest("base64");
  return {
    "svix-id": msgId,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${signature}`
  };
}

/** POST JSON to a local server and return status + parsed JSON body. */
async function postJSON(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(text) });
          } catch {
            resolve({
              status: res.statusCode!,
              body: { raw: text } as Record<string, unknown>
            });
          }
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// verification helpers
// ---------------------------------------------------------------------------

describe("verification helpers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("verifyWebhookBytes parses a valid signed payload", async () => {
    const payload = makeInboundMessage({ subject: "Signed" });
    const body = JSON.stringify(payload);
    const headers = signWebhook(payload);
    const { verifyWebhookBytes } = await import("../src/verify.js");

    const result = verifyWebhookBytes(body, headers, TEST_WEBHOOK_SECRET);
    expect(result.subject).toBe("Signed");
    expect(result.from.address).toBe("alice@example.com");
  });

  it("verifyEventWebhookBytes rejects invalid signatures", async () => {
    const payload = makeEventPayload();
    const body = JSON.stringify(payload);
    const { verifyEventWebhookBytes } = await import("../src/verify.js");

    expect(() =>
      verifyEventWebhookBytes(
        body,
        {
          "svix-id": "msg_test_123",
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": "v1,invalid"
        },
        TEST_WEBHOOK_SECRET
      )
    ).toThrow(/signature/);
  });

  it("rejects malformed base64 in webhook secret (invalid chars)", async () => {
    const payload = makeInboundMessage({ subject: "Bad secret" });
    const body = JSON.stringify(payload);
    const { verifyWebhookBytes } = await import("../src/verify.js");

    expect(() =>
      verifyWebhookBytes(
        body,
        {
          "svix-id": "msg_test_123",
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": "v1,dummy"
        },
        "whsec_abc$"
      )
    ).toThrow(/base64/);
  });

  it("rejects unpadded base64 in webhook secret", async () => {
    const payload = makeInboundMessage({ subject: "Bad secret" });
    const body = JSON.stringify(payload);
    const { verifyWebhookBytes } = await import("../src/verify.js");

    // "abc" is 3 chars — not a multiple of 4, so strict base64 must reject it
    expect(() =>
      verifyWebhookBytes(
        body,
        {
          "svix-id": "msg_test_123",
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": "v1,dummy"
        },
        "whsec_abc"
      )
    ).toThrow(/base64/);
  });

  it("skips signature entries with invalid base64 encoding", async () => {
    const payload = makeInboundMessage({ subject: "Bad sig" });
    const body = JSON.stringify(payload);
    const { verifyWebhookBytes } = await import("../src/verify.js");

    // A signature whose base64 is unpadded should not match even if
    // Buffer.from would permissively decode it to the right bytes.
    expect(() =>
      verifyWebhookBytes(
        body,
        {
          "svix-id": "msg_test_123",
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": "v1,bm90LXBhZGRlZA"
        },
        TEST_WEBHOOK_SECRET
      )
    ).toThrow(/signature/);
  });
});

async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString("utf-8")
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let _portCounter = 20000;
function getNextPort(): number {
  return _portCounter++;
}

/** Import server + verify modules with a fresh module cache (resets singleton state). */
async function freshReceiveModule() {
  vi.resetModules();
  const server = await import("../src/server.js");
  const verify = await import("../src/verify.js");
  const dedup = await import("../src/dedup.js");
  return { ...server, ...verify, ...dedup };
}

/** Start a fresh server via serve() and wait until it's listening. */
async function startServer(mod: ReceiveModule, port: number): Promise<http.Server> {
  const server = mod.serve({ port, host: "127.0.0.1", blocking: false });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (server.listening) {
      try {
        const res = await httpGet(port, "/health");
        if (res.status === 200) return server;
      } catch {
        // Keep polling until the listener is ready.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start on port ${port}`);
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// serve: webhook server tests
// ---------------------------------------------------------------------------

describe("serve", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("returns a Server and responds to health check", async () => {
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = await startServer(mod, port);

    const res = await httpGet(port, "/health");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("blocking: true keeps process alive (server is ref'd)", async () => {
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = mod.serve({ port, host: "127.0.0.1", blocking: true });
    await new Promise<void>((resolve) => {
      if (server!.listening) return resolve();
      server!.on("listening", resolve);
    });

    const res = await httpGet(port, "/health");
    expect(res.status).toBe(200);
  });

  it("quiet: true suppresses the startup message", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = mod.serve({
      port,
      host: "127.0.0.1",
      blocking: false,
      quiet: true
    });
    await new Promise<void>((resolve) => {
      if (server!.listening) return resolve();
      server!.on("listening", resolve);
    });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("returns 404 for unknown routes", async () => {
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = await startServer(mod, port);

    const res = await httpGet(port, "/unknown");
    expect(res.status).toBe(404);
  });

  it("second serve() call returns the same server", async () => {
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = await startServer(mod, port);

    const server2 = mod.serve({ port: port + 1, host: "127.0.0.1" });
    expect(server2).toBe(server);
  });

  it("serve() creates a new server after the previous one is closed", async () => {
    const mod = await freshReceiveModule();
    const port1 = getNextPort();
    server = await startServer(mod, port1);

    const res1 = await httpGet(port1, "/health");
    expect(res1.status).toBe(200);

    // Close the first server.
    await closeServer(server);

    // serve() should now create a fresh server on a new port.
    const port2 = getNextPort();
    server = await startServer(mod, port2);

    const res2 = await httpGet(port2, "/health");
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// onReceive: inbound webhook handler
//
// serve() now sets _started, so onReceive() will not try to start a
// second listener when a server is already running.
// ---------------------------------------------------------------------------

describe("onReceive", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function setup(handler: (msg: InboundMessage) => void | Promise<void>) {
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = await startServer(mod, port);
    mod.onReceive(handler);
    return port;
  }

  async function setupWithStore(
    store: unknown,
    handler: (msg: InboundMessage) => void | Promise<void>
  ) {
    const mod = await freshReceiveModule();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.setIdempotencyStore(store as any);
    const port = getNextPort();
    server = await startServer(mod, port);
    mod.onReceive(handler);
    return port;
  }

  it("calls handler with parsed inbound message", async () => {
    const received: InboundMessage[] = [];
    const port = await setup((msg) => {
      received.push(msg);
    });

    const msg = makeInboundMessage({ subject: "Test Subject" });
    const res = await postJSON(port, "/api/webhooks/email", msg);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(received).toHaveLength(1);
    expect(received[0].subject).toBe("Test Subject");
    expect(received[0].from.address).toBe("alice@example.com");
  });

  it("calls async handler and awaits it", async () => {
    let resolved = false;
    const port = await setup(async () => {
      await new Promise<void>((r) => setTimeout(r, 10));
      resolved = true;
    });

    const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
    expect(res.status).toBe(200);
    expect(resolved).toBe(true);
  });

  it("returns 400 for invalid JSON", async () => {
    const port = await setup(() => {});

    const res = await postJSON(port, "/api/webhooks/email", "not json{{{");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON" });
  });

  it("returns 500 when handler throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await setup(() => {
      throw new Error("handler boom");
    });

    const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Handler error" });
    consoleSpy.mockRestore();
  });

  it("returns 500 when async handler rejects", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await setup(async () => {
      throw new Error("async boom");
    });

    const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Handler error" });
    consoleSpy.mockRestore();
  });

  it("returns 500 when no receive handler is registered", async () => {
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = await startServer(mod, port);
    // No onReceive call — handler is null

    const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "No handler registered" });
  });

  it("auto-verifies signatures when KEELSON_EMAIL_WEBHOOK_SECRET is set", async () => {
    await withEnv({ KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET }, async () => {
      const received: InboundMessage[] = [];
      const port = await setup((msg) => {
        received.push(msg);
      });
      const payload = makeInboundMessage({ subject: "Signed inbound" });

      const res = await postJSON(port, "/api/webhooks/email", payload, signWebhook(payload));

      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0].subject).toBe("Signed inbound");
    });
  });

  it("returns 401 for unsigned requests when webhook secret is configured", async () => {
    await withEnv({ KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET }, async () => {
      const port = await setup(() => {});

      const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid signature" });
    });
  });

  // Fail closed: in Keelson mode an unsigned or unverifiable delivery is
  // rejected rather than parsed.
  it("KEELSON_MODE=keelson: rejects unsigned delivery (401) when secret set", async () => {
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        const received: InboundMessage[] = [];
        const port = await setup((m) => {
          received.push(m);
        });
        const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
        expect(res.status).toBe(401);
        expect(received).toHaveLength(0);
      }
    );
  });

  it("KEELSON_MODE=keelson: accepts a validly signed delivery (200)", async () => {
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        const received: InboundMessage[] = [];
        const port = await setup((m) => {
          received.push(m);
        });
        const payload = makeInboundMessage({ subject: "keelson signed" });
        const res = await postJSON(port, "/api/webhooks/email", payload, signWebhook(payload));
        expect(res.status).toBe(200);
        expect(received).toHaveLength(1);
      }
    );
  });

  it("KEELSON_MODE=keelson without a secret: fails closed (500), never parses", async () => {
    await withEnv(
      { KEELSON_MODE: "keelson", KEELSON_EMAIL_WEBHOOK_SECRET: undefined },
      async () => {
        const received: InboundMessage[] = [];
        const port = await setup((m) => {
          received.push(m);
        });
        const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
        expect(res.status).toBe(500);
        expect(received).toHaveLength(0);
      }
    );
  });

  it("platform env (KEELSON_APP_ID) without a secret: fails closed (500)", async () => {
    await withEnv(
      {
        KEELSON_MODE: undefined,
        KEELSON_APP_ID: "app_123",
        KEELSON_EMAIL_WEBHOOK_SECRET: undefined
      },
      async () => {
        const received: InboundMessage[] = [];
        const port = await setup((m) => {
          received.push(m);
        });
        const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
        expect(res.status).toBe(500);
        expect(received).toHaveLength(0);
      }
    );
  });

  it("KEELSON_MODE=local without a secret: accepts unsigned (local dev)", async () => {
    await withEnv({ KEELSON_MODE: "local", KEELSON_EMAIL_WEBHOOK_SECRET: undefined }, async () => {
      const received: InboundMessage[] = [];
      const port = await setup((m) => {
        received.push(m);
      });
      const res = await postJSON(port, "/api/webhooks/email", makeInboundMessage());
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
    });
  });

  // Replayed deliveries are suppressed by svix-id.
  it("dedupes a replayed signed delivery (same svix-id) without re-invoking handler", async () => {
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        const received: InboundMessage[] = [];
        const port = await setup((m) => {
          received.push(m);
        });
        const payload = makeInboundMessage({ subject: "replay me" });
        const headers = signWebhook(payload); // fixed svix-id

        const first = await postJSON(port, "/api/webhooks/email", payload, headers);
        const second = await postJSON(port, "/api/webhooks/email", payload, headers);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ duplicate: true });
        // Handler ran exactly once despite two identical signed deliveries.
        expect(received).toHaveLength(1);
      }
    );
  });

  it("reprocesses a retry (same svix-id) after the handler fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        let calls = 0;
        const port = await setup(() => {
          calls += 1;
          if (calls === 1) throw new Error("first attempt boom");
        });
        const payload = makeInboundMessage({ subject: "retry me" });
        const headers = signWebhook(payload);

        const first = await postJSON(port, "/api/webhooks/email", payload, headers);
        const second = await postJSON(port, "/api/webhooks/email", payload, headers);

        // First attempt failed (500), reservation released → retry re-runs the handler.
        expect(first.status).toBe(500);
        expect(second.status).toBe(200);
        expect(calls).toBe(2);
      }
    );
    consoleSpy.mockRestore();
  });

  it("durable idempotency store dedupes a replay across two instances", async () => {
    // A shared reserve/commit/release store simulates durable storage (the app's
    // DB) visible to every instance. Two server modules (two "instances") install
    // the SAME store; a replay to the second instance sees the committed
    // reservation and is deduped — impossible with the process-local backend.
    const store = makeDurableStore();
    const servers: http.Server[] = [];
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        const received: string[] = [];
        const start = async (tag: string): Promise<number> => {
          const mod = await freshReceiveModule();
          mod.setIdempotencyStore(store);
          const port = getNextPort();
          const s = await startServer(mod, port);
          servers.push(s);
          mod.onReceive(() => {
            received.push(tag);
          });
          return port;
        };
        const portA = await start("A");
        const portB = await start("B");
        const payload = makeInboundMessage({ subject: "cross-instance" });
        const headers = signWebhook(payload); // fixed svix-id

        const a = await postJSON(portA, "/api/webhooks/email", payload, headers);
        const b = await postJSON(portB, "/api/webhooks/email", payload, headers);

        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(b.body).toMatchObject({ duplicate: true });
        // Processed once total across BOTH instances (durable, cross-instance).
        expect(received).toEqual(["A"]);
        expect(store.state.get("msg_test_123")?.state).toBe("completed");
      }
    );
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it("durable store: handler failure releases the reservation so a retry re-processes", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeDurableStore();
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        let calls = 0;
        const port = await setupWithStore(store, () => {
          calls += 1;
          if (calls === 1) throw new Error("first attempt boom");
        });
        const payload = makeInboundMessage({ subject: "fail then retry" });
        const headers = signWebhook(payload);

        const first = await postJSON(port, "/api/webhooks/email", payload, headers);
        // After failure the reservation must be RELEASED (not left as completed).
        expect(first.status).toBe(500);
        expect(store.state.has("msg_test_123")).toBe(false);

        const second = await postJSON(port, "/api/webhooks/email", payload, headers);
        expect(second.status).toBe(200);
        expect(calls).toBe(2);
        expect(store.state.get("msg_test_123")?.state).toBe("completed");
      }
    );
    consoleSpy.mockRestore();
  });

  it("durable store: an un-expired pending reservation returns retryable 503 (not a 200 dup)", async () => {
    // Simulate an in-flight/crashed attempt: the store already holds an un-expired
    // PENDING reservation from another attempt. The next delivery must NOT be ACKed
    // as a completed duplicate — that would falsely mark it delivered and break
    // crash recovery. It gets a retryable 503 instead.
    const store = makeDurableStore();
    store.reserve("msg_test_123"); // pre-existing pending from "attempt A"
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        let calls = 0;
        const port = await setupWithStore(store, () => {
          calls += 1;
        });
        const payload = makeInboundMessage({ subject: "in progress" });
        const headers = signWebhook(payload);

        const res = await postJSON(port, "/api/webhooks/email", payload, headers);
        expect(res.status).toBe(503); // retryable, NOT a 200 duplicate
        expect(res.body).not.toMatchObject({ duplicate: true });
        expect(calls).toBe(0); // handler NOT run
      }
    );
  });

  it("durable store: a release backend failure still leaves pending → retry re-acquires after lease", async () => {
    // Handler fails AND release fails (backend error). The pending reservation is
    // left behind, so the immediate retry sees un-expired pending → 503 (NOT a 200
    // duplicate that would mark it delivered). After the lease expires the retry
    // re-acquires and processes.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeDurableStore(60);
    const origRelease = store.release.bind(store);
    let releaseShouldFail = true;
    store.release = (id: string, token: string) => {
      if (releaseShouldFail) throw new Error("release DB error");
      origRelease(id, token);
    };
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        let calls = 0;
        const port = await setupWithStore(store, () => {
          calls += 1;
          if (calls === 1) throw new Error("handler boom");
        });
        const payload = makeInboundMessage({ subject: "release fails" });
        const headers = signWebhook(payload);

        const first = await postJSON(port, "/api/webhooks/email", payload, headers);
        expect(first.status).toBe(500); // handler failed; release also failed (logged)
        // Immediate retry: pending is still there and un-expired → retryable 503.
        const retryNow = await postJSON(port, "/api/webhooks/email", payload, headers);
        expect(retryNow.status).toBe(503);
        expect(calls).toBe(1); // NOT re-processed yet, NOT a false duplicate

        // Lease expires → a later retry re-acquires and processes.
        releaseShouldFail = false;
        store.setNow(1_000_000 + 120);
        const later = await postJSON(port, "/api/webhooks/email", payload, headers);
        expect(later.status).toBe(200);
        expect(calls).toBe(2);
      }
    );
    consoleSpy.mockRestore();
  });

  it("durable store: a stale attempt cannot commit/release a taken-over reservation (token fence)", async () => {
    // Attempt A acquires (token tA). Its lease expires; attempt B takes over
    // (token tB). A's late commit(id, tA) / release(id, tB≠tA) must be no-ops.
    const store = makeDurableStore(60);
    const rA = store.reserve("del"); // A
    expect(rA.status).toBe("acquired");
    const tokenA = (rA as { token: string }).token;

    store.setNow(1_000_000 + 120); // A's lease expires
    const rB = store.reserve("del"); // B takes over
    expect(rB.status).toBe("acquired");
    const tokenB = (rB as { token: string }).token;
    expect(tokenB).not.toBe(tokenA);

    // Stale A releases with its old token → must NOT delete B's reservation.
    store.release("del", tokenA);
    expect(store.state.get("del")?.token).toBe(tokenB);

    // Stale A commits with its old token → must NOT complete B's reservation.
    store.commit("del", tokenA);
    expect(store.state.get("del")?.state).toBe("pending");

    // B's own commit works.
    store.commit("del", tokenB);
    expect(store.state.get("del")?.state).toBe("completed");
  });

  it("durable store: a reserve backend error returns 500 (retryable), not a duplicate ACK", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = {
      reserve(_id: string): never {
        throw new Error("DB down");
      },
      commit(_id: string, _t: string): void {},
      release(_id: string, _t: string): void {}
    };
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        let calls = 0;
        const port = await setupWithStore(store, () => {
          calls += 1;
        });
        const payload = makeInboundMessage({ subject: "store down" });
        const headers = signWebhook(payload);

        const res = await postJSON(port, "/api/webhooks/email", payload, headers);
        // Store failure ⇒ 500 (platform retries), handler NOT called, NOT a 200 dup.
        expect(res.status).toBe(500);
        expect(res.body).not.toMatchObject({ duplicate: true });
        expect(calls).toBe(0);
      }
    );
    consoleSpy.mockRestore();
  });

  it("durable store: a commit backend failure returns 500 (fail-closed), NOT 200", async () => {
    // Handler succeeded but the completed record could not be persisted. Returning
    // 200 would let the platform mark it delivered with no completed reservation,
    // so a replay would double-process. Must return a retryable 500.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeDurableStore();
    store.commit = () => {
      throw new Error("commit DB error");
    };
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        let calls = 0;
        const port = await setupWithStore(store, () => {
          calls += 1;
        });
        const payload = makeInboundMessage({ subject: "commit fails" });
        const headers = signWebhook(payload);

        const res = await postJSON(port, "/api/webhooks/email", payload, headers);
        expect(res.status).toBe(500); // handler ran but commit failed → NOT 2xx
        expect(res.body).not.toMatchObject({ status: "ok" });
        expect(calls).toBe(1);
      }
    );
    consoleSpy.mockRestore();
  });
});

describe("onEvent commit failure", () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  it("event: a commit backend failure returns 500 (fail-closed), NOT 200", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = makeDurableStore();
    store.commit = () => {
      throw new Error("commit DB error");
    };
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        const mod = await freshReceiveModule();
        mod.setIdempotencyStore(store);
        const port = getNextPort();
        server = await startServer(mod, port);
        let calls = 0;
        mod.onEvent(() => {
          calls += 1;
        });
        const payload = makeEventPayload({ event_type: "delivered" });
        const headers = signWebhook(payload);

        const res = await postJSON(port, "/api/webhooks/email-events", payload, headers);
        expect(res.status).toBe(500);
        expect(calls).toBe(1);
      }
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// onEvent: event webhook handler
// ---------------------------------------------------------------------------

describe("onEvent", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function setup(handler: (event: EmailEventPayload) => void | Promise<void>) {
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = await startServer(mod, port);
    mod.onEvent(handler);
    return port;
  }

  it("calls handler with parsed event payload", async () => {
    const events: EmailEventPayload[] = [];
    const port = await setup((event) => {
      events.push(event);
    });

    const payload = makeEventPayload({ event_type: "complaint" });
    const res = await postJSON(port, "/api/webhooks/email-events", payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("complaint");
    expect(events[0].email_address).toBe("fail@example.com");
  });

  it("ACKs with 200 when no event handler is registered", async () => {
    const mod = await freshReceiveModule();
    const port = getNextPort();
    server = await startServer(mod, port);
    // No onEvent call — handler is null

    const res = await postJSON(port, "/api/webhooks/email-events", makeEventPayload());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns 400 for invalid JSON on event path", async () => {
    const port = await setup(() => {});

    const res = await postJSON(port, "/api/webhooks/email-events", "bad json!!!");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON" });
  });

  it("returns 500 when event handler throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await setup(() => {
      throw new Error("event handler error");
    });

    const res = await postJSON(port, "/api/webhooks/email-events", makeEventPayload());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Handler error" });
    consoleSpy.mockRestore();
  });

  it("verifies signed event webhooks when webhook secret is configured", async () => {
    await withEnv({ KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET }, async () => {
      const events: EmailEventPayload[] = [];
      const port = await setup((event) => {
        events.push(event);
      });
      const payload = makeEventPayload({ event_type: "delivered" });

      const res = await postJSON(port, "/api/webhooks/email-events", payload, signWebhook(payload));

      expect(res.status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("delivered");
    });
  });

  it("KEELSON_MODE=keelson without a secret: event path fails closed (500)", async () => {
    await withEnv(
      { KEELSON_MODE: "keelson", KEELSON_EMAIL_WEBHOOK_SECRET: undefined },
      async () => {
        const events: EmailEventPayload[] = [];
        const port = await setup((e) => {
          events.push(e);
        });
        const res = await postJSON(port, "/api/webhooks/email-events", makeEventPayload());
        expect(res.status).toBe(500);
        expect(events).toHaveLength(0);
      }
    );
  });

  it("KEELSON_MODE=keelson: event path rejects unsigned (401) when secret set", async () => {
    await withEnv(
      {
        KEELSON_MODE: "keelson",
        KEELSON_EMAIL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET
      },
      async () => {
        const events: EmailEventPayload[] = [];
        const port = await setup((e) => {
          events.push(e);
        });
        const res = await postJSON(port, "/api/webhooks/email-events", makeEventPayload());
        expect(res.status).toBe(401);
        expect(events).toHaveLength(0);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// downloadAttachment
// ---------------------------------------------------------------------------

describe("downloadAttachment", () => {
  let restore: () => void;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restore?.();
  });

  it("downloads attachment with auth header", async () => {
    await withEnv(
      {
        KEELSON_EMAIL_API_URL: "http://test-email",
        KEELSON_EMAIL_TOKEN: "tok"
      },
      async () => {
        const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const original = globalThis.fetch;
        const calls: Request[] = [];
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          calls.push(req);
          return new Response(binaryData, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" }
          });
        }) as typeof fetch;
        restore = () => {
          globalThis.fetch = original;
        };

        const { downloadAttachment } = await import("../src/attachment.js");
        const result = await downloadAttachment("/v1/email/attachments/att-1");

        expect(result).toBeInstanceOf(Buffer);
        expect(result.length).toBe(4);
        expect(calls).toHaveLength(1);
        expect(calls[0].headers.get("authorization")).toBe("Bearer tok");
      }
    );
  });

  it("throws EmailError on non-ok response", async () => {
    await withEnv(
      {
        KEELSON_EMAIL_API_URL: "http://test-email",
        KEELSON_EMAIL_TOKEN: "tok"
      },
      async () => {
        const mock = mockFetchError(404, "Not found");
        restore = mock.restore;

        const { downloadAttachment } = await import("../src/attachment.js");
        await expect(downloadAttachment("/v1/email/attachments/missing")).rejects.toThrow(
          /Attachment download failed/
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency default (process-local) backend state machine
// ---------------------------------------------------------------------------

describe("idempotency default backend", () => {
  it("pending is distinct from completed: pending → pending, re-acquirable after lease", async () => {
    const { reserveDelivery, _resetDedup } = await freshReceiveModule();
    _resetDedup();
    const t0 = 1_000_000;
    // Acquire (pending). No commit/release → simulates a crash mid-handler.
    const r1 = await reserveDelivery("id1", t0);
    expect(r1.status).toBe("acquired");
    // Within the lease: an un-expired PENDING (NOT completed) → status "pending".
    expect((await reserveDelivery("id1", t0 + 10)).status).toBe("pending");
    // After the lease expires: re-acquire (crash recovery).
    expect((await reserveDelivery("id1", t0 + 301)).status).toBe("acquired");
  });

  it("committed reservation dedupes within the window, then expires", async () => {
    const { reserveDelivery, commitDelivery, _resetDedup } = await freshReceiveModule();
    _resetDedup();
    const t0 = 2_000_000;
    const r = await reserveDelivery("id2", t0);
    expect(r.status).toBe("acquired");
    await commitDelivery("id2", (r as { token: string }).token, t0);
    // Completed → duplicate within the TTL window.
    expect((await reserveDelivery("id2", t0 + 10)).status).toBe("completed");
    // After the TTL: re-acquirable (the Svix window already rejects a replay this old).
    expect((await reserveDelivery("id2", t0 + 301)).status).toBe("acquired");
  });

  it("released reservation is immediately re-acquirable (handler failure)", async () => {
    const { reserveDelivery, releaseDelivery, _resetDedup } = await freshReceiveModule();
    _resetDedup();
    const t0 = 3_000_000;
    const r = await reserveDelivery("id3", t0);
    expect(r.status).toBe("acquired");
    await releaseDelivery("id3", (r as { token: string }).token);
    expect((await reserveDelivery("id3", t0 + 1)).status).toBe("acquired");
  });

  it("commit/release are token-fenced: a stale token is a no-op", async () => {
    const { reserveDelivery, commitDelivery, releaseDelivery, _resetDedup } =
      await freshReceiveModule();
    _resetDedup();
    const t0 = 4_000_000;
    const rA = await reserveDelivery("id4", t0); // A acquires
    const tokenA = (rA as { token: string }).token;
    // A's lease expires; B takes over with a new token.
    const rB = await reserveDelivery("id4", t0 + 301);
    expect(rB.status).toBe("acquired");
    const tokenB = (rB as { token: string }).token;
    expect(tokenB).not.toBe(tokenA);
    // Stale A release/commit with the old token → no-op (B's reservation intact).
    await releaseDelivery("id4", tokenA);
    expect((await reserveDelivery("id4", t0 + 302)).status).toBe("pending"); // still B's
    await commitDelivery("id4", tokenA, t0 + 303);
    expect((await reserveDelivery("id4", t0 + 304)).status).toBe("pending"); // NOT completed
    // B's own commit works.
    await commitDelivery("id4", tokenB, t0 + 305);
    expect((await reserveDelivery("id4", t0 + 306)).status).toBe("completed");
  });
});
