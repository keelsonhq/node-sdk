/**
 * Unit tests for @keelsonhq/media SDK.
 *
 * Validates HTTP payload construction, env-var modes, file_id validation,
 * and local fallback behaviour. Uses mock fetch — no real HTTP calls.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch, mockFetchBinary, withEnv, KEELSON_ENV, LOCAL_ENV } from "./helpers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("config", () => {
  it("isKeelsonEnv returns true when both vars set", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const { isKeelsonEnv } = await import("../src/config.js");
      expect(isKeelsonEnv()).toBe(true);
    });
  });

  it("isKeelsonEnv returns false when vars missing", async () => {
    await withEnv(LOCAL_ENV, async () => {
      const { isKeelsonEnv } = await import("../src/config.js");
      expect(isKeelsonEnv()).toBe(false);
    });
  });

  it("getUrlPrefix defaults to /media/", async () => {
    await withEnv({ KEELSON_MEDIA_URL_PREFIX: undefined }, async () => {
      const { getUrlPrefix } = await import("../src/config.js");
      expect(getUrlPrefix()).toBe("/media/");
    });
  });

  it("getUrlPrefix normalises slashes", async () => {
    await withEnv({ KEELSON_MEDIA_URL_PREFIX: "assets" }, async () => {
      const { getUrlPrefix } = await import("../src/config.js");
      expect(getUrlPrefix()).toBe("/assets/");
    });
  });
});

// ---------------------------------------------------------------------------
// file_id validation (via url which calls normalizeFileId)
// ---------------------------------------------------------------------------

describe("url", () => {
  it("builds URL path with prefix and encoded file_id", async () => {
    await withEnv({ KEELSON_MEDIA_URL_PREFIX: undefined }, async () => {
      const { url } = await import("../src/client.js");
      const result = url("01ABC");
      expect(result).toBe("/media/01ABC");
    });
  });

  it("throws on empty file_id", async () => {
    const { url } = await import("../src/client.js");
    expect(() => url("")).toThrow("file_id is required");
  });

  it("throws on URL-like file_id", async () => {
    const { url } = await import("../src/client.js");
    expect(() => url("https://evil.com")).toThrow("must not be a URL");
  });

  it("throws on path-traversal file_id", async () => {
    const { url } = await import("../src/client.js");
    expect(() => url("..")).toThrow("invalid");
  });

  it("throws on file_id with slashes", async () => {
    const { url } = await import("../src/client.js");
    expect(() => url("foo/bar")).toThrow("invalid");
  });
});

// ---------------------------------------------------------------------------
// Keelson mode: put
// ---------------------------------------------------------------------------

describe("put (keelson mode)", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("sends PUT then HEAD to internal proxy", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 200 }));
      restore = mock.restore;
      const { put } = await import("../src/client.js");
      const fileId = await put(Buffer.from("hello"), { contentType: "text/plain" });

      expect(fileId).toHaveLength(26); // ULID
      expect(mock.calls).toHaveLength(2);

      const putReq = mock.calls[0];
      expect(putReq.method).toBe("PUT");
      expect(putReq.url).toContain("/__keelson/internal/files/");
      expect(putReq.headers.get("authorization")).toBe("Bearer test-token-123");
      expect(putReq.headers.get("content-type")).toBe("text/plain");

      const headReq = mock.calls[1];
      expect(headReq.method).toBe("HEAD");
    });
  });

  it("sends X-Keelson-Filename header when filename provided", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 200 }));
      restore = mock.restore;
      const { put } = await import("../src/client.js");
      await put(Buffer.from("data"), { filename: "photo.jpg" });

      const putReq = mock.calls[0];
      expect(putReq.headers.get("x-keelson-filename")).toBe("photo.jpg");
      // Auto-detected content type from filename
      expect(putReq.headers.get("content-type")).toBe("image/jpeg");
    });
  });

  it("throws on non-Uint8Array data", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const { put } = await import("../src/client.js");
      // @ts-expect-error intentional wrong type
      await expect(put("string")).rejects.toThrow("Uint8Array or Buffer");
    });
  });
});

// ---------------------------------------------------------------------------
// Keelson mode: get
// ---------------------------------------------------------------------------

describe("get (keelson mode)", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("sends GET and returns body bytes", async () => {
    const payload = new TextEncoder().encode("file contents");
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetchBinary(payload);
      restore = mock.restore;
      const { get } = await import("../src/client.js");
      const data = await get("01TESTID");

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].method).toBe("GET");
      expect(new TextDecoder().decode(data)).toBe("file contents");
    });
  });
});

// ---------------------------------------------------------------------------
// Keelson mode: open (alias for get)
// ---------------------------------------------------------------------------

describe("open (keelson mode)", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("returns same data as get", async () => {
    const payload = new TextEncoder().encode("open data");
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetchBinary(payload);
      restore = mock.restore;
      const { open } = await import("../src/client.js");
      const data = await open("01TESTID");

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].method).toBe("GET");
      expect(new TextDecoder().decode(data)).toBe("open data");
    });
  });
});

// ---------------------------------------------------------------------------
// Keelson mode: exists
// ---------------------------------------------------------------------------

describe("exists (keelson mode)", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("returns true on 200", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 200 }));
      restore = mock.restore;
      const { exists } = await import("../src/client.js");
      expect(await exists("01TESTID")).toBe(true);
      expect(mock.calls[0].method).toBe("HEAD");
    });
  });

  it("returns false on 404", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 404 }));
      restore = mock.restore;
      const { exists } = await import("../src/client.js");
      expect(await exists("01MISSING")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Keelson mode: stat
// ---------------------------------------------------------------------------

describe("stat (keelson mode)", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("parses Content-Type and Content-Length from HEAD response", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({
        status: 200,
        headers: {
          "Content-Type": "image/png; charset=utf-8",
          "Content-Length": "4096",
        },
      }));
      restore = mock.restore;
      const { stat } = await import("../src/client.js");
      const info = await stat("01TESTID");

      expect(info.contentType).toBe("image/png");
      expect(info.contentLength).toBe(4096);
      expect(info.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// Keelson mode: del
// ---------------------------------------------------------------------------

describe("del (keelson mode)", () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it("sends DELETE request", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 204 }));
      restore = mock.restore;
      const { del } = await import("../src/client.js");
      await del("01TESTID");

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].method).toBe("DELETE");
    });
  });

  it("does not throw on 404", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 404 }));
      restore = mock.restore;
      const { del } = await import("../src/client.js");
      await expect(del("01MISSING")).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Local mode: put/get/exists/stat/del round-trip
// ---------------------------------------------------------------------------

describe("local mode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "keelson-files-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("full round-trip: put → exists → get → open → stat → del", async () => {
    await withEnv({ ...LOCAL_ENV, MEDIA_DIR: tmpDir }, async () => {
      const { put, get, open, exists, stat, del } = await import("../src/client.js");

      // put
      const fileId = await put(Buffer.from("local data"), {
        contentType: "text/plain",
      });
      expect(fileId).toHaveLength(26);

      // exists
      expect(await exists(fileId)).toBe(true);

      // get
      const data = await get(fileId);
      expect(new TextDecoder().decode(data)).toBe("local data");

      // open (alias)
      const data2 = await open(fileId);
      expect(new TextDecoder().decode(data2)).toBe("local data");

      // stat
      const info = await stat(fileId);
      expect(info.contentType).toBe("text/plain");
      expect(info.contentLength).toBe(10);
      expect(info.status).toBe(200);

      // del
      await del(fileId);
      expect(await exists(fileId)).toBe(false);
    });
  });

  it("stat throws for missing file", async () => {
    await withEnv({ ...LOCAL_ENV, MEDIA_DIR: tmpDir }, async () => {
      const { stat } = await import("../src/client.js");
      await expect(stat("NOTFOUND")).rejects.toThrow("File not found");
    });
  });
});

// ---------------------------------------------------------------------------
// Entrypoint: public surface exports (import from index.ts)
// ---------------------------------------------------------------------------

describe("entrypoint exports", () => {
  it("exports all required functions and types", async () => {
    const mod = await import("../src/index.js");
    // Functions
    expect(typeof mod.put).toBe("function");
    expect(typeof mod.get).toBe("function");
    expect(typeof mod.read).toBe("function");
    expect(typeof mod.open).toBe("function");
    expect(typeof mod.del).toBe("function");
    expect(typeof mod.delete).toBe("function");
    expect(typeof mod.exists).toBe("function");
    expect(typeof mod.stat).toBe("function");
    expect(typeof mod.url).toBe("function");
    // Error class
    expect(typeof mod.MediaError).toBe("function");
    // del and delete should be the same function
    expect(mod.del).toBe(mod.delete);
  });

  it("media.delete works as an alias for del", async () => {
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetch(() => ({ status: 204 }));
      const mod = await import("../src/index.js");
      try {
        await mod.delete("01TESTID");
        expect(mock.calls).toHaveLength(1);
        expect(mock.calls[0].method).toBe("DELETE");
      } finally {
        mock.restore();
      }
    });
  });

  it("media.open works via entrypoint", async () => {
    const payload = new TextEncoder().encode("entrypoint open");
    await withEnv(KEELSON_ENV, async () => {
      const mock = mockFetchBinary(payload);
      const mod = await import("../src/index.js");
      try {
        const data = await mod.open("01TESTID");
        expect(new TextDecoder().decode(data)).toBe("entrypoint open");
      } finally {
        mock.restore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// ULID
// ---------------------------------------------------------------------------

describe("ulid", () => {
  it("generates 26-char string", async () => {
    const { newUlid } = await import("../src/ulid.js");
    const id = newUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-TV-Z]{26}$/);
  });

  it("generates unique IDs", async () => {
    const { newUlid } = await import("../src/ulid.js");
    const ids = new Set(Array.from({ length: 100 }, () => newUlid()));
    expect(ids.size).toBe(100);
  });
});
