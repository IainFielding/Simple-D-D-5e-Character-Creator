import {
  ABILITIES, abilityRollFormula, formatMod, log, manualAbilitiesEnabled, pointBuyBudget, t
} from "../config.mjs";

// D&D 5e offers three ways to set ability scores; this panel supports all three, plus one the
// rules don't:
//   point-buy       – spend a budget of points to raise scores from 8, each step costing more
//   standard-array  – assign the fixed set [15,14,13,12,10,8] across the six abilities
//   roll            – roll dice for six values, then assign them
//   manual          – type the six numbers in, for tables whose scores were settled elsewhere.
//                     Off unless the GM turns it on, since it answers to none of the economies
//                     the other three enforce.
// The point-buy, pool (array/roll) and manual paths are kept fairly separate below.

/** PHB point-buy price of each reachable score (8 is free; 14 and 15 cost extra). */
const POINT_BUY_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
const PB_MIN = 8;   // lowest score point-buy allows
const PB_MAX = 15;  // highest score point-buy allows

/**
 * The bounds a manually-typed score is held to. The floor is 1 because that is the lowest score
 * the system's own data model accepts; the ceiling follows `CONFIG.DND5E.maxAbilityScore` so a
 * world that has raised the system's cap raises this with it, rather than having the creator
 * enforce a stricter limit than the sheet the character lands on.
 *
 * These are a guard, not an economy. Manual entry exists precisely because the numbers were
 * decided somewhere this window cannot see, so anything inside the range is accepted as typed.
 */
const MANUAL_MIN = 1;
const manualMax = () => CONFIG.DND5E?.maxAbilityScore ?? 20;

/** The methods in tab order, and the i18n key suffix each one's label lives under. */
const METHODS = ["point-buy", "standard-array", "roll", "manual"];
const METHOD_LABELS = {
  "point-buy": "pointBuy", "standard-array": "standardArray", "roll": "roll", "manual": "manual"
};

/** Whether this world offers a method at all. Only manual entry is ever withheld. */
function methodOffered(id) {
  if ( !METHODS.includes(id) ) return false;
  return (id !== "manual") || manualAbilitiesEnabled();
}

/**
 * The method actually in force, which is the stored one unless the world has since stopped
 * offering it. A build begun (or a draft saved) while manual entry was on has to keep working
 * after the GM turns it off, and silently falling back to point-buy is the only outcome that
 * leaves the player with scores some rule in this world can account for.
 */
function effectiveMethod(state) {
  return methodOffered(state.abilityMethod) ? state.abilityMethod : "point-buy";
}

const abilityLabel = key => CONFIG.DND5E?.abilities?.[key]?.label ?? key.toUpperCase();
const abilityAbbr = key => CONFIG.DND5E?.abilities?.[key]?.abbreviation ?? key.slice(0, 3).toUpperCase();

/**
 * Ability score determination. This lives as a self-contained panel — context,
 * event handling, and completion — rather than a top-level step, so it can be
 * composed into the Class step (which renders abilities alongside the class grid)
 * without either side knowing about the other's layout.
 *
 * Supports the three standard methods; each keeps the others' working values, so
 * a player can flip between them without losing progress.
 */

/** True once the chosen method has produced a complete, valid set of scores. */
export function abilitiesComplete(state) {
  const method = effectiveMethod(state);
  if ( method === "point-buy" ) return pointsRemaining(state) === 0;
  // Manual entry is done when all six boxes hold a number in range. There is no budget to
  // balance, so "every box filled" is the whole of the requirement.
  if ( method === "manual" ) return ABILITIES.every(k => inManualRange(state.manualScores?.[k]));
  const pool = state.abilityPool() ?? [];
  if ( !pool.length ) return false;
  return ABILITIES.every(k => state.assignment[k] != null);
}

/** Why the ability panel isn't done yet, for the Next-button hint — or null when it is. */
export function abilitiesHint(state) {
  if ( abilitiesComplete(state) ) return null;
  const method = effectiveMethod(state);
  if ( method === "point-buy" ) return t("step.abilities.hintPoints", { count: pointsRemaining(state) });
  if ( method === "manual" ) return t("step.abilities.hintManual", { min: MANUAL_MIN, max: manualMax() });
  if ( !(state.abilityPool() ?? []).length ) return t("step.abilities.hintRoll");
  return t("step.abilities.hintAssign");
}

