import { t } from "../config.mjs";
import { resolveChoices, choicesComplete } from "../data/choice-resolver.mjs";
import { resolveFeatSpells } from "./feat-spells-step.mjs";

/**
 * Flatten a resolved choice set into the ordered list of individual decisions the checklist
 * renders — one entry per requirement, tagged with its origin source so each row can show a
 * chip. `advId` is unique per advancement, so `source:selKey` is a stable, globally unique key.
 */
function flattenDecisions(resolved) {
  const out = [];
  for ( const s of resolved?.sources ?? [] ) {
    for ( const r of s.requirements ) {
      // Spell-type choices (Magic Initiate) are decided on the dedicated feat-spells step, not here.
      if ( r.spellStep ) continue;
      out.push({ key: `${r.source}:${r.selKey}`, complete: r.complete, req: r, sourceName: s.name, sourceImg: s.img });
    }
  }
  return out;
}

/**
 * How many of the checklist's decisions are made, against how many there are. Spell-type choices
 * are excluded on both counts — they are decided on the feat-spells step, not here — and the rail
 * summary and the blocked-Next hint both read this, so neither can drift from what is rendered.
 * @param {object|null} resolved  The cached resolution (`state.choiceCache`).
 * @returns {{done: number, total: number}}
 */
function decisionCounts(resolved) {
  let total = 0, done = 0;
  for ( const s of resolved?.sources ?? [] ) for ( const r of s.requirements ) {
    if ( r.spellStep ) continue;
    total++;
    if ( r.complete ) done++;
  }
  return { done, total };
}

/**
 * The Choices step: every player decision a chosen origin defers to level ≤ 1 —
 * skill/tool/language/weapon proficiencies, Expertise, size, "choose a feature"
 * (ItemChoice), spellcasting-ability picks — laid out as one guided checklist of accordion
 * rows, each tagged with the origin that grants it. The next unfinished row auto-expands.
 *
 * The advancement engine lives in {@link module:data/choice-resolver}; this step just
 * renders its requirements and records picks into `state.advChoices`. Completion gates
 * the build, so the cached resolution is kept fresh on every pick. Starting equipment is a
 * separate step ({@link module:steps/equipment-step}); nothing here touches it.
 */
export const choicesStep = {
  id: "choices",
  icon: "fa-solid fa-list-check",
  labelKey: "step.choices.label",
  template: "steps/choices",

  // Reads the cache the resolver refreshes on every relevant change (sync gate). Only the
  // advancement choices gate the build; the equipment selection is always informational.
  // Until a class is picked the cache is null — treat that as not-yet-complete so the rail
  // doesn't show a tick before any choice has been made.
  isComplete(state) {
    return state.choiceCache ? choicesComplete(state.choiceCache) : false;
  },

  /** Why Next is blocked: how many decisions are still open. */
  incompleteHint(state) {
    if ( !state.choiceCache?.hasAny ) return null;
    const { done, total } = decisionCounts(state.choiceCache);
    const remain = total - done;
    return remain > 0 ? t("step.choices.hint", { count: remain }) : null;
  },

  /** Rail summary: "3/4 made" once there's anything to decide. */
  summary(state) {
    if ( !state.choiceCache?.hasAny ) return "";
    const { done, total } = decisionCounts(state.choiceCache);
    return total ? t("step.choices.progress", { done, total }) : "";
  },

  async handle(action, el, { state, source }) {
    // Expand/collapse a checklist row. Clicking the open row collapses everything (""),
    // otherwise that row becomes the sole open one. Purely UI; the dispatcher re-renders.
    if ( action === "toggle-decision" ) {
      const k = el.dataset.decision;
      state.openDecision = state.openDecision === k ? "" : k;
      return;
    }

    if ( action !== "pick-choice" ) return;
    const { choiceSource, selKey, key } = el.dataset;
    const bucket = state.advChoices[choiceSource];
    if ( !bucket || !selKey || key == null ) return;

    const max = Number(el.dataset.count) || 1;
    const cur = bucket[selKey] ? [...bucket[selKey]] : [];
    const idx = cur.indexOf(key);
    if ( idx >= 0 ) {
      cur.splice(idx, 1);                 // toggle off
    } else if ( max === 1 ) {
      cur.length = 0;                     // single-select: replace
      cur.push(key);
    } else {
      if ( cur.length >= max ) cur.shift(); // at cap: drop the oldest pick
      cur.push(key);
    }
    bucket[selKey] = cur;
    state.choiceCache = await resolveChoices(state, source);

    // Auto-advance: once the decision the player was working on is satisfied, open the next
    // unfinished one so the checklist keeps moving them forward. Leaves the row as-is when
    // it's still incomplete (e.g. mid "choose 2") or when nothing remains.
    const flat = flattenDecisions(state.choiceCache);
    if ( flat.find(d => d.key === `${choiceSource}:${selKey}`)?.complete ) {
      const next = flat.find(d => !d.complete);
      if ( next ) state.openDecision = next.key;
    }
  },

  async context({ state, source }) {
    // Every path that can change the requirements re-resolves into `state.choiceCache`: the
    // origin/class/background picks, Quick Build, and this step's own `handle()` below. So the
    // render reuses that instead of resolving a second time for the same state (the resolver walks
    // each origin's whole advancement tree, which is the most expensive read in the creator). The
    // fallback covers the first render, before anything has been picked.
    const resolved = state.choiceCache ?? await resolveChoices(state, source);
    state.choiceCache = resolved;
    // Keep the feat-spells gate fresh: a feat granted here (e.g. a background's Magic Initiate)
    // must light up the following step's rail entry before the player navigates onto it.
    state.featSpellCache = await resolveFeatSpells(state, source);

    // Flatten every decision into one checklist, each carrying its requirement data plus an
    // origin chip and a status label (a "1/2" progress, a "Choose one" prompt, or a tick).
    const decisions = flattenDecisions(resolved).map(d => ({
      key: d.key,
      sourceName: d.sourceName,
      sourceImg: d.sourceImg,
      complete: d.complete,
      statusLabel: d.complete
        ? null
        : (d.req.showProgress ? `${d.req.chosenCount}/${d.req.count}` : d.req.countLabel),
      ...d.req
    }));

    const total = decisions.length;
    const done = decisions.filter(d => d.complete).length;
    const pct = total ? Math.round((done / total) * 100) : 0;

    // Resolve which row is expanded, surviving re-renders. `""` means the player collapsed
    // everything; an unset or stale/finished key falls back to the first unfinished decision
    // (or the first row when all decisions are done).
    const keys = decisions.map(d => d.key);
    const firstOpen = decisions.find(d => !d.complete)?.key ?? decisions[0]?.key ?? null;
    if ( state.openDecision !== "" && !keys.includes(state.openDecision) ) state.openDecision = firstOpen;
    for ( const d of decisions ) d.open = d.key === state.openDecision;

    return {
      // Derived from the *rendered* decisions, so a source whose only requirement is a spell
      // choice (handled on the feat-spells step) doesn't render an empty checklist here.
      hasChoices: total > 0,
      decisions,
      done,
      total,
      pct,
      allDone: total > 0 && done === total,
      isEmpty: total === 0
    };
  }
};
