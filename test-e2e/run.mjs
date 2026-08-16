/**
 * Run the equivalence suite against one of the test worlds.
 *
 *   node run.mjs                          # base world, every scenario
 *   node run.mjs playwright-ember         # the Ember world
 *   node run.mjs --only human-fighter-sage
 *   node run.mjs --keep                   # leave the built actors in the world to inspect
 *   node run.mjs --debug                  # also dump every choice the creator's resolver raised
 *   node run.mjs --list                   # list scenarios and exit
 *   node run.mjs --ids <uuid>             # dump an item's advancement ids (for writing scenarios)
 *   node run.mjs --keep-riders            # don't strip empty rider flags (see normalize.mjs)
 *   node run.mjs --sidekicks              # assert Tasha's sidekick classes are not offered
 *   node run.mjs --granted-spells         # assert an always-prepared grant is never duplicated
 *   node run.mjs playwright-clean --probe-native "<scenario>/<item>" --level 5
 *                                         # native only, per level, in a world without this module
 *   HEADED=1 node run.mjs                 # watch the native wizard being driven
 *
 * And the subclass sweep — every subclass in the world, built both ways at level 20:
 *
 *   node run.mjs --sweep                  # the whole thing, one level at a time (hours)
 *   node run.mjs --sweep --level 6        # shallower
 *   node run.mjs --sweep --jump           # the whole span in one manager, compared once at the end
 *   node run.mjs --sweep --axis species     # vary the species instead of the subclass
 *   node run.mjs --sweep --axis background  # vary the background, taking a feat at every ASI
 *   node run.mjs --sweep --shard 1/20     # one twentieth of it, for a smoke test
 *   node run.mjs --sweep --resume         # skip scenarios already in sweep-results.jsonl
 *   node run.mjs --sweep --plan           # list what it would run, and what it skips
 *
 * Node's only jobs are booting Foundry, joining as GM, and printing results. The comparison
 * itself runs inside the world (see `in-world/harness.mjs`).
 */

import { WORLDS } from "./config.mjs";
import { startFoundry } from "./lib/server.mjs";
import { Session } from "./lib/session.mjs";
import { ensureWorld } from "./lib/worlds.mjs";

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const worldId = argv.find(a => !a.startsWith("--") && WORLDS[a]) ?? "playwright";
const only = value("only")?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
const keep = flag("keep");
const SWEEP_RESULTS = new URL("./sweep-results.jsonl", import.meta.url);

ensureWorld(worldId);
const server = await startFoundry(worldId, { verbose: flag("verbose") });
let session;
let exitCode = 0;

