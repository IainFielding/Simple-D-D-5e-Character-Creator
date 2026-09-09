import {
  MODULE_ID, SETTINGS, DEFAULTS, HOOKS, tpl, t, log,
  levelUpEnabled, creationEnabled, emberActive, fireHook
} from "./config.mjs";
import { STEPS } from "./steps/registry.mjs";
import { warmSources } from "./data/source-cache.mjs";
import { registerLevelUp, triggerLevelUp, canLevelUp } from "./levelup/intercept.mjs";
import { registerXpNotice } from "./levelup/xp-notice.mjs";
import { StoreConfigApp } from "./app/store-config.mjs";
import { HouseRulesApp } from "./app/house-rules.mjs";
import { LevelUpOptionsApp } from "./app/levelup-options.mjs";
import { watchForeignWindows } from "./app/takeover.mjs";
import { registerApi, launchCreator } from "./api.mjs";

/*
 * This is the module's entry point — module.json points Foundry here via "esmodules".
 * The file wires the module into Foundry's startup lifecycle using Hooks. A Hook is
 * Foundry's event system: `Hooks.once(event, fn)` runs `fn` a single time when that
 * event fires, `Hooks.on(event, fn)` runs it every time. The lifecycle order we use is:
 *   init   -> register settings and templates (before the game data is loaded)
 *   ready  -> everything is loaded; safe to touch actors, install our level-up takeover
 * We also listen for directory events to inject our "launch" button and the sidebar's
 * right-click "Level Up" entry.
 */

/* -------------------------------------------- */
/*  Init: settings + templates                  */
/* -------------------------------------------- */

// `init` fires early, before world data loads — the right place to register settings and
// pre-load templates so they're ready by the time anything renders.
Hooks.once("init", () => {
  registerSettings();
  // Install the public API here rather than at `ready` so another module's `setup`/`ready`
  // handler can rely on it existing. Nothing in it touches world data at construction time.
  registerApi();
  // Let item/actor/journal sheets opened from inside the fullscreen takeover — the Review screen's
  // content links, mostly — actually be visible, by stepping the takeover below Foundry's window
  // layer while one is open. See app/takeover.mjs for why we lower ourselves rather than raise them.
  watchForeignWindows();
  // Step partials are pulled in by the stage via a dynamic Handlebars partial, so they
  // must be registered up front (the topbar/dossier/rail/stage themselves are loaded as PARTS).
  // `parts/` holds the fragments the step templates include by path — the work surface's
  // picker drawer, its detail page and its ability allocator are shared by the three origin
  // picks, and the ability-increase panel by two of them — which likewise have to be
  // registered rather than loaded as PARTS. A partial missing from this list fails at render
  // with "The partial … could not be found", so add to it whenever a step includes a new one.
  foundry.applications.handlebars.loadTemplates([
    ...STEPS.map(s => tpl(`${s.template}.hbs`)),
    tpl("parts/work-picker.hbs"),
    tpl("parts/work-detail.hbs"),
    tpl("parts/abilities-panel.hbs"),
    tpl("parts/origin-abilities.hbs"),
    tpl("parts/source-details.hbs"),
    // The spell toolbar — search plus the filter dropdowns — is one partial shared by the creation
    // and level-up spell steps, so the two screens can't drift apart.
    tpl("parts/spell-filters.hbs"),
    tpl("parts/spell-row.hbs"),
    tpl("parts/spell-list-notice.hbs"),
    // Spells a feat hands out, shown on the level-up spell page. Registered here with the other
    // spell partials because a partial is resolved from the registry at render time, not fetched.
    tpl("parts/feat-spell-grants.hbs"),
    // The comparison grid is included by stage.hbs alongside the book-page overlay, so it is a
    // partial for the same reason that one is: the stage is loaded as a PART, its includes are not.
    tpl("parts/compare.hbs"),
    tpl("parts/rules-link.hbs"),
    // The sheet-PDF switch, included by both review screens so the two can't offer the export on
    // different terms.
    tpl("parts/pdf-export.hbs"),
    // The chat cards themselves are rendered on demand rather than loaded as PARTS, but the
    // partial they include still has to be registered up front — a partial is resolved at render
    // time from the registry, not fetched.
    tpl("chat/value.hbs"),
    tpl("chat/levelup-ready.hbs")
  ]);

  // The `data-tooltip` payload that triggers a dnd5e *rich* item tooltip. The system's
  // global Tooltips5e observer watches the live tooltip element for a `.loading[data-uuid]`
  // section and swaps it for the item's richTooltip() on hover. A bare " " can never become
  // one — it just shows an empty (black) box — so item links must emit this instead.
  // Handlebars escapes the returned string into the attribute; the browser decodes it back to
  // real HTML, so element.dataset.tooltip yields exactly the markup dnd5e looks for.
  Handlebars.registerHelper("ccItemTooltip", uuid => {
    if ( !uuid ) return "";
    return `<section class="loading" data-uuid="${uuid}"><i class="fa-solid fa-spinner fa-spin-pulse"></i></section>`;
  });
});

