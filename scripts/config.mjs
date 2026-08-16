/**
 * Shared constants and small runtime helpers for the Character Creator.
 *
 * Kept deliberately free of Application/DOM concerns so every layer (state, data,
 * steps, build) can import from here without pulling in the UI.
 *
 * For a junior dev: this is the "grab bag" module every other file imports from.
 * If you need a constant or a tiny helper that has nothing to do with the UI, it
 * probably lives here. Nothing in this file touches the DOM or a Foundry Application.
 */

// The module's unique id. Must match the "id" field in module.json. Foundry uses it
// to namespace our settings, templates, and localisation keys so they never collide
// with another module's.
// The factory default store stock (a list of UUID strings, no UI imports, so this file
// stays safe for every layer to import), kept in its own data file so the list can grow
// without cluttering this grab bag. `defaultInventoryUuids()` serves the ids from the
// Player's Handbook module's pack when that is active, else the system's free-rules pack.
import { defaultInventoryUuids } from "./data/store-defaults.mjs";

export const MODULE_ID = "sogrom-dnd5e-character-creator";

/** Ability keys in canonical display order. */
export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

/* -------------------------------------------- */
/*  Public hook surface                         */
/* -------------------------------------------- */

/**
 * The namespace every hook this module emits is prefixed with.
 *
 * Deliberately *not* "sogrom": the same author publishes a dozen other `sogrom-*` content
 * modules, so that namespace would be ambiguous the moment any of them wanted a hook of their
 * own. This is the camelCase of the module title, which is the convention other Foundry modules
 * follow (Hero Mancer emits `heroMancer.*`).
 *
 * Changing this string is a breaking change for every consumer, so treat it as permanent.
 */
export const HOOK_PREFIX = "simpleCharacterCreator";

/**
 * Every hook this module emits, as `alias -> full hook name`.
 *
 * Same rationale as {@link SETTINGS}: one map means the code that *emits* a hook and the code
 * that documents or re-exports it can never drift. The whole map is published on the module's
 * public API (`game.modules.get(MODULE_ID).api.HOOKS`) so a consumer can subscribe without
 * hard-coding strings, and is frozen so nobody can rewrite a name at runtime.
 *
 * Two kinds, distinguished by the `pre` prefix and by which helper fires them:
 *  - **`pre…` hooks are cancellable.** They go through {@link fireCancellableHook}, which uses
 *    `Hooks.call`; a listener returning `false` aborts the action. This is dnd5e's own house
 *    style — the same contract we honour for `dnd5e.preAdvancementManagerComplete`.
 *  - **Everything else is notification-only**, fired with `Hooks.callAll` via {@link fireHook}.
 *    A listener's return value is ignored.
 *
 * Every payload is a single object argument, so a hook can gain a field later without breaking
 * listeners that destructure the ones they already know about.
 *
 * See docs/API.md for the payload of each.
 */
export const HOOKS = Object.freeze({
  /** `{api, version}` — the module is ready and its API is installed. */
  ready: `${HOOK_PREFIX}.ready`,

  /** `{actor, options}` — **cancellable**; return false to stop the creator opening. */
  preOpenCreator: `${HOOK_PREFIX}.preOpenCreator`,
  /** `{app, state}` — the creator is open and its first step is on screen. */
  creatorOpened: `${HOOK_PREFIX}.creatorOpened`,
  /** `{app, state, from, to, step}` — the player moved between creation steps. */
  creationStepChanged: `${HOOK_PREFIX}.creationStepChanged`,
  /** `{state, actor}` — **cancellable**; return false to veto the build before anything is written. */
  preCreateCharacter: `${HOOK_PREFIX}.preCreateCharacter`,
  /** `{actor, state, targetLevel}` — a character is finished. Fires exactly once per build. */
  characterCreated: `${HOOK_PREFIX}.characterCreated`,

  /** `{manager, actor}` — **cancellable**; return false to decline the takeover and let dnd5e's native wizard run. */
  preLevelUpTakeover: `${HOOK_PREFIX}.preLevelUpTakeover`,
  /** `{actor, app, state, driver}` — the level-up wizard is open. */
  levelUpStarted: `${HOOK_PREFIX}.levelUpStarted`,
  /** `{app, state, from, to, step}` — the player moved between level-up steps. */
  levelUpStepChanged: `${HOOK_PREFIX}.levelUpStepChanged`,
  /** `{actor, state, summary}` — **cancellable**; return false to veto the apply. */
  preLevelUpApply: `${HOOK_PREFIX}.preLevelUpApply`,
  /** `{actor, state, fromLevel, toLevel, summary}` — the level-up has been written to the actor. */
  levelUpApplied: `${HOOK_PREFIX}.levelUpApplied`,
  /** `{actor, state}` — the player discarded a level-up; the actor was never touched. */
  levelUpCancelled: `${HOOK_PREFIX}.levelUpCancelled`,
  /** `{manager, actor}` — we claimed Ember's advancement manager to ask its level-1 questions. */
  emberHandoff: `${HOOK_PREFIX}.emberHandoff`
});