try {
  session = await Session.open();
  const harness = await load(session);

  if ( flag("list") ) {
    for ( const s of await harness("list") ) {
      console.log(`${s.id.padEnd(28)} ${String(s.world).padEnd(18)} ${s.name}`);
    }
  } else if ( flag("ids") ) {
    const uuid = value("ids");
    console.log(JSON.stringify(await harness("describeAdvancements", uuid), null, 2));
  } else if ( flag("compare-item") ) {
    // Split on the *last* slash: a sweep id has one of its own (`sweep:artificer/battle-smith`).
    const arg = value("compare-item");
    const cut = arg.lastIndexOf("/");
    const r = await harness("compareItem", {
      scenarioId: arg.slice(0, cut), itemName: arg.slice(cut + 1),
      level: Number(value("level") ?? 20), incremental: flag("incremental")
    });
    console.log(JSON.stringify(r, null, 2));
  } else if ( flag("probe-native") ) {
    // Native only, per level — point it at `playwright-clean` to answer "does dnd5e still do this
    // with our module switched off".
    const arg = value("probe-native");
    const cut = arg.lastIndexOf("/");
    const r = await harness("probeNative", {
      scenarioId: arg.slice(0, cut), itemName: arg.slice(cut + 1),
      level: Number(value("level") ?? 20), incremental: !flag("jump"), render: flag("render")
    });
    console.log(`world: ${r.world}   ${r.incremental ? "incremental" : "single jump"}`);
    for ( const l of r.byLevel ) {
      console.log(`  L${String(l.level).padStart(2)}  ${l.count} copy(ies)`
        + l.copies.map(c => `\n        prepared=${c.prepared} cachedFor=${c.cachedFor ?? "-"}`
          + ` advOrigin=${c.advancementOrigin ?? "-"}`).join(""));
    }
  } else if ( flag("probe-warm") ) {
    console.log(JSON.stringify(await harness("probeWarmCalls"), null, 2));
  } else if ( flag("probe") ) {
    const probe = { uuid: value("probe"), warm: flag("warm") };
    console.log(JSON.stringify(await harness("probeSource", probe), null, 2));
  } else if ( flag("find") ) {
    for ( const i of await harness("findItems", value("find")) ) {
      console.log(`${i.type.padEnd(12)} ${i.name.padEnd(30)} ${i.uuid}`);
    }
  } else if ( flag("sidekicks") ) {
    const r = await harness("checkSidekicks");
    for ( const c of r.checks ) {
      const mark = c.identifier === "artificer"
        ? (c.offered ? "offered (expected)" : "MISSING")
        : (c.offered ? "OFFERED" : (c.installed ? "hidden (expected)" : "not installed"));
      console.log(`  ${c.identifier.padEnd(12)} ${String(c.name ?? "—").padEnd(22)} ${mark}`);
    }
    console.log(`\n${r.classesOffered} class(es) offered by the creator:`);
    for ( const c of r.offered ) console.log(`  ${c}`);
    if ( r.ok ) console.log("\nPASS   no sidekick class is offered");
    else {
      console.log(`\nFAIL   ${r.failures.length} problem(s)`);
      for ( const f of r.failures ) console.log(`  ${f}`);
      exitCode = 1;
    }
  } else if ( flag("granted-spells") ) {
    const r = await harness("checkGrantedSpells");
    for ( const c of r.cases ) {
      console.log(`\n${c.ok ? "PASS  " : "FAIL  "} ${c.label}`);
      if ( c.error ) console.log(`  error: ${c.error}`);
      else {
        console.log(`  spell under test: ${c.overlap} — ${c.copies} cop(y|ies) on the character`);
        console.log(`  prepared: ${c.prepared} leveled, preparation.value = ${c.reportedPrepared ?? "—"}`);
        for ( const f of c.failures ) console.log(`  ! ${f}`);
      }
      for ( const s of c.spells ?? [] ) console.log(`      ${s}`);
    }
    if ( r.ok ) console.log("\nPASS   no granted spell is duplicated, and feat spells stay separate");
    else {
      console.log(`\nFAIL   ${r.failures.length} problem(s)`);
      for ( const f of r.failures ) console.log(`  ${f}`);
      exitCode = 1;
    }
  } else if ( flag("subclasses") ) {
    for ( const s of await harness("listSubclasses", value("subclasses")) ) {
      console.log(`${s.name.padEnd(28)} ${s.uuid}`);
    }
  } else if ( flag("sweep") ) {
    exitCode = await runSweep(harness);
  } else {
    const result = await harness("run", { only, keep });
    exitCode = report(result, { debug: flag("debug") });
    // A scenario that threw is usually a harness/content mismatch rather than a real difference,
    // and the world's own console is where the explanation lives.
    if ( result.reports.some(r => r.error) ) {
      const errors = session.consoleLog.filter(l => /^\[(error|warning|pageerror)\]/.test(l));
      console.log(`\n--- world errors & warnings (${errors.length}) ---\n${errors.slice(-25).join("\n")}`);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(new URL("./console.log", import.meta.url), session.consoleLog.join("\n"), "utf8");
      console.log("full world console written to test-e2e/console.log");
    }
  }
} catch ( err ) {
  console.error(`\n${err.message}`);
  if ( session ) console.error(`--- world console tail ---\n${session.tail(50)}`);
  exitCode = 1;
} finally {
  // `--console` writes the world's console whatever happened. The suite only keeps it on a failure,
  // which is right for a diff — but some questions are *about* what the world said rather than what
  // it built, and a warning raised mid-build leaves no trace in the committed actor at all.
  if ( flag("console") && session ) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(new URL("./console.log", import.meta.url), session.consoleLog.join("\n"), "utf8");
    console.log(`\nworld console written to test-e2e/console.log (${session.consoleLog.length} lines)`);
  }
  if ( session ) await session.close();
  await server.stop();
}
process.exit(exitCode);

/* -------------------------------------------- */

/**
 * Import the in-world harness into the page and return a caller for its exports.
 *
 * The module is served from Foundry's own static route, because the repo is junction-linked into
 * `Data/modules` — so these files are real ES modules with real imports, not stringified blobs.
 * The cache-buster makes an edited harness take effect without restarting Foundry.
 */
async function load(session) {
  const bust = Date.now();
  await session.eval(async bust => {
    const url = `/modules/sogrom-dnd5e-character-creator/test-e2e/in-world/harness.mjs?v=${bust}`;
    globalThis.__harness = await import(url);
  }, bust);
  // `--keep-riders` turns off the normaliser's empty-rider strip, to check whether that strip is
  // still doing any work now the driver cleans the flag at commit.
  if ( flag("keep-riders") ) await session.eval(() => { globalThis.__keepRiders = true; });

  return (fn, arg) => session.eval(
    ({ fn, arg }) => globalThis.__harness[fn](arg),
    { fn, arg }
  );
}

