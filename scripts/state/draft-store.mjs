import { MODULE_ID, log } from "../config.mjs";

/**
 * Saving and restoring an unfinished character build.
 *
 * Nothing the creator collects is written to the world until Create, which is what keeps a
 * cancelled build from littering the actor directory — but it also meant closing the window threw
 * the whole thing away. A draft closes that gap without giving up the in-memory model: what is
 * stored is the *player's answers* (uuids, numbers, typed text), never a document. Rebuilding a
 * {@link CreatorState} from those answers is exactly what the creator does on every render anyway.
 *
 * The draft lives on a flag on `game.user`, so it is the player's own and follows them between
 * sessions and machines. A user may always update their own flags, so this needs no permission the
 * creator's audience doesn't already have.
 *
 * For a junior dev: three things to know before you touch this file.
 *   1. {@link DRAFT_FIELDS} is an allowlist, not an exclusion list. A new field on CreatorState is
 *      *not* persisted until it is named here — which is the safe default, because most new fields
 *      turn out to be transient UI or a cache that is cheaper to rebuild than to store.
 *   2. The answers are stored as a JSON **string**, not as a nested object. `setFlag` deep-merges
 *      an object into whatever is already stored, so a key the player cleared (an advancement pick
 *      they undid, an item they took out of the cart) would survive the save meant to remove it.
 *      A string is replaced wholesale, so what is read back is exactly what was written.
 *   3. Saving is debounced ({@link scheduleDraftSave}), because every save is a server round-trip
 *      and the creator dispatches on every click.
 */

/** The `game.user` flag key the draft is stored under. */
const DRAFT_FLAG = "creatorDraft";

/**
 * The shape version of a stored draft. Bump it whenever a change to {@link DRAFT_FIELDS} would
 * make an older draft restore *wrongly* rather than merely incompletely — a renamed field, a
 * changed value shape. A draft carrying any other version is discarded on read rather than
 * half-applied, because a half-applied draft is a character the player never designed.
 */
const DRAFT_VERSION = 1;

/**
 * How long to wait after the last interaction before writing the draft, in milliseconds. Long
 * enough that a run of stepper presses or a typed name costs one save rather than twenty; short
 * enough that a browser closed or refreshed moments later still has the work.
 */
const SAVE_DELAY = 1500;

/**
 * How each saved field is merged back onto a fresh state.
 *  - `value`  — replaced outright (scalars).
 *  - `array`  — replaced outright; a saved list is the whole list.
 *  - `object` — shallow-merged over the state's default, so a draft written before a key existed
 *               restores everything it does carry and leaves the rest at its default. The nested
 *               buckets (`advChoices.class`, `equipment.background`, …) are each replaced whole,
 *               which is right: a bucket is emptied as a unit when its origin selection changes.
 * @type {Record<string, "value"|"array"|"object">}
 */
const DRAFT_FIELDS = {
  // Origin selections and the level being built towards.
  classUuid: "value",
  speciesUuid: "value",
  backgroundUuid: "value",
  targetLevel: "value",
  // Identity, biography and the images.
  details: "object",
  portrait: "value",
  tokenImg: "value",
  tokenRingImg: "value",
  tokenRingEnabled: "value",
  tokenLockRotation: "value",
  // Ability scores: the active method plus every method's working values, so a restored draft can
  // still be flipped between methods without losing what was set under the others.
  abilityMethod: "value",
  pointBuy: "object",
  assignment: "object",
  rolledPool: "array",
  manualScores: "object",
  originAbilities: "object",
  // Spells, advancement picks, equipment and the store cart.
  selectedCantrips: "array",
  selectedSpells: "array",
  advChoices: "object",
  featSpells: "object",
  equipment: "object",
  store: "object",
  // The two optional steps' visited flags, so a restored draft doesn't ask the player to walk back
  // through Equipment and the Store to re-earn ticks they already had.
  equipmentVisited: "value",
  storeVisited: "value",
  // Whether they asked for a sheet PDF once the build finishes.
  exportPdf: "value"
};

/* -------------------------------------------- */
/*  Reading and writing                         */
/* -------------------------------------------- */

/** Pending debounced save, so a later call can reschedule or cancel it. @type {number|null} */
let saveTimer = null;

/** The state the pending save will write, held so {@link flushDraftSave} can write it early. */
let pendingState = null;

/**
 * The persistable answers on a state, as a plain object safe to JSON-encode.
 * @param {import("./creator-state.mjs").CreatorState} state
 * @returns {object}
 */
export function draftSnapshot(state) {
  const out = {};
  for ( const field of Object.keys(DRAFT_FIELDS) ) {
    const value = state?.[field];
    if ( value === undefined ) continue;
    out[field] = value;
  }
  // Copied rather than handed over live: the state keeps mutating after this returns, and a
  // debounced save would otherwise write whatever it had become when the timer fired rather than
  // what was snapshotted.
  return JSON.parse(JSON.stringify(out));
}

/**
 * Write a draft now, replacing any the player already had.
 * @param {import("./creator-state.mjs").CreatorState} state
 * @returns {Promise<void>}
 */
export async function saveDraft(state) {
  cancelDraftSave();
  if ( !state ) return;
  try {
    await game.user?.setFlag(MODULE_ID, DRAFT_FLAG, {
      version: DRAFT_VERSION,
      savedAt: Date.now(),
      // Denormalised so the resume prompt can name the character without parsing the payload.
      name: state.details?.name?.trim() ?? "",
      json: JSON.stringify(draftSnapshot(state))
    });
    log("draft saved");
  } catch ( err ) {
    // A draft is a convenience; failing to store one must never interrupt a build in progress.
    log("draft save failed", err);
  }
}