// Declare every world setting so it shows up in Foundry's "Configure Settings" menu and can
// be read via game.settings.get(). `scope: "world"` means one shared value for the whole game
// (GM-controlled); `config: true` means it appears in the settings UI. Names/hints are pulled
// from lang/en.json through t() so they can be translated.
function registerSettings() {
  // With Ember active the module cedes character creation to Ember's own creator, so the
  // only mode on offer is Level-Up only (and config.mjs's moduleMode() pins the effective
  // mode there even if an older value is still stored). Without Ember, all three modes show.
  //
  // That cession takes a handful of settings with it. Everything reached only through our own
  // creator — which never opens in an Ember world — is registered with `config: !ember`, so it
  // is hidden from Configure Settings there rather than listed as a control that cannot change
  // anything. A dead control is worse than an absent one: it invites a GM to set it and then
  // conclude the module is broken when nothing happens. Each one below says why it is dead.
  //
  // They stay *registered* either way, because `game.settings.get` on an unregistered setting
  // throws, and several are read on paths that still run in an Ember world.
  const ember = emberActive();
  game.settings.register(MODULE_ID, SETTINGS.mode, {
    name: t("settings.mode.name"),
    hint: t(ember ? "settings.mode.hintEmber" : "settings.mode.hint"),
    scope: "world", config: true, type: String,
    default: ember ? "levelup" : DEFAULTS.mode,
    choices: ember
      ? { "levelup": t("settings.mode.levelupOnly") }
      : {
          "creation": t("settings.mode.creation"),
          "creation-levelup": t("settings.mode.creationLevelup"),
          "levelup": t("settings.mode.levelupOnly")
        }
  });
  game.settings.register(MODULE_ID, SETTINGS.displayMode, {
    name: t("settings.displayMode.name"),
    hint: t("settings.displayMode.hint"),
    scope: "world", config: true, type: String, default: DEFAULTS.displayMode,
    choices: {
      fullscreen: t("settings.displayMode.fullscreen"),
      windowed: t("settings.displayMode.windowed")
    }
  });
  // Dead under Ember: the button is gated on creationEnabled(), false there. Still read on every
  // Actors-sidebar render, which is why it must stay registered rather than be skipped.
  game.settings.register(MODULE_ID, SETTINGS.launchButton, {
    name: t("settings.launchButton.name"),
    hint: t("settings.launchButton.hint"),
    scope: "world", config: !ember, type: Boolean, default: true
  });
  // Every level-up setting — these three entry points, the hit-point pair below, and the two
  // announcements — is edited through the Level-Up Options menu rather than the flat settings list,
  // hence `config: false` throughout. They keep their original keys, so every existing accessor and
  // stored world value carries over untouched; only where they are *edited* changed.
  // (Level-up entry points are live in an Ember world too — Ember owns creation, not levelling.)
  game.settings.register(MODULE_ID, SETTINGS.levelUpButton, {
    scope: "world", config: false, type: Boolean, default: DEFAULTS.levelUpButton
  });
  game.settings.register(MODULE_ID, SETTINGS.headerMenu, {
    scope: "world", config: false, type: Boolean, default: DEFAULTS.headerMenu
  });
  game.settings.register(MODULE_ID, SETTINGS.contextMenu, {
    scope: "world", config: false, type: Boolean, default: true
  });
  // Both dead under Ember: they are read only by the creator's Abilities step, and Ember decides
  // ability scores in its own builder before the hand-off ever reaches us. The hand-off's rail has
  // no Abilities step to spend a budget or roll a formula on (see levelup/registry.mjs).
  // The four below, plus bannedAlignments, are the "what may a player build" rules, and they are
  // edited through the House Rules menu rather than the flat settings list — hence `config: false`
  // on all four. They keep their original setting keys, so every existing accessor and stored world
  // value carries over untouched; only where they are *edited* changed.
  game.settings.register(MODULE_ID, SETTINGS.pointBuyBudget, {
    scope: "world", config: false, type: Number, default: DEFAULTS.pointBuyBudget
  });
  game.settings.register(MODULE_ID, SETTINGS.rollFormula, {
    scope: "world", config: false, type: String, default: DEFAULTS.rollFormula
  });
  game.settings.register(MODULE_ID, SETTINGS.multiclass, {
    scope: "world", config: false, type: String, default: DEFAULTS.multiclass
  });
  game.settings.register(MODULE_ID, SETTINGS.manualAbilities, {
    scope: "world", config: false, type: Boolean, default: DEFAULTS.manualAbilities
  });
  game.settings.register(MODULE_ID, SETTINGS.bannedAlignments, {
    scope: "world", config: false, type: Array, default: DEFAULTS.bannedAlignments
  });
  game.settings.registerMenu(MODULE_ID, "houseRulesMenu", {
    name: t("settings.houseRulesMenu.name"),
    label: t("settings.houseRulesMenu.label"),
    hint: ember ? t("settings.houseRulesMenu.hintEmber") : t("settings.houseRulesMenu.hint"),
    icon: "fa-solid fa-gavel",
    type: HouseRulesApp,
    restricted: true
  });
  game.settings.register(MODULE_ID, SETTINGS.levelUpHpMode, {
    scope: "world", config: false, type: String, default: DEFAULTS.levelUpHpMode
  });
  game.settings.register(MODULE_ID, SETTINGS.levelUpHpRollToChat, {
    scope: "world", config: false, type: Boolean, default: DEFAULTS.levelUpHpRollToChat
  });
  // The two summary cards. Both share the same three modes, so they read the same to a GM
  // scanning the settings list; see SUMMARY_MODES in config.mjs.
  //
  // The creation card is dead under Ember, and the level-up card is not. LevelUpState.announce
  // defaults to "none" for the hand-off — Ember finishes the character after our Apply, so a card
  // posted by us would describe one that is still a step from done — and postCreationSummary is
  // only ever called behind `announce === "creation"`. The level-up card is unaffected: an Ember
  // world levels characters up exactly like any other.
  game.settings.register(MODULE_ID, SETTINGS.creationSummary, {
    name: t("settings.creationSummary.name"),
    hint: t("settings.creationSummary.hint"),
    scope: "world", config: !ember, type: String, default: DEFAULTS.creationSummary,
    choices: {
      "public": t("settings.creationSummary.public"),
      "gm": t("settings.creationSummary.gm"),
      "off": t("settings.creationSummary.off")
    }
  });
  game.settings.register(MODULE_ID, SETTINGS.levelUpSummary, {
    scope: "world", config: false, type: String, default: DEFAULTS.levelUpSummary
  });
  // Not a summary of something that happened, but a prompt about something that can — it shares the
  // three modes because the question ("who hears about this?") is the same one. `public` here means
  // "the GM and the character's owner", never the whole table; see levelUpReadyMode.
  game.settings.register(MODULE_ID, SETTINGS.levelUpReadyNotice, {
    scope: "world", config: false, type: String, default: DEFAULTS.levelUpReadyNotice
  });
  game.settings.registerMenu(MODULE_ID, "levelUpOptionsMenu", {
    name: t("settings.levelUpOptionsMenu.name"),
    label: t("settings.levelUpOptionsMenu.label"),
    hint: t("settings.levelUpOptionsMenu.hint"),
    icon: "fa-solid fa-trophy-star",
    type: LevelUpOptionsApp,
    restricted: true
  });
  // The starting-gold store: the enabled flag and the GM's stock configuration are both
  // hidden objects, edited only through the config form; a single menu button opens it.
  // The enabled flag lives as its own setting (not inside storeConfig) because it doubles
  // as the store's master toggle, saved alongside the config when the form is submitted.
  game.settings.register(MODULE_ID, SETTINGS.storeEnabled, {
    scope: "world", config: false, type: Boolean, default: DEFAULTS.storeEnabled
  });
  game.settings.register(MODULE_ID, SETTINGS.storeConfig, {
    scope: "world", config: false, type: Object, default: DEFAULTS.storeConfig
  });
  game.settings.registerMenu(MODULE_ID, "storeConfigMenu", {
    name: t("settings.storeConfigMenu.name"),
    label: t("settings.storeConfigMenu.label"),
    hint: t("settings.storeConfigMenu.hint"),
    icon: "fa-solid fa-shop",
    type: StoreConfigApp,
    restricted: true
  });
  // The one `client` setting: what this module prints to *your* console is your business, not a
  // world-wide decision the GM makes for everybody. Off by default — a working game should say
  // nothing — and turned on when someone is asked to reproduce a bug.
  game.settings.register(MODULE_ID, SETTINGS.debug, {
    name: t("settings.debugLogging.name"),
    hint: t("settings.debugLogging.hint"),
    scope: "client", config: true, type: Boolean, default: DEFAULTS.debug
  });
}

