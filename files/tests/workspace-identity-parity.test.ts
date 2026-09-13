import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getWorkspaceId } from '../src/config.js';
import { withEnv } from './helpers.js';

interface FixtureCase {
	name: string;
	workspace_id: string | null;
	tenant_id: string | null;
	expected: string | null;
}

const fixturePath = fileURLToPath(
	new URL('../../../testdata/workspace_identity_parity.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
	cases: FixtureCase[];
};

describe('workspace identity parity', () => {
	for (const testCase of fixture.cases) {
		it(testCase.name, async () => {
			await withEnv(
				{
					KEELSON_WORKSPACE_ID: testCase.workspace_id ?? undefined,
					KEELSON_TENANT_ID: testCase.tenant_id ?? undefined,
				},
				async () => {
					expect(getWorkspaceId()).toBe(testCase.expected ?? '');
				},
			);
		});
	}
});