/* There was an `abilitiesSummary()` here — the compact "15 / 14 / …" line — with the class
   step as its only caller, for the tail of its dossier line. That line now carries the class
   name alone (see class-step.mjs summary()), because the dossier's six ability plates already
   show these numbers a hundred pixels above it. With the duplicate gone the helper had no
   callers left, so it went with it rather than staying as an export nothing reaches. */

/** Apply one ability-panel action to the state. Returns nothing; caller re-renders. */
export async function abilitiesHandle(action, el, state) {
  const ability = el?.dataset?.ability;
  switch ( action ) {
    case "ability-method":
      // Ignore a switch to a method the world doesn't offer. Only reachable from a stale render or
      // a restored draft's markup, but the guard is a line and the alternative is a set of scores
      // no rule in this world produced.
      if ( methodOffered(el.dataset.method) ) state.abilityMethod = el.dataset.method;
      break;
    case "ability-inc":
      if ( canIncrease(state, ability) ) state.pointBuy[ability] += 1;
      break;
    case "ability-dec":
      if ( state.pointBuy[ability] > PB_MIN ) state.pointBuy[ability] -= 1;
      break;
    case "ability-roll":
      state.rolledPool = await rollPool();
      state.assignment = blankAssignment();
      break;
    case "ability-assign":
      assignSlot(state, ability, el.value === "" ? null : Number(el.value));
      break;
    case "ability-drop": {
      // Dropped a pooled score onto an ability; the pool index rides on dropPayload.
      const payload = el.dataset.dropPayload;
      assignSlot(state, ability, payload == null || payload === "" ? null : Number(payload));
      break;
    }
    case "ability-unassign":
      // Dropped a value back onto the pool: clear whichever ability holds that index.
      clearSlot(state, el.dataset.dropPayload === "" ? null : Number(el.dataset.dropPayload));
      break;
    case "ability-set":
      // A typed score. An empty box (or anything unparseable) clears back to null rather than
      // snapping to a number the player never typed — they may still be mid-edit.
      if ( ability ) state.manualScores[ability] = clampManual(el.value);
      break;
    case "ability-reset": {
      // Reset clears whatever the *active* method is holding, so it can never wipe the working
      // values of a method the player isn't looking at.
      const method = effectiveMethod(state);
      if ( method === "point-buy" ) resetPointBuy(state);
      else if ( method === "manual" ) state.manualScores = blankManual();
      else state.assignment = blankAssignment();
      break;
    }
  }
}

/** Template context for the ability panel (nested under `abilities` by the Class step). */
export function abilitiesContext(state) {
  const method = effectiveMethod(state);
  // Write the fallback back before anything reads the scores. `resolvedScores()` keys off the
  // stored method, so leaving "manual" in place after the GM withdrew it would build a character
  // from typed numbers while the panel showed a point-buy spread — two answers to one question.
  state.abilityMethod = method;
  return {
    method,
    isPointBuy: method === "point-buy",
    isArray: method === "standard-array",
    isRoll: method === "roll",
    isManual: method === "manual",
    rollFormula: abilityRollFormula(),
    methods: METHODS.filter(id => methodOffered(id)).map(id => ({
      id, label: t(`step.abilities.${METHOD_LABELS[id]}`), active: method === id
    })),
    ...methodContext(method, state)
  };
}

/** The per-method half of the panel context. */
function methodContext(method, state) {
  if ( method === "point-buy" ) return pointBuyContext(state);
  if ( method === "manual" ) return manualContext(state);
  return poolContext(state);
}

/** Actions this panel owns, so the Class step can route only its own clicks here. */
export const ABILITY_ACTIONS = new Set([
  "ability-method", "ability-inc", "ability-dec", "ability-roll",
  "ability-assign", "ability-drop", "ability-unassign", "ability-set", "ability-reset"
]);

/**
 * Point-buy actions that only nudge values inside the existing panel layout, so the
 * panel can be patched in place rather than triggering a full stage re-render. The
 * caller must still confirm `state.abilityMethod === "point-buy"` (reset is shared
 * with the array/roll modes, where it rebuilds the pool and does need a re-render).
 */
export const POINT_BUY_LIVE_ACTIONS = new Set(["ability-inc", "ability-dec", "ability-reset"]);

/**
 * Live-patch the point-buy panel after a stepper press instead of re-rendering the
 * stage. A full re-render rebuilds the class pick-list `<img>`s that sit beside the
 * panel, which makes the class icons flicker on every +/- press; updating only the
 * handful of changed nodes in place keeps them perfectly still. `root` is the stage
 * element containing the panel.
 */
