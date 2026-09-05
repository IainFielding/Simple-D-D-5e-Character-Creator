/**
 * One-time (idempotent) setup of the test worlds.
 *
 *   node provision.mjs                    # both worlds
 *   node provision.mjs playwright         # just the base world
 *   node provision.mjs playwright-ember   # just the Ember world
 *   node provision.mjs --reset            # delete world databases first, rebuild from scratch
 *
 * For each world this: writes the manifest, activates the world (Foundry creates the database
 * and a passwordless "Gamemaster"), enables exactly the configured module set, reloads, verifies
 * every module actually came up active, and imports any configured adventure packs.
 */

import { MODULE_ID, WORLDS } from "./config.mjs";
import { startFoundry } from "./lib/server.mjs";
import { Session } from "./lib/session.mjs";
import { ensureWorld, resetWorldData, worldInitialised } from "./lib/worlds.mjs";

const argv = process.argv.slice(2);
const reset = argv.includes("--reset");
const force = argv.includes("--force");
const targets = argv.filter(a => !a.startsWith("--"));
const worlds = targets.length ? targets : Object.keys(WORLDS);

for ( const id of worlds ) {
  if ( !WORLDS[id] ) {
    console.error(`Unknown world "${id}". Known: ${Object.keys(WORLDS).join(", ")}`);
    process.exit(1);
  }
}

for ( const worldId of worlds ) await provision(worldId);

/* -------------------------------------------- */

/** @param {string} worldId */
async function provision(worldId) {
  const spec = WORLDS[worldId];
  console.log(`\n=== Provisioning "${spec.title}" (${worldId}) ===`);

  if ( reset ) {
    resetWorldData(worldId);
    console.log("  database reset");
  }
  const { created } = ensureWorld(worldId, { force });
  console.log(`  manifest ${created ? "created" : "already present"}`
    + `; database ${worldInitialised(worldId) ? "exists" : "will be created on first launch"}`);

  const server = await startFoundry(worldId);
  let session;
  try {
    session = await Session.open();
    console.log("  joined as Gamemaster");

    const result = await enableModules(session, spec.modules);
    if ( result.changed ) {
      console.log(`  module configuration written (${result.enabled.length} enabled), reloading…`);
      await session.reload();
    } else {
      console.log("  module configuration already correct");
    }

    // The module's `log()` is silent unless debug logging is on, and the harness leans on it: a
    // stranded flow or a swallowed resolver error explains itself through those lines, and
    // `run.mjs --console` captures the page console to read them back. Turned on per world, after
    // the reload, because the setting only exists once the module has registered it.
    // The canvas is disabled in `lib/session.mjs`, not here: `core.noCanvas` is a *client*-scoped
    // setting living in `window.localStorage`, so writing it from a joined session only affects that
    // session's browser context and is discarded with it. Setting it at provision time looked like
    // it worked and changed nothing.

    if ( spec.modules.includes(MODULE_ID) ) {
      await session.eval(async id => {
        try { await game.settings.set(id, "debugLogging", true); } catch { /* module not active */ }
      }, MODULE_ID);
      console.log("  debug logging enabled (harness diagnostics)");
    }

    const status = await moduleStatus(session, spec.modules);
    for ( const m of status ) {
      const mark = m.active ? "ok" : (m.installed ? "INACTIVE" : "NOT INSTALLED");
      console.log(`    [${mark.padEnd(13)}] ${m.id}`);
    }
    const bad = status.filter(m => !m.active);
    if ( bad.length ) {
      throw new Error(`These modules did not activate: ${bad.map(m => m.id).join(", ")}. `
        + `Check dependencies / system compatibility.\n${session.tail()}`);
    }

    for ( const packId of spec.adventures ?? [] ) {
      const imported = await importAdventures(session, packId, force);
      for ( const line of imported ) console.log(`    ${line}`);
    }

    console.log(`  "${spec.title}" ready`);
  } catch ( err ) {
    if ( session ) console.error(`\n--- world console tail ---\n${session.tail()}\n---`);
    throw err;
  } finally {
    if ( session ) await session.close();
    await server.stop();
  }
}

