/**
 * Junction-link the module's working tree into Foundry's `Data/modules`, so the test worlds run
 * the code in the repo rather than an installed copy. A junction (not a symlink) is used because
 * it needs no elevation and works across volumes — the repo is on H:, Foundry's data on C:.
 *
 * Idempotent: reports and exits if the link already exists.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR, MODULE_ID, MODULE_SOURCE } from "../config.mjs";

const link = path.join(DATA_DIR, "modules", MODULE_ID);

if ( fs.existsSync(link) ) {
  const stat = fs.lstatSync(link);
  const kind = stat.isSymbolicLink() ? `link -> ${fs.readlinkSync(link)}` : "real directory";
  console.log(`Already present: ${link}\n  (${kind})`);
  process.exit(0);
}

if ( !fs.existsSync(path.join(MODULE_SOURCE, "module.json")) ) {
  console.error(`No module.json at ${MODULE_SOURCE} — check MODULE_SOURCE in config.mjs.`);
  process.exit(1);
}

execFileSync("cmd", ["/c", "mklink", "/J", link, path.resolve(MODULE_SOURCE)], { stdio: "inherit" });
console.log(`Linked ${MODULE_ID} -> ${MODULE_SOURCE}`);
