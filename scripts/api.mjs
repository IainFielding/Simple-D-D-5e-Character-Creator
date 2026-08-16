import {
  MODULE_ID, HOOKS, t, launchWindowOptions, fireCancellableHook,
  moduleMode, creationEnabled, levelUpEnabled, multiclassMode, storeConfig, log
} from "./config.mjs";
import { CreatorShell } from "./app/creator-shell.mjs";
import { CreatorState } from "./state/creator-state.mjs";
import { LevelUpShell } from "./levelup/levelup-shell.mjs";
import { LevelUpState } from "./levelup/levelup-state.mjs";
import { LevelUpDriver } from "./levelup/manager-driver.mjs";
import { triggerLevelUp, canLevelUp } from "./levelup/intercept.mjs";

/**
 * The module's public API — everything another module is invited to call.
 *
 * Foundry's convention is to hang this off the module entry, so a consumer reaches it as:
 *
 *   const api = game.modules.get("sogrom-dnd5e-character-creator")?.api;
 *
 * Deliberately *not* also published as a global. A global would be a second name for the same
 * object that we would then have to keep alive forever, and `game.modules.get(...)` is the
 * documented way to find a module's surface.
 *
 * Nothing here is new behaviour: every entry forwards to a function that already existed and is
 * already the path the module's own UI takes. That is the point — an integrator gets the same
 * gates (mode setting, permissions, the cancellable hooks) that a click gets, rather than
 * reaching past them into internals.
 *
 * The companion to this file is the {@link HOOKS} registry in config.mjs; between them they are
 * the whole supported surface, and docs/API.md documents both.
 *
 * For a junior dev: think of this as the module's front door for *other code*. When you add
 * something here you are promising not to break it in the next release — so add sparingly, and
 * put anything experimental under `internal` where that promise explicitly does not apply.
 */

/**
 * Open the creator on a fresh draft (or an existing character to resume). A brand-new character
 * is *not* written to the world here — the actor is created only when the player clicks Create
 * (see {@link CreatorShell}), so a cancelled build never litters the directory.
 *
 * This lives in the API file rather than in main.mjs because it *is* the public entry point:
 * the sidebar button, the API and any consumer all come through here, so they cannot drift into
 * applying different gates. (It was module-private in main.mjs before the API existed; moving it
 * also avoids main ↔ api importing each other.)
 * @param {Actor} [actor]  Existing actor to resume; null starts a fresh, unsaved draft.
 * @returns {Promise<CreatorShell|null>}  The opened window, or null if the open was refused.
 */
export async function launchCreator(actor) {
  // Level-up-only mode (always the case under Ember) has no creator to open.
  if ( !creationEnabled() ) return null;
  // Give the permission feedback up front rather than after the player has filled everything in.
  if ( !actor && !game.user?.can("ACTOR_CREATE") ) {
    ui.notifications?.warn(t("notify.noPermission"));
    return null;
  }
  const options = launchWindowOptions();
  // Last gate before the window exists, so a listener can refuse a build outright (a table that
  // vets characters, a module that wants its own creator for certain users).
  if ( !fireCancellableHook(HOOKS.preOpenCreator, { actor: actor ?? null, options }) ) return null;
  const app = new CreatorShell(actor ?? null, options);
  app.render(true);
  return app;
}

/**
 * Whether this actor was built by our creator.
 *
 * Reads the flag the assembler writes once a build completes (see
 * {@link module:build/actor-assembler}). Useful to a consumer that wants to treat
 * creator-built characters differently — an audit log, a "needs GM review" queue — without
 * having to have been listening at the moment they were made.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function isCreatorCharacter(actor) {
  return !!actor?.getFlag?.(MODULE_ID, "created");
}

/**
 * Build the API object and attach it to the module entry.
 *
 * Called from the `init` hook — early enough that another module's `setup` or `ready` handler
 * can rely on it, and safe there because nothing in the object reads world data until it is
 * actually called.
 */
export function registerApi() {
  const module = game.modules.get(MODULE_ID);
  if ( !module ) {
    // Only reachable if the module id and module.json disagree, which would break far more than
    // this — but the API is the one place that failure would otherwise be silent.
    console.error(`${MODULE_ID} | could not find own module entry; API not installed.`);
    return;
  }

  module.api = {
    /** The module's version, as declared in module.json. */
    get version() {
      return module.version ?? "";
    },

    /** Every hook name this module emits — subscribe via these rather than hard-coded strings. */
    HOOKS,

    /* ---------- Entry points ---------- */

    /**
     * Open the character creator. Honours the `mode` setting, the actor-creation permission and
     * the cancellable `preOpenCreator` hook, exactly as the sidebar button does.
     * @param {Actor} [actor]  An existing character to resume; omit for a fresh draft.
     * @returns {Promise<CreatorShell|null>}  Null when the open was refused.
     */
    launchCreator,

    /**
     * Open the level-up wizard for an actor, the same way the sheet button and the sidebar
     * context entry do.
     * @param {Actor} actor
     * @returns {Promise<void>}
     */
    triggerLevelUp,

    /**
     * Whether this actor could be levelled by the wizard right now — owned by the current user,
     * a character, and not already at the system's maximum level. The same gate the context-menu
     * entry uses to decide whether to show itself.
     * @param {Actor} actor
     * @returns {boolean}
     */
    canLevelUp,

    /** Whether this actor was built by the creator. */
    isCreatorCharacter,

    /* ---------- Read-only configuration ---------- */

    /**
     * The module's effective configuration. These are the guarded readers the module itself uses,
     * so a consumer sees the same values the wizard does — including Ember pinning the mode to
     * `"levelup"` regardless of what is stored.
     *
     * Read-only by design: a module should not be silently rewriting the GM's settings, and
     * `game.settings.set` remains available to anything that genuinely needs to.
     */
    settings: Object.freeze({
      mode: moduleMode,
      creationEnabled,
      levelUpEnabled,
      multiclassMode,
      storeConfig
    }),

    /* ---------- Unstable ---------- */

    /**
     * The module's internal classes.
     *
     * **No stability guarantee.** These are the module's implementation and they change between
     * releases without notice or a version bump; nothing here is covered by the promise that
     * applies to the rest of this object. They are exposed because the project's own end-to-end
     * harness drives them, and because refusing to expose them just pushes people into importing
     * the files by raw URL — which is worse for everyone, since then we cannot even see who is
     * depending on what.
     *
     * If you find yourself needing something here to do something reasonable, that is a good
     * argument for promoting it to a supported entry point — please open an issue.
     */
    internal: Object.freeze({
      CreatorShell, CreatorState, LevelUpShell, LevelUpState, LevelUpDriver
    })
  };

  log("public API installed");
}
