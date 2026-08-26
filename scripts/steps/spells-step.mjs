import { t } from "../config.mjs";
import { pinContext } from "../app/compare.mjs";
import { spellFilterOptions, spellListNotice } from "../data/spell-source.mjs";
import { originGrantedSpellCards } from "./feat-spells-step.mjs";

/**
 * The Spells step: for a spellcasting class, choose the cantrips and level-1 spells
 * known at level 1. The left column lists the class's spells for the active tab; the
 * right column shows the focused spell with a select/deselect control.
 *
 * Completion gates the build: a spellcaster must choose every cantrip and level-1 spell
 * it knows before the step counts as done. A non-caster has nothing to pick, so the step
 * never blocks — and the rail greys it out via {@link spellsStep.applicable}. The known
 * counts come from {@link spellInfoFor}, cached on `state.spellInfo` so this stays sync.
 *
 * Domain terms for a junior: "cantrips" are level-0 spells; "level-1 spells" are the first real
 * spells. Each class knows a fixed number of each at level 1 (its maxCantrips / maxSpells). The
 * two are picked on separate tabs but tracked in two separate arrays on the state.
 */
export const spellsStep = {
  id: "spells",
  icon: "fa-solid fa-wand-magic-sparkles",
  labelKey: "step.spells.label",
  template: "steps/spells",

  isComplete(state) {
    const info = state.spellInfo;
    if ( !info ) return false;            // no class chosen yet — not started, so no tick
    if ( !info.isSpellcaster ) return true; // non-caster: nothing to choose (rail greys it)
    // A caster whose spell list resolves to nothing has no picks to make. Holding the build shut
    // over a quota that cannot be filled would trap the player on this screen with no way forward,
    // so the step steps aside and the panel explains what is missing instead.
    if ( info.listMissing ) return true;
    return state.selectedCantrips.length >= info.maxCantrips
        && state.selectedSpells.length >= info.maxSpells;
  },

  /** Why Next is blocked: how many spells are still to be chosen. */
  incompleteHint(state) {
    const info = state.spellInfo;
    if ( !info?.isSpellcaster || info.listMissing ) return null;
    const remain = Math.max(0, info.maxCantrips - state.selectedCantrips.length)
                 + Math.max(0, info.maxSpells - state.selectedSpells.length);
    return remain ? t("step.spells.hint", { count: remain }) : null;
  },

  // The Spells step only applies to spellcasters with something to choose; the rail greys it out
  // otherwise.
  //
  // "Is a spellcaster" is not the same question as "has spells at 1st level". A half-caster declares
  // spellcasting progression on the class item but learns nothing until 2nd — the 2014 Ranger and
  // Paladin both do — so asking `isSpellcaster` alone put an empty spell list in front of every
  // level-1 Ranger. The counts are the honest test.
  applicable(state) {
    if ( !state.spellInfo ) return true;
    if ( !state.spellInfo.isSpellcaster ) return false;
    return ((state.spellInfo.maxCantrips ?? 0) + (state.spellInfo.maxSpells ?? 0)) > 0;
  },

  /** Rail summary: how many spells are picked (cantrips + level-1). */
  summary(state) {
    const n = state.selectedCantrips.length + state.selectedSpells.length;
    return n ? t("step.spells.picked", { count: n }) : "";
  },

  async handle(action, el, { state, spells }) {
    if ( action === "spell-tab" ) {
      state.spellTab = el.dataset.tab;
      state.focusedSpellUuid = null;
      return;
    }
    if ( action === "focus-spell" ) {
      state.focusedSpellUuid = el.dataset.uuid;
      return;
    }
    // The player naming the list this caster draws from, when nothing could work it out for them.
    // Clearing it hands the question back to {@link module:data/spell-source.spellListFor}.
    if ( action === "choose-spell-list" ) {
      state.spellListOverride = el.value ?? "";
      state.focusedSpellUuid = null;
      // The pool is about to be a different set of spells, so picks made against the old one are
      // not picks against this one.
      state.selectedCantrips = [];
      state.selectedSpells = [];
      return;
    }
    if ( action === "clear-spell-list" ) {
      state.spellListOverride = "";
      state.focusedSpellUuid = null;
      state.selectedCantrips = [];
      state.selectedSpells = [];
      return;
    }
    if ( action === "pick-spell" ) {
      const data = await spells.forClass(state.classUuid, { listOverride: state.spellListOverride });
      if ( !data.isSpellcaster ) return;
      const uuid = el.dataset.uuid;
      const isCantrip = Number(el.dataset.level) === 0;
      const bucket = isCantrip ? state.selectedCantrips : state.selectedSpells;
      const idx = bucket.findIndex(s => s.uuid === uuid);
      if ( idx >= 0 ) { bucket.splice(idx, 1); return; }
      // Selecting: ignore the click once the known-spell limit is reached.
      const max = isCantrip ? data.maxCantrips : data.maxSpells;
      if ( bucket.length >= max ) return;
      const spell = (isCantrip ? data.cantrips : data.level1).find(s => s.uuid === uuid);
      if ( spell ) bucket.push({ uuid: spell.uuid, id: spell.id, name: spell.name, img: spell.img, level: spell.level });
    }
  },

  async context({ state, spells, source, app }) {
    const data = await spells.forClass(state.classUuid, { listOverride: state.spellListOverride });
    // Keep the completion gate's view of the class in sync with what we render.
    state.spellInfo = {
      isSpellcaster: !!data.isSpellcaster,
      maxCantrips: data.maxCantrips ?? 0,
      maxSpells: data.maxSpells ?? 0,
      listMissing: !!data.listMissing
    };
    // "Not a caster" and "a caster with nothing to learn yet" both mean there is nothing to show, so
    // both take the short message rather than an empty list. The second is the half-casters: a 2014
    // Ranger or Paladin declares spellcasting progression on the class item but learns its first
    // spell at 2nd level, and asking `isSpellcaster` alone dropped them into the normal list with no
    // rows in it and no explanation.
    const nothingToLearn = ((data.maxCantrips ?? 0) + (data.maxSpells ?? 0)) === 0;
    if ( !data.isSpellcaster || nothingToLearn ) {
      return {
        isSpellcaster: false,
        hint: t(data.isSpellcaster ? "step.spells.notYet" : "step.spells.noCaster")
      };
    }

    const { cantrips, level1, maxCantrips, maxSpells } = data;
    const picked = new Set([...state.selectedCantrips, ...state.selectedSpells].map(s => s.uuid));

    // Spells the build is going to grant anyway — a 2014 Cleric's domain spells, a species cantrip.
    // Offering them here produced two documents on the finished character, and because only the
    // chosen copy counts toward preparation, the pick was silently wasted on a spell they already
    // always have. A spell already picked stays listed (so it can be un-picked) even if a later
    // origin change starts granting it; {@link module:build/spell-reconcile} tidies that case up.
    const grantedCards = await originGrantedSpellCards(state);
    const granted = new Set(grantedCards.map(card => card.uuid));

    // The running tally shown across the top of the step so the player can always
    // see (and read, via tooltip) what they've chosen so far. Kept in two groups —
    // cantrips and level-1 spells — so the player can tell them apart at a glance;
    // each group is alphabetised within itself.
    const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
    const toChip = s => ({ uuid: s.uuid, name: s.name, img: s.img });
    const selectedCantrips = [...state.selectedCantrips].sort(byName).map(toChip);
    const selectedSpells = [...state.selectedSpells].sort(byName).map(toChip);

    // Resolve the active tab, falling back when the class lacks that level of spell.
    let tab = state.spellTab;
    if ( tab === "cantrips" && maxCantrips === 0 ) tab = "level1";
    if ( tab === "level1" && maxSpells === 0 ) tab = "cantrips";

    const activeBucket = tab === "cantrips" ? state.selectedCantrips : state.selectedSpells;
    const activeMax = tab === "cantrips" ? maxCantrips : maxSpells;
    const atLimit = activeBucket.length >= activeMax;
    const pool = tab === "cantrips" ? cantrips : level1;

    const list = pool.filter(s => !granted.has(s.uuid) || picked.has(s.uuid)).map(s => ({
      ...s,
      // Blank for a cantrip: "Lvl 0" is not what a player calls one, and the tab already says so.
      levelLabel: s.level === 0 ? "" : t("levelup.step.spells.levelTag", { level: s.level }),
      active: picked.has(s.uuid),
      focused: state.focusedSpellUuid === s.uuid,
      disabled: atLimit && !picked.has(s.uuid)
    }));

    // Focused spell detail (with its lazily-enriched description).
    let focused = null;
    const focus = list.find(s => s.uuid === state.focusedSpellUuid)
      ?? cantrips.concat(level1).find(s => s.uuid === state.focusedSpellUuid);
    if ( focus ) {
      focused = {
        ...focus,
        active: picked.has(focus.uuid),
        description: await spells.description(focus.uuid),
        source: await spells.sourceBook(focus.uuid)
      };
    }

    // Filter dropdown options drawn from the active list, mirroring the level-up spell browser so
    // the two screens read the same. The level filter is only meaningful on the leveled tab.
    const filters = spellFilterOptions(list, t);
    const className = source?.card(state.classUuid)?.name ?? "";
    const listNotice = spellListNotice(data, state.spellListOverride, className);
    // Pin/compare, exactly as the class and origin pickers opt in — the shell owns the pins, the
    // step only decorates its rows and asks for the toolbar control.
    const pinned = pinContext(app?.pins, "spell", list);

    return {
      isSpellcaster: true,
      tab,
      ...listNotice,
      intro: t("step.spells.intro", { class: className }),
      isCantripsTab: tab === "cantrips",
      isLevel1Tab: tab === "level1",
      hasCantrips: maxCantrips > 0,
      hasLevel1: maxSpells > 0,
      maxCantrips,
      maxSpells,
      cantripCount: state.selectedCantrips.length,
      spellCount: state.selectedSpells.length,
      cantripsFull: maxCantrips > 0 && state.selectedCantrips.length >= maxCantrips,
      spellsFull: maxSpells > 0 && state.selectedSpells.length >= maxSpells,
      atLimit,
      needLabel: t("levelup.step.spells.need", { count: Math.max(0, activeMax - activeBucket.length) }),
      list: pinned.cards,
      compareCategory: pinned.compareCategory,
      compare: pinned.compare,
      count: list.length,
      ...filters,
      selectedCantrips,
      selectedSpells,
      hasSelected: selectedCantrips.length + selectedSpells.length > 0,
      // Shown alongside the picks, not among them: these arrive automatically (a Cleric's domain
      // spells, a species cantrip) and are kept out of the pool so they can't be picked twice.
      // Listing them here is what stops that reading as "my domain spells are missing".
      grantedCantrips: grantedCards.filter(c => c.level === 0).sort(byName).map(toChip),
      grantedSpells: grantedCards.filter(c => c.level > 0).sort(byName).map(toChip),
      hasGranted: grantedCards.length > 0,
      focused
    };
  }
};

/**
 * Slim spellcasting summary for the completion gate — caster flag plus the cantrips/spells
 * known at level 1 — read from the (memoised) {@link SpellSource}. Cached on
 * `state.spellInfo` so the synchronous `isComplete`/`applicable` checks can use it.
 */
export async function spellInfoFor(spells, classUuid, listOverride = "") {
  if ( !classUuid ) return null;
  const info = await spells.forClass(classUuid, { listOverride });
  return {
    isSpellcaster: !!info.isSpellcaster,
    maxCantrips: info.maxCantrips ?? 0,
    maxSpells: info.maxSpells ?? 0,
    // Whether the pool came back empty, so the gate knows not to demand picks that cannot be made.
    listMissing: !!info.listMissing
  };
}
