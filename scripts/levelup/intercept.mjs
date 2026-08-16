import { MODULE_ID, SETTINGS, tpl, t, log, levelUpEnabled, launchWindowOptions, multiclassMode } from "../config.mjs";
import { LevelUpDriver } from "./manager-driver.mjs";
import { LevelUpState } from "./levelup-state.mjs";
import { LevelUpShell } from "./levelup-shell.mjs";
import { multiclassBlockers, formatBlockers } from "./multiclass.mjs";
import { isEmberCreationManager, foldOriginScreens } from "./ember-creation.mjs";

/**
 * Wires up the level-up takeover (§4). Two trigger paths:
 *
 *  - **Primary** — `dnd5e.preAdvancementManagerRender` fires before the native manager draws.
 *    When the world leaves native advancements enabled (the default), every level-up funnels
 *    through here; we claim the ones we can drive and suppress the native UI by returning false.
 *  - **Sheet button** — a "Level Up" button in the character sheet's header, the flow's front
 *    door (togglable via the `showLevelUpButton` setting). With native advancements enabled it
 *    routes through the system's own AdvancementManager — so the primary hook claims it exactly
 *    as if the sheet's level selector was used; with them disabled world-wide (no manager is
 *    ever built) it constructs one by hand and drives it directly.
 *
 * Both paths self-gate on the `mode` setting and stand down entirely when Hero Mancer is active.
 * Call once, at `ready`.
 *
 * For a junior dev: "intercept" = we hook the dnd5e level-up so our own UI runs instead of the
 * system's default wizard. The clean way in is the `preAdvancementManagerRender` hook: it fires
 * just before the native wizard paints, and if our handler returns `false` the native UI is
 * cancelled — leaving us to open our shell in its place. We only take over level-ups we know we
 * can fully handle (see LevelUpDriver.canDrive); anything else we let the system handle normally.
 */
export function registerLevelUp() {
  // The level-up step partials are pulled in by the stage's dynamic Handlebars partial, so they
  // must be registered up front just like the creation steps.
  foundry.applications.handlebars.loadTemplates([
    tpl("levelup/class.hbs"),
    tpl("levelup/level.hbs"),
    tpl("levelup/hp.hbs"),
    tpl("levelup/choices.hbs"),
    tpl("levelup/trait.hbs"),
    tpl("levelup/asi.hbs"),
    tpl("levelup/subclass.hbs"),
    tpl("levelup/grant.hbs"),
    tpl("levelup/optional-grant.hbs"),
    tpl("levelup/review.hbs"),
    tpl("levelup/spells.hbs")
  ]);

  Hooks.on("dnd5e.preAdvancementManagerRender", onPreAdvancementManagerRender);
  Hooks.on("renderActorSheet", onRenderActorSheet);
  Hooks.on("renderActorSheetV2", onRenderActorSheet);
}

/* -------------------------------------------- */
/*  Primary path — wrap the native manager      */
/* -------------------------------------------- */

/**
 * @param {AdvancementManager} manager
 * @returns {boolean|void}  `false` suppresses the native render once we have claimed the manager.
 */
function onPreAdvancementManagerRender(manager) {
  if ( !levelUpEnabled() ) return;
  // The hook fires on every (re-)render; once we have claimed a manager, never re-enter.
  if ( manager._sogromLevelUp ) return;

  // Ember's builder renders this manager to ask the level-1 questions it doesn't own itself
  // (see {@link module:levelup/ember-creation}). Claim it as a creation hand-off: the class it
  // levels is staged on the clone, exactly like a multiclass, but the claim doesn't depend on the
  // multiclass setting — Ember's flow has no other way to finish.
  if ( isEmberCreationManager(manager) ) {
    if ( !LevelUpDriver.canDrive(manager, { allowNewClass: true }) ) {
      log("Ember hand-off carries choices we can't drive; leaving it to Ember's own flow");
      return;
    }
    manager._sogromLevelUp = true;
    launchLevelUp(manager, { emberCreation: true });
    return false;
  }

  if ( !shouldTakeOver(manager) ) return;

  manager._sogromLevelUp = true;
  // The hook is synchronous and reads our return value, so kick the (async) takeover off
  // without awaiting it and suppress the native UI straight away.
  launchLevelUp(manager);
  return false;
}

/**
 * Whether this manager is a level-up we can fully own: the user owns the actor, and the driver's
 * conservative gate accepts every step — including a new class (multiclass) when the world
 * setting opts in. Anything else (level-downs, choice edits, or levels carrying choices we
 * don't yet re-skin) is left to the native flow.
 * @param {AdvancementManager} manager
 * @returns {boolean}
 */
