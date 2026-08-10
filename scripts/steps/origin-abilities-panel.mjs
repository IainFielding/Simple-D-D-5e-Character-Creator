import { ABILITIES, t } from "../config.mjs";

/**
 * The ability-increase panel shared by the Species and Background steps.
 *
 * This is not a step — it is a *panel*, composed into a step the same way
 * {@link module:steps/abilities-step} is composed into the Class step: the host step forwards
 * `isComplete` / `incompleteHint` / `summary` / `handle` / `context` to the functions here and
 * renders `templates/parts/origin-abilities.hbs` beside its own grid.
 *
 * Which origin carries the increase is an edition question, which is exactly why this is shared:
 *   - 2024: the *background* grants 3 points, cap 2, nothing fixed — a pure allocation.
 *   - 2014: the *species* grants a fixed increase (Hill Dwarf's +2 CON / +1 WIS) with nothing to
 *     decide, or — the Half-Elf — a fixed +2 CHA *plus* 2 free points at cap 1.
 * An origin that grants no increase at all resolves to a null config and the host step renders no
 * panel, so a 2014 background and a 2024 species simply have no aside.
 *
 * Every function takes the origin key first, so one implementation serves both steps.
 */

/** Actions this panel owns; a host step forwards these to {@link asiHandle}. */
export const ASI_ACTIONS = new Set(["origin-ability-inc", "origin-ability-dec", "origin-ability-reset"]);

const abilityLabel = key => CONFIG.DND5E?.abilities?.[key]?.label ?? key.toUpperCase();

const zeroed = () => ({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 });

/* -------------------------------------------- */
/*  Derived values                              */
/* -------------------------------------------- */

/** The abilities an increase can raise: everything not locked out, plus any score with a fixed
 *  bump. Empty for an origin that grants no increase. Used for the Background grid's filter. */
export function increasedAbilities(asi) {
  if ( !asi ) return [];
  return ABILITIES.filter(k => !asi.locked.includes(k) || Number(asi.fixed?.[k] ?? 0) > 0);
}

/** Points the player has yet to spend out of the increase's budget. */
function pointsRemaining(state, source, asi) {
  const allocated = state.originAbilities[source] ?? {};
  const spent = ABILITIES.reduce((sum, k) => sum + (allocated[k] ?? 0), 0);
  return Math.max(0, asi.points - spent);
}

/**
 * Whether one more point may go into an ability.
 *
 * The cap counts the advancement's *fixed* bump alongside the player's allocation, matching
 * dnd5e's own flow (`assignment < cap`, where `value.assignments` already holds the fixed part).
 * That is what stops a Half-Elf — fixed +2 CHA against a cap of 1 — being offered a third point in
 * Charisma the system would refuse to apply. For a 2024 background, whose `fixed` is all zeroes,
 * this is the same test as before.
 */
function canIncrease(state, source, asi, ability) {
  if ( !ability || !asi.canAllocate || asi.locked.includes(ability) ) return false;
  const assigned = Number(asi.fixed?.[ability] ?? 0) + (state.originAbilities[source]?.[ability] ?? 0);
  if ( assigned >= asi.cap ) return false;
  return pointsRemaining(state, source, asi) > 0;
}

/**
 * Points the player can still actually place. Normally the same as {@link pointsRemaining}, but a
 * budget with nowhere left to go — every ability locked out, or every open one already at the cap
 * through its fixed bump — would otherwise leave Next disabled with no way to satisfy it. Only
 * malformed content reaches that state, and it must not strand the player in the wizard.
 */
function spendableRemaining(state, source, asi) {
  const remaining = pointsRemaining(state, source, asi);
  if ( !remaining ) return 0;
  return ABILITIES.some(k => canIncrease(state, source, asi, k)) ? remaining : 0;
}

/* -------------------------------------------- */
/*  Step hooks                                  */
/* -------------------------------------------- */

