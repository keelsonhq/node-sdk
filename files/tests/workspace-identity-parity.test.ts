import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveParityFixturesDir } from '../../test-fixtures.js';
import { getWorkspaceId } from '../src/config.js';
import { withEnv } from './helpers.js';

interface FixtureCase {
	name: string;
	workspace_id: string | null;
	tenant_id: string | null;
	expected: string | null;
}

const fixturePath = resolve(
	resolveParityFixturesDir(import.meta.url),
	'workspace_identity_parity.json',
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