function shouldTakeOver(manager) {
  if ( !manager?.actor?.isOwner ) return false;
  const mode = multiclassMode();
  if ( !LevelUpDriver.canDrive(manager, { allowNewClass: mode !== "off" }) ) return false;

  // A new-class claim under the "prereq" mode must meet the written multiclass prerequisites.
  // The wizard's own picker never offers an ineligible class, but a class item dragged onto
  // the sheet arrives here unchecked — warn and stand down, leaving the native flow to run.
  const classItem = manager.steps.find(s => s.class)?.class?.item;
  if ( (mode === "prereq") && classItem && !manager.actor.items.get(classItem.id) ) {
    const blockers = multiclassBlockers(manager.actor, classItem);
    if ( blockers.length ) {
      ui.notifications?.warn(t("levelup.multiclass.blocked", { reasons: formatBlockers(blockers) }));
      return false;
    }
  }
  return true;
}

/**
 * Drive a claimed manager: prepare its clone (apply automatic advancements, surface the
 * hit-point decisions), then open our shell. The real actor is untouched until the player
 * applies, so any failure here leaves them exactly where they were.
 * @param {AdvancementManager} manager
 * @param {object} [options]
 * @param {boolean} [options.emberCreation=false]  This manager is Ember's creation hand-off: the
 *   origin decisions fold onto the level-1 screen and the wizard gains its equipment step.
 * @param {"levelup"|"creation"|"none"} [options.announce]  Which chat card this session posts when
 *   it applies; omit for the flow's default (see {@link LevelUpState#announce}).
 */
async function launchLevelUp(manager, { emberCreation = false, announce = null } = {}) {
  try {
    const driver = new LevelUpDriver(manager);
    await driver.prepare();
    if ( emberCreation ) foldOriginScreens(driver);
    const state = new LevelUpState(manager.actor, driver, { emberCreation, announce });
    new LevelUpShell(state, launchWindowOptions()).render(true);
  } catch ( err ) {
    log("level-up takeover failed; the native advancement flow was suppressed", err);
    ui.notifications?.error(t("levelup.notify.takeoverFailed"));
  }
}

/* -------------------------------------------- */
/*  Sheet button                                */
/* -------------------------------------------- */

/**
 * Inject the "Level Up" button into the character sheet — the flow's front door, so a player
 * never has to know about the class-level selector buried in the sheet. It sits in the header's
 * rest-button row as a gold icon button matching short/long rest (tooltip on hover) — recreating
 * that row when the system left it out (a player without rest permission), so only a sheet with no
 * such structure at all (a legacy sheet) falls back to a labelled title-bar button. Tidy 5e Sheets
 * lay their header out differently, so they get the same treatment against their own markup (see
 * {@link tidyActionRow}). Hidden when the module mode leaves levelling to the system, when the
 * world setting turns the button off, and when there is nothing to level (no class yet, or
 * already at the level cap).
 * @param {Application} app
 * @param {HTMLElement|jQuery} html
 */