/* -------------------------------------------- */

/**
 * Write `core.moduleConfiguration` so exactly `wanted` are on and everything else is off.
 * Returns `changed: false` when the current configuration already matches, so a re-provision
 * skips the reload.
 */
function enableModules(session, wanted) {
  return session.eval(async wanted => {
    const want = new Set(wanted);
    const current = game.settings.get("core", "moduleConfiguration") ?? {};
    const next = {};
    let changed = false;
    for ( const id of game.modules.keys() ) {
      next[id] = want.has(id);
      if ( (current[id] ?? false) !== next[id] ) changed = true;
    }
    // A wanted module that isn't installed still gets recorded, so the mismatch surfaces in the
    // status readout below rather than being silently dropped here.
    for ( const id of want ) if ( !(id in next) ) { next[id] = true; changed = true; }
    if ( changed ) await game.settings.set("core", "moduleConfiguration", next);
    return { changed, enabled: Object.entries(next).filter(([, on]) => on).map(([id]) => id) };
  }, wanted);
}

/** Per-module `{ id, installed, active }` for the wanted set, read off the live world. */
function moduleStatus(session, wanted) {
  return session.eval(wanted => wanted.map(id => {
    const mod = game.modules.get(id);
    return { id, installed: !!mod, active: !!mod?.active };
  }), wanted);
}

/**
 * Import every Adventure document in a compendium pack, then report what the world ended up with.
 *
 * Foundry records completed imports in `core.adventureImports`, which is what makes this safe to
 * re-run: already-imported adventures are skipped unless `force` is set. A large adventure (Ember's
 * is one) can navigate the page as part of its import — activating a scene, or a module reloading
 * the client — which tears down the evaluation context mid-call. That is a completion, not a
 * failure, so it is caught and the world is simply waited for again before verifying.
 */
async function importAdventures(session, packId, force) {
  const lines = [];
  try {
    lines.push(...await runImport(session, packId, force));
  } catch ( err ) {
    if ( !/Execution context was destroyed|Target (page|closed)|navigation/i.test(err.message) ) throw err;
    lines.push("import navigated the page — waiting for the world to come back");
    await session.waitForReady();
  }
  lines.push(...await verifyImported(session, packId));
  return lines;
}

/** Read back which adventures in the pack are recorded as imported, and the resulting doc counts. */
function verifyImported(session, packId) {
  return session.eval(async packId => {
    const pack = game.packs.get(packId);
    if ( !pack ) return [`adventure pack "${packId}" not found`];
    const imports = game.settings.get("core", "adventureImports") ?? {};
    const lines = [];
    for ( const { uuid, name } of await pack.getIndex() ) {
      lines.push(`  "${name}": ${imports[uuid] ? "imported" : "NOT RECORDED AS IMPORTED"}`);
    }
    lines.push(`  world now holds ${game.actors.size} actors, ${game.items.size} items, `
      + `${game.scenes.size} scenes, ${game.journal.size} journals`);
    return lines;
  }, packId);
}

/** The import pass itself. Split out so the navigation-tolerant wrapper above stays readable. */
function runImport(session, packId, force) {
  return session.eval(async ({ packId, force }) => {
    const pack = game.packs.get(packId);
    if ( !pack ) return [`adventure pack "${packId}" not found — is its module active?`];

    const imports = game.settings.get("core", "adventureImports") ?? {};
    const docs = await pack.getDocuments();
    const lines = [];
    for ( const adventure of docs ) {
      if ( imports[adventure.uuid] && !force ) {
        lines.push(`adventure "${adventure.name}" already imported — skipped`);
        continue;
      }
      const result = await adventure.import({ dialog: false });
      lines.push(`adventure "${adventure.name}" imported `
        + `(${result.created?.length ?? 0} created, ${result.updated?.length ?? 0} updated)`);
    }
    return lines;
  }, { packId, force });
}
