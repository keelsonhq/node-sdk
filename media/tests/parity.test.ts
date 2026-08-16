/**
 * Cross-language parity tests for Media.
 *
 * These tests load the shared fixtures from fixtures/parity/ at the repository
 * root (or from KEELSON_SDK_FIXTURES_DIR) and
 * assert the same semantic field values that Go and Python parity tests assert.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { resolveParityFixturesDir } from "../../test-fixtures.js";
import { stat } from "../src/index.js";
import { mockFetch } from "./helpers.js";

const FIXTURES = resolveParityFixturesDir(import.meta.url);

describe("parity: file stat", () => {
  let restore: (() => void) | null = null;
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("parses shared fixture with same field values as Go and Python", async () => {
    const fixture = JSON.parse(readFileSync(resolve(FIXTURES, "media_stat.json"), "utf-8"));

    const mock = mockFetch(() => ({
      status: 200,
      headers: {
        "Content-Type": fixture.content_type,
        "Content-Length": String(fixture.content_length)
      }
    }));
    restore = mock.restore;

    saved.KEELSON_INTERNAL_MEDIA_BASE_URL = process.env.KEELSON_INTERNAL_MEDIA_BASE_URL;
    saved.KEELSON_APP_MEDIA_TOKEN = process.env.KEELSON_APP_MEDIA_TOKEN;
    process.env.KEELSON_INTERNAL_MEDIA_BASE_URL = "http://mock-files";
    process.env.KEELSON_APP_MEDIA_TOKEN = "test-token";

    const result = await stat("parity-test-file");

    // --- Cross-language parity assertions ---
    // Node strips "; charset=utf-8" from Content-Type.
    // Go does NOT strip it (known accidental difference).
    expect(result.contentType).toBe("text/plain");
    expect(result.contentLength).toBe(204800);
  });
});
