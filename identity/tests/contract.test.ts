/**
 * Thin contract test for @keelsonhq/identity SDK.
 *
 * Verifies that the SDK parses trusted headers and correctly calls the
 * app-as-actor identity endpoint. This catches
 * drift between the SDK and the actual API contract.
 *
 * Uses a real local HTTP server returning payloads that match the public
 * User-Context API schema.
 */

import { describe, it, expect, afterEach } from "vitest";
import { startMockServer, withEnv, type MockServer } from "./helpers.js";

/**
 * Realistic Keelson auth gateway response for
 * GET /__keelson/users/{id}/identity.
 */
const REALISTIC_IDENTITY = {
  user: {
    id: "usr_2abc123def456",
    email: "developer@company.com",
    name: "Dev User"
  },
  tenant: {
    id: "tenant_abc123",
    role: "BUILDER"
  },
  app: {
    id: "app_xyz789",
    permissions: [],
    roles: []
  },
  authz: {
    version: 42
  },
  attributes: {
    groups: ["everyone", "developers"]
  }
};

describe("contract: current user and current identity", () => {
  let server: MockServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("parses a realistic identity response", async () => {
    server = await startMockServer(REALISTIC_IDENTITY);
    await withEnv(
      {
        KEELSON_LOCAL_MODE: undefined,
        KEELSON_IDENTITY_BASE_URL: server.baseUrl
      },
      async () => {
        const { getCurrentIdentity, getCurrentUser } = await import("../src/client.js");
        const headers = {
          "x-keelson-user-id": "usr_2abc123def456",
          "x-keelson-user-email": "developer@company.com",
          "x-keelson-user-name": "Dev User"
        };
        const user = await getCurrentUser({ headers });
        const identity = await getCurrentIdentity({
          headers,
          app_token: "keelson_contract",
          base_url: server!.baseUrl
        });

        // User
        expect(user.id).toBe("usr_2abc123def456");
        expect(identity.user.id).toBe("usr_2abc123def456");
        expect(identity.user.email).toBe("developer@company.com");
        expect(identity.user.name).toBe("Dev User");

        // Tenant
        expect(identity.tenant.id).toBe("tenant_abc123");
        expect(identity.tenant.role).toBe("BUILDER");

        // App
        expect(identity.app.id).toBe("app_xyz789");
        expect(identity.app.permissions).toEqual([]);
        expect(identity.app.roles).toEqual([]);

        // Group attributes returned with the current identity.
        expect(identity.attributes).not.toBeNull();
        expect(identity.attributes?.groups).toEqual(["everyone", "developers"]);

        // Verify the request was made correctly with app-as-actor auth.
        const req = server!.calls[0];
        expect(req.url).toBe("/__keelson/users/usr_2abc123def456/identity");
        expect(req.headers["authorization"]).toBe("Bearer keelson_contract");
      }
    );
  });
});
