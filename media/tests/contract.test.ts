/**
 * Thin contract tests for the Media SDK.
 *
 * These validate the HTTP contract (method, path, headers) that the SDK
 * sends to the internal proxy, using HEAD as a lightweight probe. They
 * run with mock fetch — no real server needed.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mockFetch, withEnv, KEELSON_ENV } from "./helpers.js";

describe("contract: HEAD request", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("stat sends HEAD to /__keelson/internal/files/{file_id}", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": "999",
        },
      }));
      restore = mock.restore;
      const { stat } = await import("../src/client.js");
      await stat("01ABCDEF");

      expect(mock.calls).toHaveLength(1);
      const req = mock.calls[0];
      expect(req.method).toBe("HEAD");
      expect(new URL(req.url).pathname).toBe(
        "/__keelson/internal/files/01ABCDEF",
      );
      expect(req.headers.get("authorization")).toBe(
        `Bearer ${KEELSON_ENV.KEELSON_APP_MEDIA_TOKEN}`,
      );
    });
  });

  it("exists sends HEAD with allowNotFound semantics", async () => {
    let callCount = 0;
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => {
        callCount++;
        return { status: 404 };
      });
      restore = mock.restore;
      const { exists } = await import("../src/client.js");
      const result = await exists("01MISSING");

      expect(result).toBe(false);
      expect(callCount).toBe(1);
      expect(mock.calls[0].method).toBe("HEAD");
    });
  });
});

describe("contract: PUT request", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("put sends correct method, path, auth, content-type", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 200 }));
      restore = mock.restore;
      const { put } = await import("../src/client.js");
      await put(Buffer.from("x"), { contentType: "text/plain" });

      // First call is PUT, second is verification HEAD
      const putReq = mock.calls[0];
      expect(putReq.method).toBe("PUT");
      expect(new URL(putReq.url).pathname).toMatch(
        /^\/__keelson\/internal\/files\/[0-9A-TV-Z]{26}$/,
      );
      expect(putReq.headers.get("authorization")).toBe(
        `Bearer ${KEELSON_ENV.KEELSON_APP_MEDIA_TOKEN}`,
      );
      expect(putReq.headers.get("content-type")).toBe("text/plain");
    });
  });
});

describe("contract: GET request", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("get sends GET with auth header", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({
        status: 200,
        body: new Uint8Array([1, 2, 3]),
      }));
      restore = mock.restore;
      const { get } = await import("../src/client.js");
      await get("01FILEID");

      expect(mock.calls).toHaveLength(1);
      const req = mock.calls[0];
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe(
        "/__keelson/internal/files/01FILEID",
      );
      expect(req.headers.get("authorization")).toBe(
        `Bearer ${KEELSON_ENV.KEELSON_APP_MEDIA_TOKEN}`,
      );
    });
  });
});

describe("contract: DELETE request", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("del sends DELETE with auth header", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 204 }));
      restore = mock.restore;
      const { del } = await import("../src/client.js");
      await del("01FILEID");

      expect(mock.calls).toHaveLength(1);
      const req = mock.calls[0];
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe(
        "/__keelson/internal/files/01FILEID",
      );
      expect(req.headers.get("authorization")).toBe(
        `Bearer ${KEELSON_ENV.KEELSON_APP_MEDIA_TOKEN}`,
      );
    });
  });
});
