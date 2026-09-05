/**
 * Configuration for the end-to-end harness — **copy this to `config.mjs` and edit the paths**.
 *
 * The harness drives a *real* Foundry install against *real* content modules, so the paths below
 * are specific to the machine it runs on. `config.mjs` is gitignored for that reason; this file is
 * the tracked template.
 *
 * Everything the harness needs beyond these paths is in `README.md`.
 */

/** Where Foundry Virtual Tabletop itself is installed (the dir holding `main.mjs`). */
export const FOUNDRY_ROOT = "C:/foundryvtt";

/** Foundry's user data root (the dir holding `Data/`, `Config/`, `Logs/`). */
export const DATA_PATH = "C:/Users/<you>/AppData/Local/FoundryVTT";

/** Foundry's `Data/` dir, where worlds/modules/systems live. */
export const DATA_DIR = `${DATA_PATH}/Data`;

/**
 * Port for the harness's own Foundry instance. Deliberately *not* 30000 so a Foundry the user
 * already has running on the default port is left alone.
 */
export const PORT = 30099;

export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** The module under test, junction-linked into `Data/modules` by `npm run link-module`. */
export const MODULE_ID = "sogrom-dnd5e-character-creator";

/** The repo root, i.e. the junction target. */
export const MODULE_SOURCE = "C:/path/to/Simple-DnD5e-Character-Creator";

/**
 * Content modules enabled in every test world, plus the module under test.
 *
 * These are the packs the scenarios and the subclass sweep draw on. Dropping one is fine — the
 * sweep enumerates whatever subclasses the world actually has and reports the rest as skipped —
 * but the recorded difference counts in `README.md` assume this set.
 */
export const BASE_MODULES = [
  MODULE_ID,
  "dice-so-nice",
  "dnd-dungeon-masters-guide",
  "dnd-forge-artificer",
  "dnd-heroes-faerun",
  "dnd-monster-manual",
  "dnd-players-handbook",
  "dnd-ravenloft-horrors-within",
  // Tasha's Cauldron of Everything — 30 subclasses across 13 classes, plus the Artificer and the
  // five sidekick classes. The sweep's only 2014-rules content, built onto the 2014 classes the
  // system still ships; it also injects optional features into every 2014 class in the world.
  "dnd-tashas-cauldron"
];

/** The system the test worlds run, and the version this harness was written against. */
export const SYSTEM = "dnd5e";
export const SYSTEM_VERSION = "6.0.0";
export const CORE_VERSION = "14.367";

/**
 * The two test worlds. `id` doubles as the directory name under `Data/worlds`.
 *
 * `playwright`        — the baseline: dnd5e + the content modules, for native-vs-creator
 *                       equivalence on standard PHB'24 characters.
 * `playwright-ember`  — the same plus Ember and its imported adventure, for the Ember
 *                       creation hand-off (see the module's `levelup/ember-creation.mjs`).
 */
export const WORLDS = {
  playwright: {
    id: "playwright",
    title: "Playwright",
    description: "<p>Automated equivalence harness: dnd5e native advancement vs the Simple "
      + "Character Creator. Content is disposable — actors are created and deleted per run.</p>",
    modules: BASE_MODULES,
    /** Adventure packs to import once, at provision time. */
    adventures: []
  },
  "playwright-ember": {
    id: "playwright-ember",
    title: "Playwright-Ember",
    description: "<p>Automated equivalence harness with Ember enabled and its adventure "
      + "imported, for the Ember character-creation hand-off.</p>",
    modules: [...BASE_MODULES, "ember"],
    adventures: ["ember.adventure"]
  },
  /**
   * The same content with the module under test **switched off**, so only the native adapter runs.
   * Several findings come down to timing around the system's own un-awaited writes, and "does this
   * still happen without us in the room" is what decides whether they are dnd5e's or ours.
   */
  "playwright-clean": {
    id: "playwright-clean",
    title: "Playwright-Clean",
    description: "<p>Native dnd5e only — the Simple Character Creator is deliberately not enabled. "
      + "For deciding whether a difference is the system's or ours.</p>",
    modules: BASE_MODULES.filter(m => m !== MODULE_ID),
    adventures: []
  }
};

/** The user the harness plays as. Foundry auto-creates this on a world with no GM. */
export const GM_USER = "Gamemaster";

/** Set true to watch the browser drive Foundry. `HEADED=1 npm run …` also flips it. */
export const HEADED = process.env.HEADED === "1";

/** How long to wait for the Foundry server to accept connections, and for `game.ready`. */
export const SERVER_TIMEOUT_MS = 120_000;
export const WORLD_READY_TIMEOUT_MS = 90_000;