/**
 * Fire a notification-only hook. Never throws: a listener in another module blowing up must not
 * take a character build down with it, so a bad listener is logged and the flow continues.
 * @param {string} hook     A value from {@link HOOKS}.
 * @param {object} payload  The single object argument handed to listeners.
 */
export function fireHook(hook, payload) {
  log(`hook ${hook}`, payload);
  try {
    Hooks.callAll(hook, payload);
  } catch ( err ) {
    // Foundry already reports a throwing listener; this only stops it unwinding *our* call stack.
    log(`listener threw on ${hook}`, err);
  }
}

/**
 * Fire a cancellable hook and report whether the action may proceed.
 *
 * `Hooks.call` stops at the first listener that returns exactly `false` and hands that back, which
 * is the contract dnd5e uses for its own `pre…` hooks. A listener that throws is treated as *not*
 * a veto — silently cancelling a build because somebody else's module has a bug would be a much
 * worse failure than ignoring them.
 * @param {string} hook     A value from {@link HOOKS}.
 * @param {object} payload  The single object argument handed to listeners.
 * @returns {boolean}       False when a listener vetoed; true to carry on.
 */
export function fireCancellableHook(hook, payload) {
  log(`hook ${hook} (cancellable)`, payload);
  let allowed = true;
  try {
    allowed = Hooks.call(hook, payload) !== false;
  } catch ( err ) {
    log(`listener threw on ${hook}; treating as no veto`, err);
    return true;
  }
  if ( !allowed ) log(`${hook} vetoed by a listener`);
  return allowed;
}

/**
 * The D&D ability modifier for a score: (score - 10) / 2, rounded down, rendered with an
 * explicit + or - sign (e.g. 16 → "+3", 8 → "-1").
 * @param {number} score
 * @returns {string}
 */