export function patchPointBuy(root, state) {
  if ( !root || state.abilityMethod !== "point-buy" ) return;
  const remaining = pointsRemaining(state);
  const points = root.querySelector(".creator-points-value");
  if ( points ) {
    points.textContent = remaining;
    points.classList.toggle("is-zero", remaining === 0);
  }
  // The budget meter is patched here too, for the same reason the numbers are: a stepper press
  // must move the bar it is spending from, and a full re-render to move one width would rebuild
  // the drawer's icons underneath.
  const budget = pointBuyBudget();
  const spent = pointsSpent(state);
  const spentNode = root.querySelector(".creator-points-spent");
  if ( spentNode ) spentNode.textContent = spent;
  const fill = root.querySelector(".creator-budget-fill");
  if ( fill ) fill.style.width = `${budget ? Math.round((spent / budget) * 100) : 0}%`;
  const track = root.querySelector(".creator-budget-track");
  if ( track ) track.setAttribute("aria-valuenow", String(spent));
  for ( const key of ABILITIES ) {
    const dec = root.querySelector(`[data-step-action="ability-dec"][data-ability="${key}"]`);
    const row = dec?.closest(".creator-ability-row");
    if ( !row ) continue;
    const value = state.pointBuy[key];
    row.querySelector(".creator-ability-score").textContent = value;
    row.querySelector(".creator-ability-mod").textContent = formatMod(value);
    dec.disabled = value <= PB_MIN;
    const inc = row.querySelector('[data-step-action="ability-inc"]');
    if ( inc ) inc.disabled = !canIncrease(state, key);
  }
}

/**
 * Live-patch the manual panel after a typed score, for the same reason {@link patchPointBuy}
 * exists — and one more. A full stage re-render rebuilds the six inputs, so tabbing from one box
 * to the next (which is what fires the change in the first place) would destroy the box the
 * keyboard was heading for and drop focus to the top of the window. Only the modifier beside the
 * box actually changes, so that is all this touches.
 * @param {HTMLElement} root   The stage element containing the panel.
 * @param {import("../state/creator-state.mjs").CreatorState} state
 */
export function patchManual(root, state) {
  if ( !root || (state.abilityMethod !== "manual") ) return;
  for ( const key of ABILITIES ) {
    const input = root.querySelector(`[data-step-change="ability-set"][data-ability="${key}"]`);
    const row = input?.closest(".creator-ability-row");
    if ( !row ) continue;
    const value = state.manualScores?.[key] ?? null;
    // Put the stored value back in the box: a pasted 40 was clamped on the way in, and the box
    // would otherwise keep showing what was typed rather than what the character will have.
    input.value = value ?? "";
    row.querySelector(".creator-ability-mod").textContent = value == null ? "" : formatMod(value);
    row.classList.toggle("is-assigned", value != null);
  }
}

/* -------------------------------------------- */
/*  Point-buy                                   */
/* -------------------------------------------- */

function pointsSpent(state) {
  return ABILITIES.reduce((sum, k) => sum + (POINT_BUY_COST[state.pointBuy[k]] ?? 0), 0);
}

function pointsRemaining(state) {
  return pointBuyBudget() - pointsSpent(state);
}

function canIncrease(state, ability) {
  const value = state.pointBuy[ability];
  if ( value >= PB_MAX ) return false;
  const step = (POINT_BUY_COST[value + 1] ?? Infinity) - (POINT_BUY_COST[value] ?? 0);
  return step <= pointsRemaining(state);
}

function resetPointBuy(state) {
  for ( const k of ABILITIES ) state.pointBuy[k] = PB_MIN;
}

function pointBuyContext(state) {
  const remaining = pointsRemaining(state);
  const rows = ABILITIES.map(key => {
    const value = state.pointBuy[key];
    return {
      key, label: abilityLabel(key), abbr: abilityAbbr(key),
      value, modifier: formatMod(value),
      canInc: canIncrease(state, key),
      canDec: value > PB_MIN
    };
  });
  const budget = pointBuyBudget();
  const spent = pointsSpent(state);
  // Width of the budget meter's fill. A budget of zero (a world that configured point-buy off)
  // would otherwise divide by zero and render a NaN width, which paints as a full bar.
  const percent = budget ? Math.round((spent / budget) * 100) : 0;
  return { rows, budget, spent, remaining, percent };
}

/* -------------------------------------------- */
/*  Manual entry                                */
/* -------------------------------------------- */