/**
 * Whether the increase (if any) is fully allocated. An unresolved config (`undefined`) or one that
 * grants nothing (`null`) is complete on selection alone, as is a purely fixed increase.
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {"species"|"background"} source
 */
export function asiComplete(state, source) {
  const asi = state.originAsi[source];
  if ( !asi ) return true;
  return spendableRemaining(state, source, asi) === 0;
}

/** Why Next is blocked: increase points still to spend, or null when there is nothing owing. */
export function asiHint(state, source) {
  const asi = state.originAsi[source];
  if ( !asi ) return null;
  const count = spendableRemaining(state, source, asi);
  return count > 0 ? t(`step.${source}.hintPoints`, { count }) : null;
}

/** "+2 STR · +1 DEX" line for the rail, drawn from fixed + allocated increases. */
export function asiSummary(state, source) {
  const asi = state.originAsi[source];
  if ( !asi ) return "";
  const parts = [];
  for ( const key of ABILITIES ) {
    const total = Number(asi.fixed?.[key] ?? 0) + (state.originAbilities[source]?.[key] ?? 0);
    if ( total > 0 ) parts.push(`+${total} ${key.toUpperCase()}`);
  }
  return parts.join(" · ");
}

/**
 * Apply one of {@link ASI_ACTIONS}. The host step routes here before its own actions.
 * @param {string} action
 * @param {HTMLElement} el
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {"species"|"background"} source
 */
export function asiHandle(action, el, state, source) {
  const asi = state.originAsi[source];
  if ( !asi ) return;
  const ability = el?.dataset?.ability;
  switch ( action ) {
    case "origin-ability-inc":
      if ( canIncrease(state, source, asi, ability) ) state.originAbilities[source][ability] += 1;
      break;
    case "origin-ability-dec":
      if ( (state.originAbilities[source][ability] ?? 0) > 0 ) state.originAbilities[source][ability] -= 1;
      break;
    case "origin-ability-reset":
      state.originAbilities[source] = zeroed();
      break;
  }
}

/**
 * Template context for the panel, or null when there is nothing to show — no origin picked, or one
 * that grants no increase. The host step passes the result through as `abilities`; the template
 * renders the aside only when it is present, so the layout drops to two columns.
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {"species"|"background"} source
 * @returns {object|null}
 */
export function asiContext(state, source) {
  const asi = state.originAsi[source];
  if ( !asi ) return null;

  const base = state.resolvedScores();
  const allocated = state.originAbilities[source] ?? {};
  const remaining = pointsRemaining(state, source, asi);

  const rows = ABILITIES.map(key => {
    // A purely fixed increase locks every row: the scores display, padlocked, with their bumps —
    // so the player sees what the species gave them at the moment they pick it.
    const locked = !asi.canAllocate || asi.locked.includes(key);
    const fixed = Number(asi.fixed?.[key] ?? 0);
    const bonus = fixed + (allocated[key] ?? 0);
    const total = (base[key] ?? 8) + bonus;
    return {
      key,
      label: abilityLabel(key),
      total,
      bonus,
      // The increase itself (+1/+2), not the ability modifier — the stepper's `total` already
      // shows the value the score is raised to.
      bonusLabel: bonus > 0 ? `+${bonus}` : "",
      locked,
      canInc: canIncrease(state, source, asi, key),
      canDec: !locked && (allocated[key] ?? 0) > 0
    };
  });

  return {
    source,
    canAllocate: asi.canAllocate,
    points: asi.points,
    cap: asi.cap,
    remaining,
    allSpent: remaining === 0,
    // The heading is shared with the level-up ASI aside; only the lines that *name* the origin
    // ("Set by this species") vary by source.
    title: t("step.originAbilities.label"),
    hint: asi.canAllocate
      ? t("step.originAbilities.hint", { points: asi.points, cap: asi.cap })
      : t(`step.originAbilities.fixed.${source}`),
    lockedTip: t(`step.originAbilities.locked.${source}`),
    rows
  };
}