/* -------------------------------------------- */
/*  The subclass sweep                           */
/* -------------------------------------------- */

/**
 * Run the sweep, one scenario at a time, appending each result to `sweep-results.jsonl` as it lands.
 *
 * Driving the loop from here rather than in the world is the whole point: a level-20 build of ninety
 * subclasses, twice each, through a rendered wizard, is measured in hours. A run that returned only
 * at the end would lose everything to one stranded flow, and there would be no way to pick it back
 * up. So each scenario crosses the bridge on its own, is written out immediately, and `--resume`
 * reads the file back to decide what is left.
 *
 * The console gets one line per scenario; the full difference list goes to the file, because sixty
 * differences across ninety scenarios is not something to read as it scrolls past.
 * @returns {Promise<number>}   The process exit code.
 */
async function runSweep(harness) {
  const { appendFileSync, readFileSync, existsSync } = await import("node:fs");
  const level = Number(value("level") ?? 20);
  // Incremental by default, because it is what a player actually does: one level at a time, each
  // with its own commit. The single-jump walk is the special case — it is how the *creator* reaches
  // a target level in one manager, so it is still worth testing, but it is not the shape a
  // level-by-level character takes and it should not be what an unqualified `--sweep` measures.
  //
  // The two hide different bugs and neither subsumes the other: only the increments test what
  // survives a commit (a level-5 divergence that a later level papers over), while the jump alone
  // can misorder a level-20 capstone against level-4 points. Defaulting to the player's shape means
  // an unflagged run is the one whose result can be read as "would a real character come out right".
  // `--incremental` is still accepted, and now redundant, so existing scripts keep working.
  const incremental = !flag("jump");
  // Which axis to sweep. "subclass" is the original and the default; "species" holds the class fixed
  // and varies the species instead, covering the advancements a species gains above level 1.
  const axis = value("axis") ?? "subclass";

  const plan = await harness("sweepList", { level, incremental, axis });
  if ( plan.skipped.length ) {
    console.log(`skipping ${plan.skipped.length} subclass(es):`);
    for ( const s of plan.skipped ) console.log(`  ${s.subclass.padEnd(30)} ${s.reason}`);
  }

  let ids = plan.scenarios.map(s => s.id);

  // `--only` takes substrings, not exact ids — chasing one finding usually means "every Artificer"
  // or "every subclass of this class", and the ids are shaped `sweep:<class>/<subclass>` for it.
  if ( only ) {
    ids = ids.filter(id => only.some(q => id.includes(q)));
    if ( !ids.length ) throw new Error(`no sweep scenario matches ${JSON.stringify(only)}`);
  }

  // `--shard i/n` takes every nth scenario rather than a contiguous block, so one shard covers a
  // spread of classes instead of the first two alphabetically — a smoke test wants variety.
  const shard = value("shard");
  if ( shard ) {
    const [i, n] = shard.split("/").map(Number);
    if ( !(i >= 1 && i <= n) ) throw new Error(`--shard wants "i/n" with 1 <= i <= n, got "${shard}"`);
    ids = ids.filter((_, idx) => (idx % n) === (i - 1));
  }

  if ( flag("resume") && existsSync(SWEEP_RESULTS) ) {
    const done = new Set(readFileSync(SWEEP_RESULTS, "utf8").split("\n").filter(Boolean)
      .map(line => { try { return JSON.parse(line).id; } catch { return null; } }).filter(Boolean));
    const before = ids.length;
    ids = ids.filter(id => !done.has(id));
    console.log(`resuming: ${before - ids.length} already recorded, ${ids.length} to go`);
  }

  if ( flag("plan") ) {
    // The name carries `[class: <pack>]` whenever two modules publish a class under one identifier,
    // which is the part of a plan worth checking by eye — see `sweep.mjs#classFor`.
    const names = new Map(plan.scenarios.map(s => [s.id, s.name]));
    for ( const id of ids ) {
      const markers = (names.get(id)?.match(/\[[^\]]+\]/g) ?? []).join(" ");
      console.log(`${id}${markers ? `  ${markers}` : ""}`);
    }
    console.log(`\n${ids.length} scenario(s) at level ${level}`);
    return 0;
  }

  console.log(`\nsweeping ${ids.length} subclass(es) at level ${level}`
    + `${incremental ? ", one level at a time" : ", in a single jump"} → test-e2e/sweep-results.jsonl\n`);
  let passed = 0;
  let failed = 0;
  let errored = 0;

  for ( const [i, id] of ids.entries() ) {
    const position = `[${String(i + 1).padStart(3)}/${ids.length}]`;
    let r;
    try {
      r = await harness("sweepOne", { id, level, incremental, keep, render: flag("render"), axis });
    } catch ( err ) {
      // A scenario that takes the page down with it must not take the run down with it.
      r = { id, name: id, ok: false, error: err.message, differences: [], ms: 0 };
    }
    appendFileSync(SWEEP_RESULTS, `${JSON.stringify(r)}\n`, "utf8");

    if ( r.error ) {
      errored++;
      console.log(`${position} ERROR ${r.name} — ${r.error.split("\n")[0]}`);
    } else if ( r.ok ) {
      passed++;
      console.log(`${position} PASS  ${r.name} (${r.ms}ms)`);
    } else {
      failed++;
      // The level a difference *starts* at is the useful part of an incremental run; the count at
      // level 20 is mostly that same difference still being there.
      const at = r.levels?.firstDivergence
        ? ` — diverges at level ${r.levels.firstDivergence.level}`
        + ` (${r.levels.firstDivergence.differences.length} row(s))`
        : ` — ${r.differences.length} difference(s)`;
      console.log(`${position} FAIL  ${r.name} (${r.ms}ms)${at}`
        + `: ${[...new Set(r.differences.map(d => d.path.split(".")[0]))].join(", ")}`);
    }
  }

  console.log(`\n${passed} identical, ${failed} differing, ${errored} errored (of ${ids.length})`);
  console.log("group sweep-results.jsonl by difference path to triage — one cause spans many subclasses");
  return (failed || errored) ? 1 : 0;
}

