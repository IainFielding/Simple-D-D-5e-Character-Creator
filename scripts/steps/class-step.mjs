import {
  abilitiesContext, abilitiesHandle, abilitiesComplete, abilitiesHint,
  ABILITY_ACTIONS, POINT_BUY_LIVE_ACTIONS, patchPointBuy
} from "./abilities-step.mjs";
import { spellInfoFor } from "./spells-step.mjs";
import { resolveChoices } from "../data/choice-resolver.mjs";
import { hasSourcePage } from "../data/journal-source.mjs";
import { hasRulesPage } from "../data/rules-source.mjs";
import { applyQuickBuild } from "../data/quick-build.mjs";
import { t, log, levelUpEnabled } from "../config.mjs";
import { pinContext } from "../app/compare.mjs";
import { matchesRules } from "../data/source-index.mjs";

/**
 * The Class step. Class selection and ability scores share one step: the chosen class's page and
 * the ability allocator stack down one work surface, with the class list available as a drawer
 * over it, so a player sets their scores against the class that frames them.
 *
 * The allocator used to sit in a 348px aside beside a 340px picker, which left the description
 * they were both meant to be read against about 400px on a 1400px window — see templates/steps/
 * class.hbs for the full reasoning.
 *
 * It is built by composition, not inheritance — it owns the class-list context and
 * routes ability clicks to the standalone ability panel (abilities-step.mjs). The
 * two halves stay independent; this module only stitches their context, handling,
 * and completion together.
 */
export const classStep = {
  id: "class",
  icon: "fa-solid fa-chess-rook",
  labelKey: "step.class.label",
  // One line under the heading saying what this step decides. The pick steps used to open on a
  // centred "select an option to see details" placeholder filling the widest surface in the
  // window; this says something useful in a fraction of the space, and never goes away.
  instructionKey: "step.class.instruction",
  template: "steps/class",

  isComplete(state) {
    return !!state.classUuid && abilitiesComplete(state);
  },

  /** Why Next is blocked: no class, or ability scores still to finish. */
  incompleteHint(state) {
    if ( !state.classUuid ) return t("step.class.hint");
    return abilitiesHint(state);
  },

  /**
   * The dossier line's value: the class name, and nothing else.
   *
   * It used to append the resolved score line — `Fighter · 15 / 14 / 13 / 12 / 10 / 8`,
   * thirty-six characters into a value column about twenty-three wide, with no tooltip
   * behind the ellipsis. So the one line the dossier was designed around was the one
   * line it could not show.
   *
   * Dropping the scores rather than widening the column, because the six plates sit a
   * hundred pixels above this line in the same dossier and already carry them. Read
   * once: the plates are where scores live, this line is where the class lives.
   */
  summary(state, source) {
    return source.card(state.classUuid)?.name ?? "";
  },

  async handle(action, el, { state, source, spells, equipment, app }) {
    if ( action === "quick-build" ) {
      if ( !state.classUuid ) return;
      // Filling replaces existing picks, so confirm first when the player has already made some.
      if ( hasMeaningfulPicks(state) ) {
        const ok = await foundry.applications.api.DialogV2.confirm({
          window: { title: t("quickBuild.confirmTitle"), icon: "fa-solid fa-bolt" },
          content: `<p>${t("quickBuild.confirmBody")}</p>`,
          modal: true,
          rejectClose: false
        });
        if ( !ok ) return false;
      }
      // The fill awaits several compendium reads; latch the button so a double-click can't
      // start a second fill over the first (same hardening as the Create button).
      el.disabled = true;
      el.classList.add("is-busy");
      try {
        const result = await applyQuickBuild({ state, source, spells, equipment });
        if ( !result.ok ) ui.notifications?.warn(t("quickBuild.partial"));
      } catch ( err ) {
        log("quick build failed", err);
        ui.notifications?.error(t("quickBuild.failed"));
        el.disabled = false;
        el.classList.remove("is-busy");
        return;                                   // re-render shows whatever state remains
      }
      // Lands on Review when every gate passed; otherwise on the first incomplete step.
      app.gotoStep("review");
      return false;                               // gotoStep rendered; skip the dispatch render
    }
    if ( ABILITY_ACTIONS.has(action) ) {
      await abilitiesHandle(action, el, state);
      // Point-buy steppers fire in rapid succession; a full stage re-render would rebuild
      // the drawer's class icons and flicker them on every press. Patch the panel and the
      // Next gate in place, refresh only the image-free parts, and skip the default re-render.
      if ( POINT_BUY_LIVE_ACTIONS.has(action) && state.abilityMethod === "point-buy" ) {
        const stage = el.closest(".creator-stage");
        patchPointBuy(stage, state);
        const next = stage?.querySelector('.creator-stage-foot [data-action="navNext"]');
        if ( next ) next.disabled = !(state.classUuid && abilitiesComplete(state));
        // Refresh only the two image-free parts: the dossier's score plates and completion tick,
        // and the progress meter. Re-rendering the stage would rebuild the drawer's class icons.
        app.render({ parts: ["topbar", "dossier"] });
        return false;
      }
      return;
    }
    if ( action === "target-level" ) {
      state.targetLevel = clampLevel(el.dataset.level);
      return;
    }
    if ( action === "target-level-custom" ) {
      state.targetLevel = clampLevel(el.value);
      return;
    }
    if ( action === "pick-class" ) {
      const uuid = el.dataset.uuid;
      // Re-clicking the active card clears it, so a player can back out of a choice.
      state.classUuid = state.classUuid === uuid ? null : uuid;
      // Spells, class advancement picks, and class equipment are all class-specific.
      state.resetClassDependent();
      // Changing to a class of a different edition invalidates origins the new class would never
      // have offered — the grids are scoped, but a pick made before the switch would survive it and
      // build the mixed-edition character the scoping exists to prevent. Only genuinely
      // incompatible picks are dropped, so switching *within* an edition costs the player nothing.
      dropOffEditionOrigins(state, source);
      // Origins pinned for comparison were pinned against the *previous* class's edition-scoped
      // grid, so after a switch some of them may no longer be on offer at all. Dropping them keeps
      // the comparison honest: it can only ever hold options the player could actually choose.
      app?.pins?.clear("species");
      app?.pins?.clear("background");
      // Refresh the cached choice requirements so the Choices step's completion gate
      // reflects the new class even before it is visited.
      state.choiceCache = await resolveChoices(state, source);
      // And the spell summary, so the Spells step's gate knows the new class's known counts.
      state.spellInfo = await spellInfoFor(spells, state.classUuid);
    }
  },

  async context({ state, source, app }) {
    const selected = state.classUuid;
    const detail = selected ? await source.detail(selected) : null;
    const groups = selected ? await source.advancementGroups(selected) : null;
    const cards = source.classes().map(c => ({ ...c, selected: c.uuid === selected }));
    return {
      // Opts the grid into side-by-side comparison: pin-decorated cards, plus the toolbar's
      // compare control. Inert without a shell, so the step still renders in tests.
      ...pinContext(app?.pins, "class", cards),
      count: cards.length,
      hasSelection: !!selected,
      // Which step action a drawer card fires, so parts/work-picker.hbs stays step-agnostic.
      pickAction: "pick-class",
      // Puts the Quick Build button in the shared detail header; only this step has one.
      quickBuild: true,
      detail,
      groups,
      // Offer "Full Details" only when the active content package actually ships a book page for
      // this class. Without the check the button would open our own description a second time.
      sourceUuid: (selected && await hasSourcePage(selected)) ? selected : null,
      // The class step is where the edition gets decided, so its own rules link uses whatever is
      // picked so far and otherwise falls through to the resolver's 2024 default.
      // Null unless the world actually has a book covering this step, so the control is hidden
      // rather than offered as a button that opens nothing.
      rulesTopic: (await hasRulesPage("class", source.rulesOf(selected))) ? "class" : null,
      rulesEdition: source.rulesOf(selected) ?? null,
      abilities: abilitiesContext(state),
      targetLevel: targetLevelContext(state)
    };
  }
};