/* -------------------------------------------- */
/*  Ready: system guard                         */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  if ( game.system.id !== "dnd5e" ) {
    console.error(`${MODULE_ID} | requires the dnd5e game system; disabling.`);
    return;
  }
  log("ready");

  // Install the level-up takeover hooks (primary: wrap the native AdvancementManager;
  // fallback: a sheet button when the world has disabled native advancements). Both paths
  // self-gate on the `mode` setting, so this is safe to register unconditionally.
  registerLevelUp();

  // Watch for characters crossing their XP threshold. Registered unconditionally for the same
  // reason: it self-gates on the `mode` and notice settings, and on being the one active GM.
  registerXpNotice();

  // Pre-warm the shared compendium index in the background, so the builder opens instantly
  // instead of showing its loading screen on first use. Gated to the audiences that will
  // actually open a window — users who can create actors (the launch button), and, when the
  // level-up takeover is on, players who own a character (the level-up flow) — to avoid taxing
  // clients that will never open either. Deferred to idle so it never competes with the rest of
  // world startup. A window opened before this finishes simply awaits the same in-flight work.
  const levelUpAudience = levelUpEnabled()
    && game.actors?.some(a => (a.type === "character") && a.isOwner);
  if ( (creationEnabled() && game.user?.can("ACTOR_CREATE")) || levelUpAudience ) {
    const warm = () => warmSources().catch(() => {});
    if ( typeof requestIdleCallback === "function" ) requestIdleCallback(warm, { timeout: 3000 });
    else window.setTimeout(warm, 1000);
  }

  // Announce the module last, once the takeover is installed and the system guard has passed — so
  // a listener that reacts to this can assume everything below is live. Fired only in a dnd5e
  // world: in any other system the module has disabled itself and there is nothing to integrate
  // with. See docs/API.md.
  const module = game.modules.get(MODULE_ID);
  fireHook(HOOKS.ready, { api: module?.api ?? null, version: module?.version ?? "" });
});