/* -------------------------------------------- */

/**
 * Print a suite result. Returns the process exit code.
 * @param {{reports: object[], passed: number, total: number}} result
 */
function report({ reports, passed, total }, { debug = false } = {}) {
  for ( const r of reports ) {
    if ( r.error ) {
      console.log(`\nERROR  ${r.name} (${r.ms}ms)\n${indent(r.error)}`);
      printDiagnostics(r, debug);
      continue;
    }
    if ( r.ok ) {
      console.log(`\nPASS   ${r.name} (${r.ms}ms) — `
        + `${r.summary.native.items} items, ${r.summary.native.hp} hp, identical both ways`);
      printDiagnostics(r, debug);
      continue;
    }
    console.log(`\nFAIL   ${r.name} (${r.ms}ms) — ${r.differences.length} difference(s)`);
    console.log(`       native: ${r.summary.native.items} items / ${r.summary.native.hp} hp`
      + `   creator: ${r.summary.creator.items} items / ${r.summary.creator.hp} hp`);
    for ( const d of r.differences.slice(0, 60) ) {
      console.log(`  ${d.path}`);
      console.log(`      native : ${d.native}`);
      console.log(`      creator: ${d.creator}`);
    }
    if ( r.differences.length > 60 ) {
      console.log(`  … and ${r.differences.length - 60} more`);
    }
    printDiagnostics(r, debug);
  }

  const failed = total - passed;
  console.log(`\n${passed}/${total} scenarios identical${failed ? `, ${failed} failing` : ""}`);
  return failed ? 1 : 0;
}

function indent(text) {
  return text.split("\n").map(l => `       ${l}`).join("\n");
}

/**
 * Print the creator's view of the scenario: every choice its resolver raised, whether the
 * scenario answered it, and what it settled on. This is the answer to "did the creator even ask
 * about that?", which is the first question whenever a difference looks like a missing pick.
 */
function printDiagnostics(report, debug) {
  const d = report.diagnostics;
  if ( !debug || !d?.requirements ) {
    if ( !debug && d?.requirements ) console.log("       (re-run with --debug for the resolver dump)");
    return;
  }

  console.log(`\n  resolver dump — ${d.requirements.length} requirement(s) `
    + `over ${d.passes} pass(es):`);
  for ( const r of d.requirements ) {
    const mark = r.answered ? "answered" : "UNANSWERED";
    console.log(`    [${mark.padEnd(10)}] ${r.type.padEnd(12)} ${r.source.padEnd(10)} `
      + `${r.selKey}  "${r.title}" (choose ${r.count})`);
    console.log(`                   chosen : ${JSON.stringify(r.chosen)}`);
    console.log(`                   offers : ${r.options.join(", ")}`
      + `${r.moreOptions ? ` … +${r.moreOptions} more` : ""}`);
  }
  console.log(`\n  state.advChoices: ${JSON.stringify(d.advChoices, null, 2).split("\n").join("\n  ")}`);
}