function onRenderActorSheet(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if ( !root ) return;
  const actor = app?.actor;
  const show = levelUpEnabled()
    && game.settings.get(MODULE_ID, SETTINGS.levelUpButton) && canLevelUp(actor);

  // Tidy's sheets are Svelte-mounted once and then updated in place, so the header we injected
  // into survives every later render — including the one right after the level that used it up.
  // Clear a stale button rather than leaving a dead trophy behind (a re-rendered dnd5e sheet
  // brings fresh HTML, so this is a no-op there).
  const existing = root.querySelector(".sogrom-levelup-btn");
  if ( !show ) { existing?.remove(); return; }
  if ( existing ) return;

  const button = document.createElement("button");
  button.type = "button";
  button.addEventListener("click", ev => {
    ev.preventDefault();
    triggerLevelUp(actor);
  });

  const tidyRow = tidyActionRow(root);
  if ( tidyRow ) {
    // Match Tidy's own short/long rest buttons: an icon-only gold button whose empty data-tooltip
    // makes the tooltip system fall back to the aria-label.
    button.className = "sogrom-levelup-btn button button-icon-only button-gold";
    button.dataset.tooltip = "";
    button.setAttribute("aria-label", t("levelup.button"));
    button.innerHTML = "<i class=\"fa-solid fa-trophy-star\" inert></i>";
    tidyRow.append(button);
    return;
  }

  // Prefer the system's rest-button row. It only exists when dnd5e sets `showRests`
  // (`game.user.isGM || (actor.isOwner && allowRests)`), so a plain player who owns the
  // character but lacks the "allow rests" world setting has no row — synthesize one in the
  // same spot so they get the same gold trophy, not the labelled fallback.
  const existingRow = root.querySelector(".sheet-header-buttons");
  const row = existingRow ?? buildHeaderButtonRow(root);
  if ( row ) {
    // Match the rest buttons exactly: a .gold-button icon whose empty data-tooltip makes the
    // tooltip system fall back to the aria-label, just like the system's own header buttons.
    button.className = "sogrom-levelup-btn gold-button";
    button.dataset.tooltip = "";
    button.setAttribute("aria-label", t("levelup.button"));
    button.innerHTML = "<i class=\"fa-solid fa-trophy-star\" inert></i>";
    row.append(button);
    // The populated system row is absolutely positioned with no spare room, so this class shifts
    // it left one icon-width (see creator.css, which also handles the Action Tracker module's own
    // shift). A row we synthesized holds only our button, so it fits without shifting.
    if ( existingRow ) row.classList.add("sogrom-has-levelup");
  } else {
    const header = root.querySelector(".window-header");
    if ( !header ) return;
    button.className = "sogrom-levelup-btn sogrom-levelup-btn--window";
    button.innerHTML = `<i class="fa-solid fa-trophy-star"></i> ${t("levelup.button")}`;
    header.prepend(button);
  }
}

/**
 * Recreate the dnd5e v2 character sheet's rest-button row when the system omitted it (a player
 * without rest permission). It lives as the first child of the "XP & Buttons" wrapper — the last
 * div in the header's `.right` column — where its `.sheet-header-buttons` styling positions it.
 * @param {HTMLElement} root
 * @returns {HTMLElement|null} the empty row, or null on a sheet without that structure
 */
function buildHeaderButtonRow(root) {
  const wrapper = root.querySelector(".sheet-header .right > div:last-child");
  if ( !wrapper ) return null;
  const row = document.createElement("div");
  row.className = "sheet-header-buttons";
  wrapper.prepend(row);
  return row;
}

/**
 * The Tidy 5e Sheets header action row — the strip beside the character's name holding its
 * short/long rest buttons — or null on any other sheet.
 *
 * Tidy's Quadrone sheets extend `ActorSheetV2` and mount their Svelte content synchronously, so
 * the standard `renderActorSheetV2` hook already fires with this markup in place; only the layout
 * differs from the system sheet's. The container div is always in the template, but Tidy adds its
 * layout classes with the rest buttons, so a player without rest permission gets an unclassed
 * (and undisplayed) shell — style it ourselves so our button lands in the same spot regardless.
 * @param {HTMLElement} root
 * @returns {HTMLElement|null}
 */
function tidyActionRow(root) {
  const row = root.querySelector("[data-tidy-sheet-part=\"sheet-header-actions-container\"]");
  if ( !row ) return null;
  if ( !row.classList.contains("sheet-header-actions") ) row.classList.add("sheet-header-actions", "flexrow");
  return row;
}

/**
 * Whether an actor is currently eligible for the level-up flow: a character the user owns,
 * with at least one class to level and room left below the system's level cap. Shared by the
 * sheet button and the sidebar context menu so both entry points show under the same terms.
 * @param {Actor5e} actor
 * @returns {boolean}
 */
export function canLevelUp(actor) {
  if ( actor?.type !== "character" || !actor.isOwner ) return false;
  if ( !actor.items.some(i => i.type === "class") ) return false;       // nothing to level yet
  return (actor.system?.details?.level ?? 0) < (CONFIG.DND5E?.maxLevel ?? 20);
}

/**
 * Level one class up from a trigger (the sheet button or the sidebar context menu).
 *
 * When the character has more than one levellable option — several classes, or a new class on
 * offer under the world's multiclass setting — the wizard itself opens on its Class step and the
 * pick happens there, fully in-brand (see {@link module:levelup/steps/lvl-class-step}); the
 * driver is built after the pick, so the shell opens without one.
 *
 * A single-class character with no multiclass option skips the step: the click follows the same
 * path as the sheet's own level selector (see dnd5e's `BaseActorSheet##changeLevel`) — build the
 * level-change manager and render it when it has steps, which fires the primary hook, claiming a
 * drivable level-up for our wizard and leaving an unsupported one to the native UI — or apply
 * the bare level directly when there is nothing to decide. Advancements disabled world-wide is
 * the exception: no native flow exists at all, so the manager is driven by hand
 * ({@link driveManager}).
 * @param {Actor5e} actor
 */
