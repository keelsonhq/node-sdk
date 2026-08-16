import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Locate the shared cross-SDK parity fixtures in public or monorepo layouts. */
export function resolveParityFixturesDir(testModuleUrl: string): string {
  const configured = process.env.KEELSON_SDK_FIXTURES_DIR?.trim();
  const candidates = [
    configured ? resolve(configured) : null,
    fileURLToPath(new URL("../../fixtures/parity/", testModuleUrl)),
    fileURLToPath(new URL("../../../fixtures/parity/", testModuleUrl)),
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Could not find SDK parity fixtures. Checked: ${candidates.join(", ")}. ` +
      "Set KEELSON_SDK_FIXTURES_DIR to override the fixture directory.",
  );
}