function blankManual() {
  return { str: null, dex: null, con: null, int: null, wis: null, cha: null };
}

/** Whether a stored manual score is a usable whole number inside the accepted range. */
function inManualRange(value) {
  return Number.isInteger(value) && (value >= MANUAL_MIN) && (value <= manualMax());
}

/**
 * A typed box's value as it should be stored: a whole number pulled into range, or null when the
 * box is empty or holds something that isn't a number.
 *
 * Clamping rather than rejecting is deliberate. The input carries `min`/`max`, so the browser's
 * own steppers already stop at the bounds; this covers the paths that don't go through them —
 * typing, pasting — and a value silently pulled to the cap is easier to understand than a box
 * that refuses the keystroke.
 */
function clampManual(raw) {
  const text = String(raw ?? "").trim();
  if ( !text ) return null;
  const value = Math.floor(Number(text));
  if ( !Number.isFinite(value) ) return null;
  return Math.min(Math.max(value, MANUAL_MIN), manualMax());
}

function manualContext(state) {
  const max = manualMax();
  const rows = ABILITIES.map(key => {
    const value = state.manualScores?.[key] ?? null;
    return {
      key, label: abilityLabel(key), abbr: abilityAbbr(key),
      // The empty string is what leaves the box blank; 0 would render as a score nobody typed.
      value: value ?? "",
      modifier: value == null ? "" : formatMod(value),
      assigned: value != null
    };
  });
  return { rows, min: MANUAL_MIN, max };
}

/* -------------------------------------------- */
/*  Standard array / roll                       */
/* -------------------------------------------- */

function blankAssignment() {
  return { str: null, dex: null, con: null, int: null, wis: null, cha: null };
}

/**
 * Assign a pool slot to an ability. Each pool value may be used once, so if the slot
 * was already held by another ability the two trade places: that ability inherits the
 * value this one was holding (or becomes unassigned if it held none).
 */
export function assignSlot(state, ability, index) {
  if ( !ability ) return;
  const previous = state.assignment[ability];
  if ( index != null ) {
    for ( const key of ABILITIES ) {
      if ( key !== ability && state.assignment[key] === index ) state.assignment[key] = previous;
    }
  }
  state.assignment[ability] = index;
}

/** Clear whichever ability currently holds this pool index (used when dragging a value back). */
function clearSlot(state, index) {
  if ( index == null ) return;
  for ( const key of ABILITIES ) {
    if ( state.assignment[key] === index ) state.assignment[key] = null;
  }
}

async function rollPool() {
  const formula = abilityRollFormula();
  const rolls = [];
  for ( let i = 0; i < 6; i++ ) rolls.push(await new Roll(formula).evaluate());

  // Capture the scores up front: the pool is highest-first (like the standard array)
  // and must survive even if the cosmetic animation below fails or is absent.
  const totals = rolls.map(r => r.total).sort((a, b) => b - a);

  // Animate via Dice So Nice when installed — a single synchronised throw of all six
  // dice. Purely cosmetic, so any failure is logged and ignored, never propagated.
  await showRolledDice(rolls);
  return totals;
}

async function showRolledDice(rolls) {
  if ( !game.dice3d ) return;
  try {
    await Promise.all(rolls.map(roll => game.dice3d.showForRoll(roll, game.user, true)));
  } catch ( err ) {
    log("dice animation failed", err);
  }
}

function poolContext(state) {
  const pool = state.abilityPool() ?? [];
  const hasPool = pool.length > 0;
  const used = new Set(ABILITIES.map(k => state.assignment[k]).filter(v => v != null));

  const rows = ABILITIES.map(key => {
    const chosen = state.assignment[key];
    const score = (chosen != null && pool[chosen] != null) ? pool[chosen] : null;
    // Every pool slot is offered in every row: picking one already held by another
    // ability swaps the two (see assignSlot), so used values stay selectable.
    const options = pool.map((value, index) => ({
      index, value,
      selected: chosen === index
    }));
    return {
      key, label: abilityLabel(key), abbr: abilityAbbr(key),
      score, modifier: score == null ? "" : formatMod(score),
      assigned: score != null,
      options
    };
  });

  // The pool shown as a strip up top — each value flagged once it's been assigned. The
  // index travels with each chip so it can be dragged onto an ability row (and back).
  const poolChips = pool.map((value, index) => ({ value, index, used: used.has(index) }));

  return { rows, hasPool, pool: poolChips };
}
