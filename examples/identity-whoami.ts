/**
 * Identity lookup example.
 *
 * Demonstrates getCurrentUser, getCurrentIdentity, listMembers, getUser, and
 * listGroups using the current API.
 *
 * Run in local mode (returns fixture data, no server needed):
 *   KEELSON_LOCAL_MODE=1 npx tsx identity-whoami.ts
 *
 * On Keelson, the auth gateway adds trusted X-Keelson-User-* headers before a
 * request reaches the app. Directory calls use the server-only app token from
 * KEELSON_DIRECTORY_TOKEN.
 */

import http from "node:http";
import {
  getCurrentIdentity,
  getCurrentUser,
  getUser,
  listGroups,
  listMembers
} from "@keelsonhq/identity";

async function localDemo() {
  const user = await getCurrentUser();
  const identity = await getCurrentIdentity();

  console.log("=== Current Identity (local) ===");
  console.log(`User:   ${user.id} (${user.email ?? "no email"})`);
  console.log(`Tenant: ${identity.tenant.id} (role: ${identity.tenant.role})`);
  console.log(`App:    ${identity.app.id}`);
  if (identity.attributes?.groups) {
    console.log(`Groups: ${identity.attributes.groups.join(", ")}`);
  }

  const page = await listMembers({ limit: 10 });
  console.log("\n=== Members ===");
  for (const member of page.items) {
    console.log(`  ${member.name} <${member.email}> (${member.role})`);
  }

  const groups = await listGroups();
  console.log("\n=== Groups ===");
  for (const group of groups) {
    console.log(`  ${group.key}: ${group.display_name} (${group.kind})`);
  }
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const directoryOptions = {
        app_token: process.env.KEELSON_DIRECTORY_TOKEN
      };

      const user = await getCurrentUser({ headers: req.headers });
      const identity = await getCurrentIdentity({
        headers: req.headers,
        ...directoryOptions
      });
      const page = await listMembers({ ...directoryOptions, limit: 10 });
      const firstMember = page.items[0] ? await getUser(page.items[0].id, directoryOptions) : null;
      const groups = await listGroups(directoryOptions);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ user, identity, members: page.items, firstMember, groups }, null, 2)
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err));
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`Identity example server on http://localhost:${port}`);
  });
}

const mode = process.argv[2] ?? "local";
if (mode === "server") {
  startServer();
} else {
  localDemo().catch(console.error);
}
