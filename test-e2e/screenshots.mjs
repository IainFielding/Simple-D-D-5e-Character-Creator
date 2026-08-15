/**
 * Recaptures the README screenshots from a real, running world.
 *
 *   node screenshots.mjs                     # every shot from the base world
 *   node screenshots.mjs --only=class,review # just those
 *   node screenshots.mjs --world=playwright-ember
 *   HEADED=1 node screenshots.mjs --only=class --hold   # watch it, then poke at the result
 *
 * Why this exists: the README's pictures are the module's shop window, and they go stale the
 * moment the UI is restyled. Taking fourteen of them by hand means fourteen chances to catch a
 * different character, a different window size, or a half-loaded portrait. Here the character is
 * seeded and identical every run, so a single screenshot can be retaken on its own and still
 * match the rest of the set.
 *
 * Output goes straight to `docs/screenshots/`, overwriting in place — review the diff in git
 * before keeping it.
 */

import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { WORLDS } from "./config.mjs";
import { startFoundry } from "./lib/server.mjs";
import { Session } from "./lib/session.mjs";
import { ensureWorld } from "./lib/worlds.mjs";

/**
 * 1667x957 at a 2x pixel ratio gives 3334x1914 files — matching the most recent hand-taken
 * screenshots in `docs/screenshots`, so newly captured and older images sit at the same scale
 * in the README until the whole set has been replaced.
 */
const VIEWPORT = { width: 1667, height: 957 };
const SCALE = 2;

const OUT_DIR = new URL("../docs/screenshots/", import.meta.url);

/**
 * The character every base-world picture is of — a Bard, so the spell screens have something to
 * show.
 *
 * The portrait is the Player's Handbook module's own journal art, so the pictures show a character
 * with a face rather than the default silhouette. It is a path into an installed module, not an
 * asset this repo ships. (Ember's own builder supplies a portrait, so the Ember shots don't set one.)
 */
const CHARACTER = {
  class: "Bard",
  name: "Aria Nightbreeze",
  portrait: "modules/dnd-players-handbook/assets/journal-art/college-of-glamour.webp",
  token: "modules/dnd-players-handbook/assets/tokens/college-of-glamour-bard.webp"
};

const argv = process.argv.slice(2);
const value = name => argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? null;
const hold = argv.includes("--hold");
const worldId = value("world") ?? "playwright";
const only = value("only")?.split(",").map(s => s.trim()).filter(Boolean) ?? null;

if ( !WORLDS[worldId] ) throw new Error(`Unknown world "${worldId}"`);

/* -------------------------------------------- */
/*  The shot list                               */
/* -------------------------------------------- */

/**
 * Each entry is one file in `docs/screenshots`. `setup` puts the world into the state the picture
 * wants; `clip` optionally narrows the capture to a single element, for the shots that are a panel
 * or a window rather than the whole screen.
 *
 * The order matters: shots run top to bottom against one open creator, each building on the last,
 * because re-opening and re-filling the wizard for every picture would triple the runtime.
 */