export async function triggerLevelUp(actor) {
  const classes = actor.items.filter(i => i.type === "class");
  const canMulticlass = multiclassMode() !== "off"
    && (actor.system?.details?.level ?? 0) < (CONFIG.DND5E?.maxLevel ?? 20);

  if ( classes.length > 1 || canMulticlass ) {
    const state = new LevelUpState(actor, null, { chooseClass: true });
    new LevelUpShell(state, launchWindowOptions()).render(true);
    return;
  }

  const classItem = classes[0];
  const AdvancementManager = dnd5e.applications.advancement.AdvancementManager;
  const manager = AdvancementManager.forLevelChange(actor, classItem.id, 1);
  if ( game.settings.get("dnd5e", "disableAdvancements") ) return driveManager(manager);
  if ( manager.steps.length ) return manager.render({ force: true });
  return classItem.update({ "system.levels": (classItem.system?.levels ?? 0) + 1 });
}

/* -------------------------------------------- */
/*  Higher-level creation hand-off              */
/* -------------------------------------------- */

/**
 * Open the level-up wizard on a freshly-created character to carry it from level 1 up to the
 * level the player asked for on the creator's Class step.
 *
 * The creator always builds a level-1 character (see {@link module:build/actor-assembler}); this is
 * what turns that into a level-5 one. It is a *single* level-up of `target - 1` levels, not one per
 * level: the driver already walks a multi-level jump — collecting a subclass's later-level features
 * ({@link LevelUpDriver#resolveSubclass}), giving each gained level its own screen
 * ({@link LevelUpState#gainedLevels}), and asking for the cumulative spell delta once — and it
 * commits to the real actor exactly once, so the whole jump stays discardable until Apply.
 *
 * Failure here is deliberately soft: the character already exists and is a valid level-1 one, so a
 * class we can't drive leaves the player with a warning and the sheet's Level Up button rather than
 * a half-built actor.
 * Because this session is what actually finishes the character, it inherits the *creation* chat
 * card rather than a level-up one — the player made one character, and the table should hear about
 * it once, at the level they asked for.
 * @param {Actor5e} actor   The just-created character, at level 1.
 * @param {number} target   The character level to reach (> 1; clamped to the system's cap).
 * @returns {Promise<boolean>}  Whether the wizard opened. When false the caller still owns the
 *   creation card, since no session exists to post it.
 */
export async function launchLevelUpTo(actor, target) {
  const classItem = actor.items.find(i => i.type === "class");
  if ( !classItem ) { log("no class to level after creation"); return false; }

  // Measure the jump against the *class* item, since that is what `forLevelChange` raises. On a
  // freshly-created single-class character this equals the character level, but reading it from
  // the class keeps the delta correct by construction rather than by coincidence.
  const max = CONFIG.DND5E?.maxLevel ?? 20;
  const levels = Math.min(target, max) - (classItem.system?.levels ?? 1);
  if ( levels < 1 ) return false;

  try {
    const AdvancementManager = dnd5e.applications.advancement.AdvancementManager;
    const manager = AdvancementManager.forLevelChange(actor, classItem.id, levels);
    // Driven directly and never rendered; flag it so the takeover hook can't re-claim it if some
    // other module forces a render (same guard as the Class step's hand-built manager).
    manager._sogromLevelUp = true;
    if ( !LevelUpDriver.canDrive(manager) ) {
      ui.notifications?.warn(t("levelup.notify.choicesUnsupported"));
      return false;
    }
    await launchLevelUp(manager, { announce: "creation" });
    return true;
  } catch ( err ) {
    log("post-creation level-up failed", err);
    ui.notifications?.error(t("levelup.notify.takeoverFailed"));
    return false;
  }
}

/**
 * Drive a hand-built manager directly — the path for worlds that disabled native advancements,
 * where rendering would never fire the primary hook (no native flow exists at all).
 * @param {AdvancementManager} manager
 */
function driveManager(manager) {
  if ( !shouldTakeOver(manager) ) {
    ui.notifications?.warn(t("levelup.notify.choicesUnsupported"));
    return;
  }
  manager._sogromLevelUp = true;
  launchLevelUp(manager);
}

/* -------------------------------------------- */
/*  Window options                              */
/* -------------------------------------------- */