/**
 * Queue a save for a short while from now, restarting the clock if one is already queued. Called
 * on every interaction, so keeping a draft current costs one write per pause rather than one per
 * click.
 * @param {import("./creator-state.mjs").CreatorState} state
 */
export function scheduleDraftSave(state) {
  pendingState = state;
  if ( saveTimer !== null ) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const target = pendingState;
    saveTimer = null;
    pendingState = null;
    saveDraft(target);
  }, SAVE_DELAY);
}

/** Write a queued save immediately, if there is one. Awaited before a close settles the draft. */
export async function flushDraftSave() {
  if ( saveTimer === null ) return;
  const target = pendingState;
  cancelDraftSave();
  await saveDraft(target);
}

/**
 * Drop a queued save without writing it. {@link clearDraft} calls this above all: without it, a
 * save queued moments before the player chose to discard would fire afterwards and put the draft
 * straight back.
 */
export function cancelDraftSave() {
  if ( saveTimer !== null ) clearTimeout(saveTimer);
  saveTimer = null;
  pendingState = null;
}

/**
 * The player's stored draft, or null when there isn't a usable one.
 *
 * A draft from a different shape version is not merely skipped, it is *forgotten*: leaving it in
 * place would offer the player nothing on every launch while an unusable payload sat on their
 * flags forever.
 * @returns {{savedAt: number, name: string, data: object}|null}
 */
export function readDraft() {
  let stored;
  try {
    stored = game.user?.getFlag(MODULE_ID, DRAFT_FLAG);
  } catch ( err ) {
    log("draft read failed", err);
    return null;
  }
  if ( !stored?.json ) return null;
  if ( stored.version !== DRAFT_VERSION ) {
    log("discarding a draft written to a different shape");
    clearDraft();
    return null;
  }
  let data;
  try {
    data = JSON.parse(stored.json);
  } catch ( err ) {
    log("draft could not be parsed", err);
    clearDraft();
    return null;
  }
  if ( !data || (typeof data !== "object") ) return null;
  return {
    savedAt: Number(stored.savedAt) || 0,
    name: typeof stored.name === "string" ? stored.name : "",
    data
  };
}

/** Whether the player currently has a draft worth offering. @returns {boolean} */
export function hasDraft() {
  return !!readDraft();
}

/**
 * Forget the player's draft — the build finished, or they chose to throw it away.
 * @returns {Promise<void>}
 */
export async function clearDraft() {
  cancelDraftSave();
  try {
    await game.user?.unsetFlag(MODULE_ID, DRAFT_FLAG);
    log("draft cleared");
  } catch ( err ) {
    log("draft clear failed", err);
  }
}

/* -------------------------------------------- */
/*  Restoring                                   */
/* -------------------------------------------- */

/** Whether a value is a plain object we may merge field by field (not an array, not null). */
function isPlainObject(value) {
  return !!value && (typeof value === "object") && !Array.isArray(value);
}

/**
 * Put a draft's answers back onto a fresh state, in place.
 *
 * Each field is checked against the shape the state already holds rather than trusted: a flag is
 * stored data a user could have hand-edited, and a string where the state wants an object would
 * otherwise surface as an unexplained crash inside a step's render. A field that doesn't fit is
 * skipped, leaving that part of the build at its default — the player loses one answer, not the
 * whole draft.
 * @param {import("./creator-state.mjs").CreatorState} state
 * @param {object} data   The `data` of a {@link readDraft} result.
 * @returns {import("./creator-state.mjs").CreatorState}  The same state, for chaining.
 */
export function applyDraft(state, data) {
  if ( !state || !isPlainObject(data) ) return state;
  for ( const [field, kind] of Object.entries(DRAFT_FIELDS) ) {
    if ( !(field in data) ) continue;
    const saved = data[field];
    if ( saved === undefined ) continue;
    if ( kind === "array" ) {
      if ( Array.isArray(saved) ) state[field] = saved;
    } else if ( kind === "object" ) {
      if ( !isPlainObject(saved) ) continue;
      if ( isPlainObject(state[field]) ) Object.assign(state[field], saved);
      else state[field] = saved;
    } else if ( !isPlainObject(saved) && !Array.isArray(saved) ) {
      state[field] = saved;
    }
  }
  return state;
}

/**
 * Drop origin selections a restored draft names that the world can no longer resolve, so a
 * disabled or updated content module costs the player that one pick rather than a build that
 * fails at Create with nothing to point at.
 *
 * Only the three origins are checked, and deliberately: they are the picks everything else hangs
 * off — clearing one cascades through {@link CreatorState#resetSourceChoices} to the advancement
 * choices, equipment and spells that were made *because* of it — and they are the only uuids the
 * warm source index can answer for without a compendium read apiece.
 *
 * Runs once the index is warm, so "not found" means genuinely absent rather than not yet loaded.
 * @param {import("./creator-state.mjs").CreatorState} state
 * @param {import("../data/source-index.mjs").SourceIndex} source
 * @returns {string[]}  The origin keys that were dropped, for the caller to report.
 */
export function pruneMissingOrigins(state, source) {
  const dropped = [];
  const origins = [
    { key: "class", field: "classUuid" },
    { key: "species", field: "speciesUuid" },
    { key: "background", field: "backgroundUuid" }
  ];
  for ( const { key, field } of origins ) {
    const uuid = state[field];
    if ( !uuid || source?.card(uuid) ) continue;
    state[field] = null;
    if ( key === "class" ) state.resetClassDependent();
    state.resetSourceChoices(key);
    dropped.push(key);
    log(`draft dropped a ${key} that no longer resolves`, uuid);
  }
  return dropped;
}