/* -------------------------------------------- */
/*  Target level                                */
/* -------------------------------------------- */

/** The levels offered as one-click presets, alongside the custom entry. */
const LEVEL_PRESETS = [1, 3, 5];

/** Coerce any user-supplied level to a whole number within 1…the system's cap. */
function clampLevel(value) {
  const max = CONFIG.DND5E?.maxLevel ?? 20;
  const level = Math.floor(Number(value));
  if ( !Number.isFinite(level) ) return 1;
  return Math.min(Math.max(level, 1), max);
}

/**
 * View-model for the target-level picker: the preset chips plus a custom field that only shows a
 * value when the pick isn't one of the presets (so the field reads as "or something else" rather
 * than duplicating the active chip).
 * @param {import("../state/creator-state.mjs").CreatorState} state
 */
function targetLevelContext(state) {
  // Everything above level 1 is delivered by the level-up wizard, so the picker only exists where
  // that wizard does: a world that left the module on creation-only has no way to reach level 5
  // from here, and shouldn't be offered it.
  if ( !levelUpEnabled() ) return null;
  const value = clampLevel(state.targetLevel);
  const isPreset = LEVEL_PRESETS.includes(value);
  return {
    value,
    max: CONFIG.DND5E?.maxLevel ?? 20,
    presets: LEVEL_PRESETS.map(level => ({ level, active: level === value })),
    custom: !isPreset,
    customValue: isPreset ? "" : value,
    // The picker's "you'll finish in the level-up wizard" note only applies above level 1.
    aboveOne: value > 1
  };
}

/**
 * Whether the player has made picks beyond this step that Quick Build would overwrite —
 * origins, a name, spells, or any advancement choice. Class + ability tinkering alone
 * doesn't count: quick build re-derives those, and prompting there would nag the exact
 * player the button is for.
 */
function hasMeaningfulPicks(state) {
  return !!(
    state.backgroundUuid
    || state.speciesUuid
    || state.details.name?.trim()
    || state.selectedCantrips.length
    || state.selectedSpells.length
    || Object.values(state.advChoices).some(bucket => Object.keys(bucket).length)
  );
}

/**
 * Drop a chosen species or background the newly-chosen class's edition would never have offered.
 *
 * The grids are scoped to the class's edition, but the class is the *first* step: a player who goes
 * back and switches a 2024 class for a 2014 one would otherwise keep origins the 2014 grids never
 * show, which is exactly the mixed-edition character the scoping exists to prevent.
 *
 * Deliberately narrow — only a genuine mismatch is cleared, so switching class within an edition, or
 * to/from content that declares no edition, costs the player nothing. Their advancement picks for the
 * dropped origin go with it, since those were made against an item the character no longer has.
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {import("../data/source-index.mjs").SourceIndex} source
 */
function dropOffEditionOrigins(state, source) {
  const want = source.rulesOf(state.classUuid);
  if ( !want ) return;                     // no class, or one that declares no edition
  for ( const [field, key] of [["speciesUuid", "species"], ["backgroundUuid", "background"]] ) {
    const uuid = state[field];
    if ( !uuid || matchesRules(source.rulesOf(uuid), want) ) continue;
    log(`dropping ${key} ${uuid}: not ${want} content`);
    state[field] = null;
    state.resetSourceChoices(key);
  }
}
