import { clients, manageConfig } from "./integration-config.ts";
import type { ClientName } from "./integration-config.ts";
const [client, action, directory] = process.argv.slice(2);
if (
  !clients.includes(client as ClientName) ||
  !["status", "install"].includes(action) ||
  !directory
)
  process.exit(1);
console.log(
  JSON.stringify(
    manageConfig(client as ClientName, action === "install", directory),
  ),
);