export function formatMod(score) {
  const mod = Math.floor((score - 10) / 2);
  // Plain ASCII hyphen-minus. This briefly used U+2212 MINUS SIGN, on the reasoning that it
  // matches the plus in width and height where a hyphen does not — which is true in a font
  // that has the glyph. Spectral's subset declares U+2212 in its `unicode-range` but does not
  // actually carry it, so the browser rendered that one character from a fallback face, and
  // the fallback's taller metrics grew the line box. The result was a dossier plate 4px taller
  // than its neighbours on exactly the one ability with a negative modifier.
  //
  // Any character outside the shipped subsets will do the same thing. Keep modifiers to
  // characters the fonts certainly have, and see `.creator-dossier-mod`, whose line-height is
  // now pinned so a stray glyph can never change a box's height again.
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

// The string keys for every world setting this module registers with Foundry.
// Centralising them here means the code that *registers* a setting and the code that
// *reads* it always use the exact same key — no risk of a typo silently reading `undefined`.
export const SETTINGS = {
  launchButton: "showLaunchButton",
  contextMenu: "showContextMenu",
  pointBuyBudget: "pointBuyBudget",
  rollFormula: "abilityRollFormula",
  displayMode: "displayMode",
  mode: "mode",
  levelUpButton: "showLevelUpButton",
  headerMenu: "showLevelUpHeaderMenu",
  levelUpHpMode: "levelUpHpMode",
  levelUpHpRollToChat: "levelUpHpRollToChat",
  creationSummary: "creationSummary",
  levelUpSummary: "levelUpSummary",
  multiclass: "allowMulticlass",
  storeEnabled: "storeEnabled",
  storeConfig: "storeConfig",
  debug: "debugLogging"
};

// The fallback value for each setting, used when the world hasn't overridden it (and as
// the `default` we hand to Foundry at registration time).
export const DEFAULTS = {
  pointBuyBudget: 27,
  rollFormula: "4d6kh3",
  displayMode: "fullscreen",
  mode: "creation-levelup",
  levelUpButton: true,
  // Off by default, unlike the sheet button. This is a *second* front door onto a flow that
  // already has one, and a default of true would silently add an entry to every character
  // sheet's menu on update — a GM who wants it can say so.
  headerMenu: false,
  levelUpHpMode: "choice",
  levelUpHpRollToChat: true,
  creationSummary: "public",
  levelUpSummary: "public",
  multiclass: "off",
  storeEnabled: true,
  storeConfig: {
    priceMultiplier: 1.0,
    inventory: null            // null = the factory default list; [] = deliberately emptied
  },
  debug: false
};

/**
 * The valid values of the module `mode` setting:
 *  - `"creation"`         — the module only owns character creation; levelling stays native.
 *  - `"creation-levelup"` — creation plus the level-up takeover (the default).
 *  - `"levelup"`          — level-up only; every creation entry point (launch button,
 *                           context menu) is hidden and the native creation flow is untouched.
 */
export const MODES = ["creation", "creation-levelup", "levelup"];

/**
 * The valid values of the level-up hit-point mode setting, from most to least permissive:
 *  - `"choice"`       — average, roll, max, or a manually-typed value (the module's original behaviour).
 *  - `"average-roll"` — average or roll only (the 2024 rules as written); no max, no manual entry.
 *  - `"average"`      — average only; the buttons collapse to a single pre-made decision.
 */
export const HP_MODES = ["choice", "average-roll", "average"];

/**
 * How much freedom players get on the level-up hit-point decision, per the world setting.
 * Guards against an unknown stored value by falling back to the default.
 * @returns {"choice"|"average-roll"|"average"}
 */
export function levelUpHpMode() {
  const raw = game.settings.get(MODULE_ID, SETTINGS.levelUpHpMode);
  return HP_MODES.includes(raw) ? raw : DEFAULTS.levelUpHpMode;
}

/**
 * Whether a level-up hit-die roll should also post the system's roll card to chat, so the
 * table can see the result — off by default to keep the wizard quiet.
 * @returns {boolean}
 */
export function levelUpHpRollToChat() {
  return !!game.settings.get(MODULE_ID, SETTINGS.levelUpHpRollToChat);
}

/**
 * The valid values of the two chat-summary settings, from most to least visible:
 *  - `"public"` — the card goes to the whole table (the default; announcing the character is the
 *                 point of the feature).
 *  - `"gm"`     — whispered to Game Masters only, for tables where the GM vets characters, or
 *                 simply wants the log without the chatter.
 *  - `"off"`    — never posted.
 */
export const SUMMARY_MODES = ["public", "gm", "off"];

/**
 * Read one of the chat-summary settings, guarding against an unknown stored value. Both settings
 * share the same three modes, so they share this reader; {@link creationSummaryMode} and
 * {@link levelUpSummaryMode} are the call sites.
 * @param {string} key   One of {@link SETTINGS}.creationSummary / .levelUpSummary.
 * @returns {"public"|"gm"|"off"}
 */
function summaryMode(key) {
  const raw = game.settings.get(MODULE_ID, key);
  return SUMMARY_MODES.includes(raw) ? raw : DEFAULTS[key];
}

/** Who sees the card posted when a character is finished. @returns {"public"|"gm"|"off"} */
export function creationSummaryMode() {
  return summaryMode(SETTINGS.creationSummary);
}

/** Who sees the card posted when a level-up is applied. @returns {"public"|"gm"|"off"} */
export function levelUpSummaryMode() {
  return summaryMode(SETTINGS.levelUpSummary);
}

/**
 * The valid values of the multiclass setting, from most to least restrictive:
 *  - `"off"`    — the level-up wizard never adds a new class; multiclass drops go to the native UI.
 *  - `"prereq"` — multiclassing allowed, enforcing the rules-as-written ability prerequisites
 *                 (13+ in the primary ability of both the current and the new class).
 *  - `"free"`   — multiclassing allowed with no prerequisite check (homebrew tables).
 */
export const MULTICLASS_MODES = ["off", "prereq", "free"];

/**
 * Whether (and how) players may add a new class during level-up, per the world setting.
 * Guards against an unknown stored value by falling back to the default.
 * @returns {"off"|"prereq"|"free"}
 */
export function multiclassMode() {
  const raw = game.settings.get(MODULE_ID, SETTINGS.multiclass);
  return MULTICLASS_MODES.includes(raw) ? raw : DEFAULTS.multiclass;
}

/**
 * The GM's starting-gold store configuration, guarded field by field so a malformed stored
 * object (an older shape, a hand-edited value) can never break the store step. `enabled`
 * mirrors the plain visible checkbox setting; the rest lives in the hidden object setting
 * managed by the {@link module:app/store-config} menu.
 *
 * `inventory` is the curated shelf list — entries of `{uuid, name, img, type, baseCp,
 * overrideCp, hidden}` (see store-source's `sanitizeEntry` for the per-entry guarding).
 * When the stored value is not an array (a fresh world, or the pre-release shape), the
 * factory default UUID list stands in as bare `{uuid}` skeletons that hydrate on first use;
 * an empty array is a real choice (the GM cleared the shelves) and is left alone.
 * @returns {{enabled: boolean, priceMultiplier: number, inventory: object[]}}
 */
export function storeConfig() {
  const defaults = DEFAULTS.storeConfig;
  let raw;
  try {
    raw = game.settings.get(MODULE_ID, SETTINGS.storeConfig);
  } catch {
    raw = null;
  }
  if ( !raw || typeof raw !== "object" ) raw = {};
  const mult = Number(raw.priceMultiplier);
  const inventory = Array.isArray(raw.inventory)
    ? raw.inventory.filter(e => e && typeof e === "object" && typeof e.uuid === "string" && e.uuid)
    : defaultInventoryUuids().map(uuid => ({ uuid }));
  return {
    enabled: !!game.settings.get(MODULE_ID, SETTINGS.storeEnabled),
    priceMultiplier: Number.isFinite(mult) && mult > 0 ? mult : defaults.priceMultiplier,
    inventory
  };
}

/**
 * The module's effective mode. Normally this is the `mode` world setting (guarded against an
 * unknown stored value). When the Ember module is active it is always `"levelup"`: Ember ships
 * its own character creation, so ours stands down and only the level-up takeover runs —
 * regardless of what the setting stored before Ember was enabled.
 * @returns {"creation"|"creation-levelup"|"levelup"}
 */
export function moduleMode() {
  if ( emberActive() ) return "levelup";
  const raw = game.settings.get(MODULE_ID, SETTINGS.mode);
  return MODES.includes(raw) ? raw : DEFAULTS.mode;
}

/**
 * Whether the module owns character creation (the launch button, the actor context menu and
 * the creator window itself). Off in `"levelup"` mode — and therefore always off while Ember
 * is active, since Ember owns creation.
 * @returns {boolean}
 */
export function creationEnabled() {
  return moduleMode() !== "levelup";
}

/**
 * Whether the module owns the level-up experience, per the effective {@link moduleMode}.
 * `"creation-levelup"` and `"levelup"` opt the table into the level-up takeover (§5 of the
 * level-up plan); `"creation"` leaves the actor sheet and the native advancement flow
 * untouched. Both level-up trigger paths are gated on this.
 * @returns {boolean}
 */
export function levelUpEnabled() {
  return moduleMode() !== "creation";
}

/**
 * Whether the Ember module is active in this world. Ember brings its own character creator,
 * so we cede creation to it ({@link moduleMode} pins to `"levelup"`) and re-skin our level-up
 * window to match its look (the `sogrom-ember` class, see styles/ember-skin.css).
 * @returns {boolean}
 */
export function emberActive() {
  return !!game.modules.get("ember")?.active;
}

/**
 * Fallback counts of cantrips / level-1 spells known at level 1, keyed by class
 * identifier. Consulted only when a class carries no matching ScaleValue advancement
 * to read the figure from — see {@link module:data/spell-source}.
 */
export const DEFAULT_CANTRIPS = {
  artificer: 2, bard: 2, cleric: 3, druid: 2,
  ranger: 0, sorcerer: 4, warlock: 2, wizard: 3
};
export const DEFAULT_LEVEL1_SPELLS = {
  artificer: 2, bard: 2, cleric: 3, druid: 3,
  ranger: 0, sorcerer: 2, warlock: 2, wizard: 6
};

/**
 * Turn a translation key into the text the player sees, in their configured language.
 * We prefix the key with the module id so it resolves against *our* entries in lang/en.json
 * (e.g. t("step.class.label") reads "sogrom-dnd5e-character-creator.step.class.label").
 *
 * Call only after i18n is ready (never in static field initialisers), because `game.i18n`
 * isn't populated until Foundry's setup phase. Pass `data` to fill `{token}` placeholders.
 * @param {string} key            Key relative to the module namespace.
 * @param {object} [data]         Optional interpolation data.
 * @returns {string}
 */
export function t(key, data) {
  const full = `${MODULE_ID}.${key}`;
  // `format` fills in {placeholders}; `localize` is the plain lookup with none.
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

/** Build the full path to one of this module's template files (e.g. tpl("stage.hbs")). */
export function tpl(relative) {
  return `modules/${MODULE_ID}/templates/${relative}`;
}

/** Read the point-buy budget setting, guarding against a GM entering a bad value (0, text, etc.). */
export function pointBuyBudget() {
  const raw = Number(game.settings.get(MODULE_ID, SETTINGS.pointBuyBudget));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULTS.pointBuyBudget;
}

/** Read the ability-roll formula setting; fall back to the default if it isn't valid dice syntax. */
export function abilityRollFormula() {
  const raw = String(game.settings.get(MODULE_ID, SETTINGS.rollFormula) ?? "").trim();
  // Roll.validate is dnd5e/Foundry's own dice-syntax checker, so we never store a formula that throws.
  return raw && Roll.validate(raw) ? raw : DEFAULTS.rollFormula;
}

/**
 * Console logger namespaced to the module, silent unless the player turns debug logging on.
 *
 * Most of the ~70 call sites sit in `catch` blocks: they are what a user enables when asked to
 * reproduce a bug, not something a working game should print. A hard failure the player must know
 * about is `console.error` and is deliberately not routed through here (see `main.mjs`'s system
 * check), because that one has to survive the setting being off.
 */
export function log(...args) {
  // Registered as the first statement of the `init` hook, so every ordinary caller is safe. A module
  // that throws while importing could still reach this earlier, and `game.settings.get` raises on an
  // unregistered key — silence is the right failure mode for a logger.
  try {
    if ( !game.settings.get(MODULE_ID, SETTINGS.debug) ) return;
  } catch {
    return;
  }
  console.log(`${MODULE_ID} |`, ...args);
}

/**
 * Resolve the ApplicationV2 options for a launch, based on the configured display mode, so the
 * creator and level-up windows feel identical. Fullscreen covers the viewport with no chrome;
 * windowed opens a themed, draggable, resizable frame at ~90% of the screen, centred.
 * @returns {object}
 */
export function launchWindowOptions() {
  const windowed = game.settings.get(MODULE_ID, SETTINGS.displayMode) === "windowed";
  // Carry the base class explicitly: ApplicationV2 may replace (rather than merge)
  // the static DEFAULT_OPTIONS.classes with the array passed here.
  const classes = ["sogrom-creator", windowed ? "sogrom-creator-windowed" : "sogrom-creator-fullscreen"];
  // With Ember active the window wears its skin (styles/ember-skin.css) so the level-up
  // reads as part of Ember's creator rather than a foreign UI dropped on top of it.
  if ( emberActive() ) classes.push("sogrom-ember");
  if ( !windowed ) return { classes };

  const w = Math.min(1800, Math.round(window.innerWidth * 0.9));
  const h = Math.min(1100, Math.round(window.innerHeight * 0.9));
  return {
    classes,
    window: { frame: true, positioned: true, resizable: true },
    position: {
      width: w,
      height: h,
      top: Math.max(4, Math.round((window.innerHeight - h) / 2)),
      left: Math.max(4, Math.round((window.innerWidth - w) / 2))
    }
  };
}