/* -------------------------------------------- */
/*  Launch entry points                         */
/* -------------------------------------------- */

// The creator's entry point lives in api.mjs — it is the module's public front door, and the
// sidebar button below is simply its first caller. See {@link module:api}.

// Every time the Actors sidebar tab renders, add our "launch" button to its header — but only
// if the system is dnd5e, the setting is on, and this user is allowed to create actors.
Hooks.on("renderActorDirectory", (_app, html) => {
  if ( game.system?.id !== "dnd5e" ) return;
  if ( !creationEnabled() ) return;
  if ( !game.settings.get(MODULE_ID, SETTINGS.launchButton) ) return;
  if ( !game.user?.can("ACTOR_CREATE") ) return;
  injectLaunchButton(rootElement(html));
});

// Add a right-click "Level Up" entry to character actors in the sidebar. Foundry passes
// us the menu's option array and we push our own entry onto it; `condition` decides per-actor
// whether the entry shows, `callback` runs when it's clicked. It rides the same trigger path
// as the sheet's Level Up button, so both entry points behave identically.
Hooks.on("getActorContextOptions", (_directory, options) => {
  if ( game.system?.id !== "dnd5e" ) return;
  if ( !game.settings.get(MODULE_ID, SETTINGS.contextMenu) ) return;
  options.push({
    name: t("levelup.button"),
    icon: "<i class=\"fa-solid fa-trophy-star\"></i>",
    condition: li => {
      // Re-check the gate per-render: the mode setting may have changed since this entry
      // was registered (a reload normally follows, but stay safe).
      if ( !levelUpEnabled() ) return false;
      const actor = game.actors?.get(li.dataset?.entryId ?? li.dataset?.documentId);
      return canLevelUp(actor);
    },
    callback: li => {
      const actor = game.actors?.get(li.dataset?.entryId ?? li.dataset?.documentId);
      if ( actor ) triggerLevelUp(actor);
    }
  });
});

/* -------------------------------------------- */
/*  DOM helpers                                 */
/* -------------------------------------------- */

// Foundry's render hooks sometimes hand us a raw HTMLElement (ApplicationV2) and sometimes a
// jQuery-like object (ApplicationV1). This normalises either into a plain DOM element.
function rootElement(html) {
  if ( html instanceof HTMLElement ) return html;
  return html?.[0] instanceof HTMLElement ? html[0] : null;
}

// Create the launch button and drop it into the directory header. Guards against adding it twice
// (the hook can fire repeatedly) and falls back through a few known header containers because the
// exact markup differs between Foundry/dnd5e versions.
function injectLaunchButton(root) {
  if ( !root || root.querySelector(".sogrom-launch") ) return;
  const container = root.querySelector(".header-actions")
    ?? root.querySelector(".directory-header .action-buttons")
    ?? root.querySelector(".directory-header");
  if ( !container ) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sogrom-launch";
  button.innerHTML = t("menu.launch");
  button.addEventListener("click", ev => { ev.preventDefault(); launchCreator(); });
  container.appendChild(button);
}