const SHOTS = {
  playwright: [
    {
      name: "welcome",
      note: "First render — the class grid, nothing chosen yet.",
      async setup(call) {
        await call("openCreator");
      }
    },
    {
      name: "class-step",
      note: "A class chosen, with its detail panel.",
      async setup(call) {
        await call("choose", { class: CHARACTER.class });
        await call("picker", false);
      }
    },
    {
      // Cropped to the detail page rather than the whole screen: the button is what the caption
      // is about, and at full width it is a 40px target lost in a 3334px picture.
      name: "quick-build",
      note: "The Quick Build button on the chosen class.",
      selector: ".creator-work-page",
      async setup() { /* same screen as class-step */ }
    },
    {
      // Everything from here on shows a filled character. Quick Build is the fastest way to get
      // one, it is seeded, and it fills exactly the fields a player would have filled by hand.
      name: "abilities",
      note: "The ability-score panel, with points spent.",
      selector: ".creator-work-side",
      async setup(call) {
        await call("quickBuild", { seed: 7, goTo: "class" });
        await call("details", {
          name: CHARACTER.name,
          portrait: CHARACTER.portrait,
          token: CHARACTER.token,
          lockRotation: true
        });
      }
    },
    {
      name: "background",
      note: "The background grid, with one chosen.",
      async setup(call) {
        await call("goto", "background");
        await call("picker", true);
      }
    },
    {
      name: "species",
      note: "The species grid, with one chosen.",
      async setup(call) {
        await call("goto", "species");
        await call("picker", true);
      }
    },
    {
      name: "details",
      note: "Name, portrait and token.",
      async setup(call) { await call("goto", "details"); }
    },
    {
      name: "spells",
      note: "The spell browser, with one spell's description open.",
      async setup(call) {
        await call("goto", "spells");
        await call("focusSpell", { index: 0 });
      }
    },
    {
      name: "choices",
      note: "The gathered choices step.",
      async setup(call) { await call("goto", "choices"); }
    },
    {
      name: "equipment",
      note: "Starting equipment bundles, with the instrument choices made.",
      async setup(call) {
        await call("goto", "equipment");
        await call("pickEquipment", [
          { source: "class", label: "Instrument of Illusions" },
          { source: "background", label: "Bandore" }
        ]);
      }
    },
    {
      name: "store",
      note: "The optional starting-gold store, mid-shop.",
      async setup(call) {
        await call("enableStore", true);
        // The shop is only worth a picture with money in it and something in the cart, and the
        // gold branch is the path the README describes for this step.
        await call("takeGold");
        await call("goto", "store");
        await call("shop", { count: 4 });
      }
    },
    {
      name: "review",
      note: "The review screen.",
      async setup(call) { await call("goto", "review"); }
    },
    {
      name: "actor",
      note: "The finished character sheet.",
      selector: ".app.sheet, .application.sheet",
      async setup(call) { await call("buildActor"); }
    },
    {
      name: "levelup",
      note: "The level-up wizard on the character just built.",
      async setup(call) { await call("levelUp"); }
    },
    {
      name: "store-config",
      note: "The GM's store configuration window.",
      selector: ".application",
      async setup(call) { await call("storeConfig"); }
    }
  ],

  /**
   * Ember runs creation itself and hands the level-1 questions to the system's AdvancementManager,
   * which this module claims — so the Ember pictures are of *our* wizard wearing Ember's skin.
   * See `scripts/levelup/ember-creation.mjs`.
   */
  "playwright-ember": [
    {
      name: "ember-handoff",
      note: "The creator's steps inside Ember's character creation, in Ember's skin.",
      async setup(call) { await call("emberCreation"); }
    },
    {
      name: "ember-store",
      note: "The starting-gold store inside Ember's creation flow.",
      async setup(call) {
        await call("enableStore", true);
        await call("takeGold");
        // No `gotoStep` here: the Ember rail is rebuilt from the driver's steps each render and a
        // later screen is unreachable until the earlier ones are answered. So walk the whole way
        // once, answering as it goes, which makes every step reachable — then jump back.
        await call("walkTo", { until: "Review" });
        await call("gotoRail", "Store");
        await call("shop", { count: 4 });
      }
    },
    {
      name: "ember-review",
      note: "The summary Ember's build ends on, before handing back.",
      async setup(call) { await call("gotoRail", "Review"); }
    },
    {
      name: "ember-levelup",
      note: "The level-up wizard restyled to match Ember.",
      async setup(call) {
        await call("emberActor");
        await call("levelUp");
      }
    }
  ]
};

/* -------------------------------------------- */
/*  Runner                                      */
/* -------------------------------------------- */

mkdirSync(OUT_DIR, { recursive: true });
ensureWorld(worldId);

const server = await startFoundry(worldId);
console.log(`Foundry up with world "${worldId}"`);

let session;
let exitCode = 0;
try {
  session = await Session.open({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const call = await load(session);

  const shots = SHOTS[worldId];
  if ( only && !shots.some(s => only.includes(s.name)) ) {
    throw new Error(`No shots matched --only=${only.join(",")}`);
  }

  /**
   * Every shot's `setup` runs, even the ones being skipped — they are steps in a single walk
   * through the wizard, so "just retake the review screen" still has to fill the character first.
   * `--only` filters the *capture*, not the walk. Shots after the last requested one are dropped,
   * since nothing later can change a picture already taken.
   */
  const lastWanted = only ? shots.findLastIndex(s => only.includes(s.name)) : shots.length - 1;

  for ( const shot of shots.slice(0, lastWanted + 1) ) {
    const capture = !only || only.includes(shot.name);
    process.stdout.write(`  ${shot.name} … `);
    await shot.setup(call);
    if ( !capture ) {
      console.log("(setup only)");
      continue;
    }
    await sleep(600);
    const path = new URL(`./${shot.name}.png`, OUT_DIR).pathname.slice(1);
    if ( shot.selector ) {
      const target = session.page.locator(shot.selector).last();
      await target.waitFor({ timeout: 15_000 });
      await target.screenshot({ path });
    } else {
      await session.page.screenshot({ path });
    }
    console.log("ok");
  }

  if ( hold ) {
    console.log("Holding — Ctrl+C to exit.");
    await sleep(3_600_000);
  }
} catch ( err ) {
  exitCode = 1;
  console.error(`\n${err.message}`);
  if ( session ) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(new URL("./console.log", import.meta.url), session.consoleLog.join("\n"), "utf8");
    await session.page.screenshot({ path: new URL("./failure.png", import.meta.url).pathname.slice(1) })
      .catch(() => {});
    console.error("wrote console.log and failure.png");
  }
} finally {
  if ( session ) await session.close();
  await server.stop();
}
process.exit(exitCode);

/**
 * Import `in-world/shots.mjs` into the page and return a caller for its exports — the same
 * loader pattern `run.mjs` uses, cache-busted so an edit takes effect without a server restart.
 * @param {Session} session
 * @returns {Promise<(fn: string, arg?: any) => Promise<any>>}
 */
async function load(session) {
  await session.eval(async bust => {
    const url = `/modules/sogrom-dnd5e-character-creator/test-e2e/in-world/shots.mjs?v=${bust}`;
    globalThis.__shots = await import(url);
  }, Date.now());
  return (fn, arg) => session.eval(
    ({ fn, arg }) => globalThis.__shots[fn](arg),
    { fn, arg }
  );
}
