import { t } from "../../config.mjs";
import { cantripsKnownAtLevel, buildSpellFromEntry, spellFilterOptions, spellListNotice, spellMethodFor,
  spellAlternatives } from "../../data/spell-source.mjs";
import { ownedSpellKeys, spellKey } from "../../data/spell-identity.mjs";
import { planSpellReconciliation } from "../../build/spell-reconcile.mjs";
import { swapAllowance } from "../../data/spell-swap.mjs";
import { pinContext } from "../../app/compare.mjs";
import { advancementArray } from "../../data/advancement-util.mjs";

/**
 * @typedef {object} SpellPlan
 * @property {boolean} isSpellcaster   Whether the leveled class (or its subclass) casts spells.
 * @property {boolean} hasDelta        Whether this level-up opened new cantrip/spell capacity.
 * @property {string}  [listId]        Identifier of the spell list to draw from (e.g. "wizard", or a
 *                                     subclass id for a subclass caster like the Eldritch Knight).
 * @property {string}  [listType]      Registry type of that list — "class" or "subclass".
 * @property {string}  [sourceTag]     The `sourceItem` tag to stamp on added spells so they count
 *                                     toward this caster (`class:<id>` or `subclass:<id>`).
 * @property {string}  [method]        Casting method for added spells — "pact" for a Warlock (Pact
 *                                     Magic slots), "spell" otherwise.
 * @property {string}  [castUuid]      Compendium source UUID of the casting item, for the spell pool.
 * @property {Item5e}  [castItem]      The casting item itself (on the clone, or the actor once
 *                                     committed) — handed to the spell pool so a class with no
 *                                     compendium entry to fetch still resolves its list.
 * @property {number}  [classLevel]    The class's current level (subclass scales key off it too).
 * @property {number}  [cantripTarget] Total cantrips known at this level.
 * @property {number}  [cantripHave]   Cantrips already known for this caster.
 * @property {number}  [spellTarget]   Total prepared spells allowed (preparation.max).
 * @property {number}  [spellHave]     Prepared leveled spells already known (preparation.value).
 * @property {number}  [maxSpellLevel] Highest spell level the actor has slots for.
 * @property {number}  [releasedSpells]   Prepared selections a pending granted-spell merge frees.
 * @property {number}  [releasedCantrips] Cantrip selections a pending granted-spell merge frees.
 * @property {number}  addCantrips     Cantrips the player may add this level-up (≥ 0).
 * @property {number}  addSpells       Leveled spells the player may add this level-up (≥ 0).
 */

/**
 * The item that actually casts for a leveled class: the class itself when it has a spellcasting
 * progression, otherwise a spellcasting subclass of it (the Eldritch Knight / Arcane Trickster case,
 * where the magic lives on the subclass, not the base class). Returns the item and its registry
 * type so the pool and the `sourceItem` tag can be scoped correctly.
 * @param {Actor5e} actorLike
 * @param {Item5e|null} classItem
 * @returns {{ item: Item5e, type: "class"|"subclass" }|null}
 */
function spellcastingItem(actorLike, classItem) {
  const casts = it => { const p = it?.system?.spellcasting?.progression; return !!p && p !== "none"; };
  if ( casts(classItem) ) return { item: classItem, type: "class" };
  const classId = classItem?.system?.identifier;
  for ( const it of actorLike.items ) {
    if ( it.type === "subclass" && it.system?.classIdentifier === classId && casts(it) ) {
      return { item: it, type: "subclass" };
    }
  }
  return null;
}

/**
 * Compute the spell capacity a level-up opens up, from an actor-like's derived data (the driver's
 * clone before commit, or the real actor after). "Add-only" this phase: the player fills up to the
 * new totals, never swaps out an existing pick.
 *
 * There is no spellcasting advancement in dnd5e (§2.4 of the level-up plan), so these numbers are
 * read straight off the system's own derived spellcasting fields rather than a manager step:
 * `preparation.max`/`.value` for leveled spells and the "Cantrips Known" scale for cantrips. The
 * casting source may be the class *or* a spellcasting subclass ({@link spellcastingItem}); either
 * way the class level drives the scales and `actor.system.spells` bounds the spell level.
 * @param {Actor5e} actorLike     Clone or real actor whose derived data reflects the new level.
 * @param {Item5e|null} classItem The leveled class item on that actor-like.
 * @returns {SpellPlan}
 */
export function computeSpellPlan(actorLike, classItem) {
  const casting = spellcastingItem(actorLike, classItem);
  if ( !casting ) return { isSpellcaster: false, hasDelta: false, addCantrips: 0, addSpells: 0 };

  const { item: castItem, type: listType } = casting;
  const sc = castItem.system.spellcasting;
  const listId = castItem.system?.identifier ?? castItem.name?.toLowerCase() ?? "";
  const sourceTag = `${listType}:${listId}`;
  // Casting method → which slot pool the added spells use: a pact caster (Warlock) casts from
  // Pact Magic slots ("pact"), everyone else from ordinary spell slots ("spell"). The shared helper
  // is the same one the creation spell grant uses, so the two paths can't drift.
  const method = spellMethodFor(castItem);
  const castUuid = castItem._stats?.compendiumSource ?? castItem.uuid;
  // Subclass scales are keyed by the *class* level, so always measure from the base class item.
  const classLevel = classItem.system?.levels ?? actorLike.system?.details?.level ?? 1;

  // Capacity targets from the caster's derived data.
  const cantripTarget = cantripsKnownAtLevel(castItem, classLevel);
  const spellTarget = sc.preparation?.max ?? 0;

  // What the actor already knows. `preparation.value` is the system's own count of prepared leveled
  // spells for this caster (cantrips and always-prepared spells excluded — see SpellData#countsPrepared),
  // so it lines up exactly with `preparation.max`; cantrips have no such counter, so tally them.
  const spellHave = sc.preparation?.value ?? 0;
  let cantripHave = 0;
  for ( const item of actorLike.items ) {
    if ( item.type === "spell" && (item.system?.level ?? 0) === 0
      && (item.system?.sourceItem ?? "") === sourceTag ) cantripHave++;
  }

  // Highest spell level the actor has slots for (leveled or pact), bounding what may be prepared.
  const spells = actorLike.system?.spells ?? {};
  let maxSpellLevel = 0;
  for ( let l = 1; l <= 9; l++ ) if ( (spells[`spell${l}`]?.max ?? 0) > 0 ) maxSpellLevel = l;
  if ( (spells.pact?.max ?? 0) > 0 ) maxSpellLevel = Math.max(maxSpellLevel, spells.pact?.level ?? 0);

  // Selections a pending merge will hand back. A spell chosen at an earlier level that a feature now
  // grants always-prepared is about to be collapsed into the granted copy ({@link module:build/spell-reconcile}),
  // and the copy being removed is the one still counted above — as a prepared spell in
  // `preparation.value`, or as a cantrip under this caster's tag. Adding the released count restores
  // the capacity the merge is about to free, so the player spends it now rather than discovering an
  // unexplained extra pick at the next level. Planning only reads, which is what makes it safe to run
  // against the driver's clone.
  const { releasedSpells, releasedCantrips } = planSpellReconciliation(actorLike);

  const addCantrips = Math.max(0, cantripTarget - cantripHave) + releasedCantrips;
  const addSpells = maxSpellLevel > 0 ? Math.max(0, spellTarget - spellHave) + releasedSpells : 0;

  // What the edition lets this caster replace. Read from the casting item rather than the actor
  // because a multiclassed character can hold a 2014 class beside a 2024 one, and only the class
  // gaining the level has a say in what it may trade.
  const swap = swapAllowance(castItem);

  return {
    isSpellcaster: true, listId, listType, sourceTag, castUuid, castItem, classLevel, method,
    cantripTarget, cantripHave, spellTarget, spellHave, maxSpellLevel,
    releasedSpells, releasedCantrips,
    canSwapCantrip: swap.cantrip, canSwapSpell: swap.spell, swapLabelKey: swap.labelKey,
    addCantrips, addSpells, hasDelta: (addCantrips > 0) || (addSpells > 0)
  };
}

/* -------------------------------------------- */

/** The bucket ("cantrips" | "spells") a pick belongs to, and its per-bucket cap. */
function bucketFor(state, plan) {
  const wantCantrips = plan.addCantrips > 0;
  let tab = state.spellTab;
  if ( tab === "cantrips" && !wantCantrips ) tab = "spells";
  if ( tab === "spells" && plan.addSpells <= 0 ) tab = wantCantrips ? "cantrips" : "spells";
  if ( !tab ) tab = wantCantrips ? "cantrips" : "spells";
  return tab;
}

/**
 * The **Spells** step. Unlike the per-level section providers this is a standalone rail step,
 * sitting between the level screens and the Review: it reads the new slot/prepared capacity off
 * the driver's clone (whose derived data already reflects the gained level) and lets the player
 * pick the cantrips and spells the level unlocked. Picks are staged on `state.selected*`, shown
 * on the Review screen, and written to the actor by the shell's single Apply right after the
 * level commit — mirroring the creation flow's staged `addSpells`.
 *
 * Completion is advisory (`isComplete` → true) so the player is never trapped — an empty or
 * unappealing pool never blocks Apply, and any unfilled capacity can be finished on the sheet
 * later.
 */
export const lvlSpellsStep = {
  id: "spells",
  icon: "fa-solid fa-wand-magic-sparkles",
  labelKey: "levelup.step.spells.label",
  template: "levelup/spells",

  // Always satisfiable — spell picks are optional, so this never blocks Review or Apply.
  isComplete() { return true; },

  summary(state) {
    const n = state.selectedCantrips.length + state.selectedSpells.length;
    return n ? t("levelup.step.spells.picked", { count: n }) : "";
  },

  async handle(action, el, ctx) {
    const { state } = ctx;
    if ( action === "spell-tab" ) {
      state.spellTab = el.dataset.tab;
      state.focusedSpellUuid = null;
      return;
    }
    if ( action === "focus-spell" ) {
      state.focusedSpellUuid = el.dataset.uuid;
      return;
    }
    if ( action === "pick-spell" ) return pickSpell(el, ctx);
    if ( action === "swap-spell" ) return toggleSwap(el, ctx);
    // Substituting a feat-granted spell the character already knows. The empty value is "keep the
    // spell the feat names", so clearing the control undoes the substitution rather than leaving
    // the grant with nothing.
    if ( action === "feat-spell-swap" ) {
      const key = el.dataset.key;
      if ( !key ) return;
      if ( el.value ) state.featSpellSwaps[key] = el.value;
      else delete state.featSpellSwaps[key];
      return;
    }
    // The player naming the list this caster draws from, when nothing could work it out for them,
    // and taking it back again. Either way the pool changes, so picks staged against the old one go.
    if ( (action === "choose-spell-list") || (action === "clear-spell-list") ) {
      state.spellListOverride = (action === "choose-spell-list") ? (el.value ?? "") : "";
      state.focusedSpellUuid = null;
      state.selectedCantrips = [];
      state.selectedSpells = [];
      state.swapCantrip = null;
      state.swapSpell = null;
    }
  },

  async context({ state, spells, app }) {
    // Feat grants render on this page whether or not the character can cast anything of their own —
    // Cold Caster exists so a Fighter can learn a cantrip, and that Fighter has no other spell
    // capacity to bring them here. Resolved before the caster check for exactly that reason.
    const featGrants = await featGrantContext(state);
    const plan = state.spellPlan();
    if ( !plan.isSpellcaster ) {
      return {
        isSpellcaster: false, featGrants,
        // Only "nothing to learn" when the feats brought nothing either.
        hint: featGrants.length ? null : t("levelup.step.spells.noneNeeded")
      };
    }

    const pool = await spells.forClassAtLevel(plan.castUuid, plan.maxSpellLevel, plan.listType,
      { doc: plan.castItem, listOverride: state.spellListOverride });
    const tab = bucketFor(state, plan);
    const isCantrips = tab === "cantrips";

    // Effective add budgets: a marked swap frees one extra slot in its bucket (Phase 4b). The
    // allowance is re-checked here as well as at the rows, so a mark left behind by an earlier
    // render (the leveled class can change mid-session) can never widen a budget the edition
    // has since closed.
    const effCantrips = plan.addCantrips + ((plan.canSwapCantrip && state.swapCantrip) ? 1 : 0);
    const effSpells = plan.addSpells + ((plan.canSwapSpell && state.swapSpell) ? 1 : 0);

    const picked = new Set([...state.selectedCantrips, ...state.selectedSpells].map(s => s.uuid));
    const ownedItems = ownedSpells(state.actor, plan.sourceTag, isCantrips);
    // Two different questions, and answering both from one set was the bug. *Swappable* is narrow —
    // a regularly-prepared spell under this caster's own tag. *Already owned* is everything the
    // character has, whatever granted it and whatever its preparation state, read from the clone so
    // a grant applied by this very level-up counts. Filtering the pool by the narrow set let a
    // feature-granted spell (always prepared, often tagged to a subclass) be offered a second time —
    // and the duplicate then ate a prepared slot forever.
    const ownedKeys = ownedSpellKeys(state.spellSource);

    // The pool for the active tab: cantrips (level 0) or every leveled spell up to the slot cap.
    // Already-owned spells are dropped from the *addable* pool — they instead appear as swap-out
    // candidates below, so the player can replace one when this bucket has capacity.
    const raw = isCantrips
      ? (pool.byLevel?.[0] ?? [])
      : Object.entries(pool.byLevel ?? {}).filter(([l]) => Number(l) > 0)
          .flatMap(([, arr]) => arr).sort(byLevelThenName);
    const budget = isCantrips ? effCantrips : effSpells;
    const chosen = isCantrips ? state.selectedCantrips : state.selectedSpells;
    const swapMark = isCantrips ? state.swapCantrip : state.swapSpell;
    const released = (isCantrips ? plan.releasedCantrips : plan.releasedSpells) ?? 0;
    const atLimit = chosen.length >= budget;
    const decorate = s => ({ ...s, levelLabel: s.level === 0 ? "" : t("levelup.step.spells.levelTag", { level: s.level }) });

    // Owned spells the player may swap out — offered only when this bucket has add capacity (you
    // replace a spell in the same breath as learning one) *and* the edition grants that class the
    // replacement at all. Under the 2014 rules no class trades a cantrip on level-up, so those rows
    // simply don't appear; see {@link module:data/spell-swap}. Shown selected until marked, then struck.
    const canSwap = isCantrips ? plan.canSwapCantrip : plan.canSwapSpell;
    // The words an owned row wears: the flag under the compare pin, the tooltip behind it, and the
    // note the detail pane opens with. All three fork on the same edition test that words the hint
    // above the list ({@link module:data/spell-swap}) — a 2014 Wizard changes what it has prepared,
    // it does not forget a spell it knows.
    const prepared = plan.swapLabelKey === "levelup.step.spells.swapHintPrepared";
    const wording = (known, prep) => `levelup.step.spells.${prepared ? prep : known}`;
    const ownedLabels = {
      ownedTag: t(wording("ownedTag", "ownedTagPrepared")),
      ownedTip: t(wording("ownedTip", "ownedTipPrepared")),
      swapTag: t("levelup.step.spells.swapTag"),
      swapTip: t("levelup.step.spells.swapTip")
    };
    const ownedRows = (canSwap && (plan[isCantrips ? "addCantrips" : "addSpells"] > 0))
      ? ownedItems.map(o => ({
          ...decorate(o), ...ownedLabels, owned: true, swapMarked: swapMark?.id === o.id,
          focused: state.focusedSpellUuid === o.uuid
        }))
      : [];

    const poolRows = raw.filter(s => !ownedKeys.has(spellKey(s))).map(s => ({
      ...decorate(s), owned: false,
      active: picked.has(s.uuid),
      focused: state.focusedSpellUuid === s.uuid,
      disabled: atLimit && !picked.has(s.uuid)
    }));
    const list = [...ownedRows, ...poolRows];

    let focused = null;
    const focus = list.find(s => s.uuid === state.focusedSpellUuid);
    if ( focus ) {
      focused = {
        ...focus,
        // What this row *is*, said in full where there is room to say it: the flag in the list is
        // one word, and one word cannot explain that a known spell is kept out of the pool on
        // purpose, or that trading one away buys a pick this level.
        note: focus.owned
          ? (focus.swapMarked ? t("levelup.step.spells.swapNote") : t(wording("ownedNote", "ownedNotePrepared")))
          : "",
        description: await spells.description(focus.uuid),
        source: await spells.sourceBook(focus.uuid)
      };
    }

    const toChip = s => ({ uuid: s.uuid, name: s.name, img: s.img });
    const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);

    // Filter options drawn from the spells actually in the list, so the dropdowns only ever offer
    // values that can match. Level filtering is meaningful only on the leveled tab (cantrips are all
    // level 0); the rest apply to both. The <select> values mirror the row data-attributes the
    // client-side filter compares against ({@link CreatorShellBase#_applySpellFilters}).
    const filters = spellFilterOptions(list, t);
    // Pin/compare, as the creation spell step and the origin pickers do. Owned swap-out rows are
    // pinnable too: "is the spell I already know still better than this one" is the same question.
    const pinned = pinContext(app?.pins, "spell", list);

    const className = state.classItem?.name ?? "";
    return {
      isSpellcaster: true,
      ...spellListNotice(pool, state.spellListOverride, className),
      intro: t("levelup.step.spells.intro", { class: className }),
      // The wording follows the class: a 2014 prepared caster is changing what it has prepared,
      // not trading a spell it knows forever.
      swapHint: ownedRows.length ? t(plan.swapLabelKey ?? "levelup.step.spells.swapHint") : "",
      // A marked swap raises this tab's budget by one, which is otherwise an unexplained extra pick:
      // name the spell being replaced so the count and the struck-through row are one story.
      swapActiveHint: (canSwap && swapMark) ? t("levelup.step.spells.swapActive", { name: swapMark.name }) : "",
      // Why there is an extra pick this level: a spell chosen earlier is about to become always
      // prepared, so the selection it was occupying comes back.
      releasedHint: released > 0 ? t("levelup.step.spells.releasedHint", { count: released }) : "",
      hasCantrips: plan.addCantrips > 0,
      hasSpells: plan.addSpells > 0,
      isCantripsTab: isCantrips,
      isSpellsTab: !isCantrips,
      addCantrips: effCantrips,
      addSpells: effSpells,
      cantripCount: state.selectedCantrips.length,
      spellCount: state.selectedSpells.length,
      cantripsFull: effCantrips > 0 && state.selectedCantrips.length >= effCantrips,
      spellsFull: effSpells > 0 && state.selectedSpells.length >= effSpells,
      needLabel: t("levelup.step.spells.need", { count: Math.max(0, budget - chosen.length) }),
      atLimit,
      list: pinned.cards,
      compareCategory: pinned.compareCategory,
      compare: pinned.compare,
      ...filters,
      count: list.length,
      focused,
      selectedCantrips: [...state.selectedCantrips].sort(byName).map(toChip),
      selectedSpells: [...state.selectedSpells].sort(byLevelThenName).map(toChip),
      hasSelected: state.selectedCantrips.length + state.selectedSpells.length > 0
    };
  }
};

/** Toggle a spell into/out of the staged selection, capped at the effective add budget (incl. swap). */
async function pickSpell(el, { state }) {
  const plan = state.spellPlan();
  const uuid = el.dataset.uuid;
  const isCantrip = Number(el.dataset.level) === 0;
  const bucket = isCantrip ? state.selectedCantrips : state.selectedSpells;

  const idx = bucket.findIndex(s => s.uuid === uuid);
  if ( idx >= 0 ) { bucket.splice(idx, 1); return; }

  const allowed = isCantrip ? plan.canSwapCantrip : plan.canSwapSpell;
  const swap = allowed && (isCantrip ? state.swapCantrip : state.swapSpell);
  const max = (isCantrip ? plan.addCantrips : plan.addSpells) + (swap ? 1 : 0);
  if ( bucket.length >= max ) return;   // ignore the click once the budget is spent
  const doc = await fromUuid(uuid).catch(() => null);
  if ( doc ) bucket.push({ uuid, id: doc.id, name: doc.name, img: doc.img, level: doc.system?.level ?? 0 });
}

/**
 * Mark (or unmark) an owned spell for replacement this level-up (Phase 4b). Marking frees one extra
 * slot in that bucket; unmarking drops the replacement pick that filled it so the budget stays
 * honest. Marking a different owned spell moves the mark without changing the freed count.
 */
async function toggleSwap(el, { state }) {
  const plan = state.spellPlan();
  const isCantrip = Number(el.dataset.level) === 0;
  // The rows this fires from are only rendered when the edition allows the replacement, so this is
  // belt-and-braces against a stale click landing after the leveled class changed.
  if ( !(isCantrip ? plan.canSwapCantrip : plan.canSwapSpell) ) return;
  const key = isCantrip ? "swapCantrip" : "swapSpell";
  const bucket = isCantrip ? state.selectedCantrips : state.selectedSpells;
  const addBudget = isCantrip ? plan.addCantrips : plan.addSpells;
  const id = el.dataset.id;

  if ( state[key]?.id === id ) {
    state[key] = null;
    while ( bucket.length > addBudget ) bucket.pop();   // give back the freed slot's pick
  } else {
    state[key] = { id, name: el.dataset.name ?? "" };
  }
}

/**
 * The actor's own spells for a caster in one bucket (cantrips or leveled), as swap-out candidates.
 * Leveled spells are limited to regularly-prepared picks (`countsPrepared`: `prepared === 1`) so an
 * always-prepared or granted spell can't be swapped away; cantrips are matched by level 0.
 * @returns {{id:string, uuid:string, name:string, img:string, level:number}[]}
 */
function ownedSpells(actor, sourceTag, isCantrips) {
  const out = [];
  for ( const item of actor.items ) {
    if ( item.type !== "spell" || (item.system?.sourceItem ?? "") !== sourceTag ) continue;
    const level = item.system?.level ?? 0;
    if ( isCantrips ? level !== 0 : !(level > 0 && item.system?.prepared === 1) ) continue;
    // Reuse the shared spell-card shape (school/components/flags) so the focused detail reads the
    // same as a pool spell, but keep the *owned* item id (for deletion) and its source uuid.
    out.push({ ...buildSpellFromEntry(item), id: item.id, uuid: item._stats?.compendiumSource ?? item.uuid });
  }
  return out.sort(byLevelThenName);
}

/**
 * The feat-granted spells as the spell page shows them: always ticked, and — for a grant whose feat
 * allows it, to a character who already knows the spell — offering the substitute the rules give.
 *
 * Ticked rather than tickable because the feat is already taken; the decision the player made was
 * "take Cold Caster", and asking them to confirm the cantrip it says they learn is a second question
 * the rules never pose. The one real decision is the substitution, and it appears only where the
 * feat's text puts it.
 * @param {import("../levelup-state.mjs").LevelUpState} state
 * @returns {Promise<object[]>}
 */
async function featGrantContext(state) {
  const grants = state.featSpells ?? [];
  return Promise.all(grants.map(async g => {
    const swappable = g.replaceable && g.alreadyKnown;
    const chosenUuid = state.featSpellSwaps?.[g.key] ?? "";
    const alternatives = swappable ? await spellAlternatives(g.uuid, g.level) : [];
    const chosen = alternatives.find(a => a.uuid === chosenUuid) ?? null;
    return {
      key: g.key,
      featName: g.featName,
      featImg: g.featImg,
      // What the character ends up with: the granted spell, or the substitute they chose instead.
      name: chosen?.name ?? g.name,
      img: chosen?.img ?? g.img,
      uuid: chosen?.uuid ?? g.uuid,
      levelLabel: g.level === 0 ? t("levelup.step.spells.cantripTag") : t("levelup.step.spells.levelTag", { level: g.level }),
      swappable,
      // Named so the player can see what they are replacing, not just that they replaced something.
      replacedName: chosen ? g.name : "",
      alternatives: alternatives.map(a => ({ ...a, selected: a.uuid === chosenUuid })),
      alreadyKnown: g.alreadyKnown
    };
  }));
}

/**
 * The spells a feat taken this level-up hands out — Cold Caster's Ray of Frost, Enclave Magic's
 * Thorn Whip — read off the feat's own `ItemGrant` advancements.
 *
 * **Why these need the spell page at all.** dnd5e treats them as items granted by an advancement,
 * so nothing showed the player a spell they had just gained, and for the ones the pack marks
 * `optional` nothing granted them either: the system's rule is that an optional item is *not*
 * applied by default (see `#ingestFlow`'s ItemGrant branch), so Cold Caster arrived as an unticked
 * box in a features list. Both feats and spells, and the player's own spell list, live here.
 *
 * **`optional` is the replacement flag, and it is exact.** Cold Caster reads "You learn the Ray of
 * Frost cantrip. *If you already know it, you learn a different Wizard cantrip of your choice*" —
 * and its granted item is the only one of the five spell-granting feats in the reference content
 * marked `optional`; the four without the clause are all unmarked. So the pack's flag says
 * precisely what the prose says, and no description has to be parsed to know it.
 *
 * Pure apart from the uuid lookups, so the shape can be tested without a manager.
 * @param {import("../levelup-state.mjs").LevelUpState} state
 * @returns {Promise<{key: string, featId: string, featName: string, featImg: string, advId: string,
 *   uuid: string, name: string, img: string, level: number, replaceable: boolean,
 *   alreadyKnown: boolean, spell: object}[]>}
 */
export async function featSpellGrants(state) {
  const driver = state.driver;
  if ( !driver?.clone ) return [];
  // Every spell the character already holds, minus the ones these grants themselves put there —
  // a grant must not report its own spell as one the character "already knew".
  const grantedIds = new Set();
  const raw = [];

  for ( const record of state.asiSteps ?? [] ) {
    const st = driver.asiState(record);
    if ( (st?.type !== "feat") || !st.feat ) continue;
    const featItem = driver.clone.items.get(st.feat.id);
    if ( !featItem ) continue;

    for ( const adv of advancementArray(featItem) ) {
      if ( (adv.type !== "ItemGrant") || !adv.configuration?.spell ) continue;
      for ( const id of Object.keys(adv.value?.added ?? {}) ) grantedIds.add(id);
      for ( const entry of Array.from(adv.configuration.items ?? []) ) {
        const uuid = (typeof entry === "string") ? entry : entry?.uuid;
        if ( !uuid ) continue;
        raw.push({
          key: `${st.feat.id}:${uuid}`,
          featId: st.feat.id, featName: st.feat.name, featImg: st.feat.img,
          // Tags the substitute back to its feat, exactly as the creation flow tags a Magic
          // Initiate pick — `feat:<identifier>`.
          featIdentifier: featItem.system?.identifier ?? "",
          advId: adv._id ?? adv.id,
          uuid,
          // The pack's own per-item flag — see the note above. `configuration.optional` is a
          // different thing (the whole advancement may be skipped) and is not it.
          replaceable: (typeof entry === "object") && !!entry.optional,
          spell: adv.configuration.spell
        });
      }
    }
  }
  if ( !raw.length ) return [];

  const owned = ownedSpellKeys({ items: [...driver.clone.items].filter(i => !grantedIds.has(i.id)) });
  const docs = await Promise.all(raw.map(g => fromUuid(g.uuid).catch(() => null)));
  return raw.map((g, i) => {
    const doc = docs[i];
    const level = Number(doc?.system?.level ?? 0);
    return {
      ...g,
      name: doc?.name ?? g.uuid,
      img: doc?.img ?? "icons/svg/book.svg",
      level,
      // The rules make the substitution conditional — "*If you already know it*" — so the control
      // only exists for a character who does. A feat that grants a spell they don't have is not
      // offering a choice, and rendering one would invent a rule.
      alreadyKnown: !!doc && owned.has(spellKey(doc))
    };
  });
}

/**
 * Resolve the staged spell step into concrete actor changes: the spells to create and the ids of
 * swapped-out spells to delete. A swap only deletes when its freed slot was actually used (the
 * bucket holds more picks than the base add budget), so marking without picking a replacement is a
 * harmless no-op.
 * @param {import("../levelup-state.mjs").LevelUpState} state
 * @returns {{sourceTag:string, method:string, create:{uuid:string}[], deleteIds:string[]}}
 */
export function spellChanges(state) {
  const plan = state.spellPlan();
  const create = [...state.selectedCantrips, ...state.selectedSpells];
  const deleteIds = [];
  if ( state.swapCantrip && state.selectedCantrips.length > plan.addCantrips ) deleteIds.push(state.swapCantrip.id);
  if ( state.swapSpell && state.selectedSpells.length > plan.addSpells ) deleteIds.push(state.swapSpell.id);
  return { sourceTag: plan.sourceTag, method: plan.method ?? "spell", create, deleteIds };
}

/**
 * Item data for the substitutes chosen in place of feat-granted spells.
 *
 * Separate from {@link spellChanges} rather than folded into its `create` list, for two reasons that
 * both matter. These spells belong to the **feat**, not to the levelling class, so they carry a
 * `feat:<identifier>` source tag and the grant's own casting configuration — the same tagging the
 * creation flow applies to a Magic Initiate pick. And the caster path is gated on the class having a
 * `sourceTag` at all: a Fighter who took Cold Caster has none, and routing these through that gate
 * would silently drop the very case this feature exists for.
 *
 * The originals are not created here. Those are granted on the clone by the advancement itself
 * ({@link module:levelup/manager-driver.LevelUpDriver#syncFeatSpellGrants}), which is what carries
 * them through Apply; creating them again would be the duplicate `spell-reconcile` exists to undo.
 * @param {import("../levelup-state.mjs").LevelUpState} state
 * @returns {Promise<object[]>}
 */
export async function featSubstituteData(state) {
  const swaps = state.featSpellSwaps ?? {};
  const grants = (state.featSpells ?? []).filter(g => swaps[g.key]);
  const data = [];
  for ( const grant of grants ) {
    const doc = await fromUuid(swaps[grant.key]).catch(() => null);
    if ( !doc ) continue;
    const obj = doc.toObject();
    if ( obj._stats ) obj._stats.compendiumSource = swaps[grant.key];
    const cfg = grant.spell ?? {};
    // Mirror what the ItemGrant would have applied to the spell it replaces: the same preparation
    // mode (2 = always prepared, which is what these feats grant), the same casting method, and the
    // same ability. The ability list can offer several — Cold Caster's "the ability increased by
    // this feat" — and the first allowed is the default the native grant flow also lands on.
    foundry.utils.setProperty(obj, "system.prepared", Number(cfg.prepared ?? 1));
    foundry.utils.setProperty(obj, "system.method", cfg.method || "spell");
    const ability = Array.from(cfg.ability ?? [])[0];
    if ( ability ) foundry.utils.setProperty(obj, "system.ability", ability);
    foundry.utils.setProperty(obj, "system.sourceItem", `feat:${grant.featIdentifier || grant.featId}`);
    data.push(obj);
  }
  return data;
}

/** Sort spells by level then name — the leveled tab and tally read top-down through the levels. */
function byLevelThenName(a, b) {
  return (a.level - b.level) || a.name.localeCompare(b.name, game.i18n.lang);
}

/**
 * Write the staged spell picks onto the real actor as prepared spells — the level-up counterpart of
 * the creation flow's `addSpells` ([actor-assembler.mjs]): each compendium spell is cloned with
 * `prepared:1`, the caster's `method` (so a Warlock's spells use Pact Magic slots), and a
 * `sourceItem` link back to the caster so it counts toward that class's (or subclass's)
 * preparation and uses its casting ability.
 * @param {Actor5e} actor
 * @param {string} sourceTag  The caster's `sourceItem` tag (`class:<id>` or `subclass:<id>`).
 * @param {{uuid:string}[]} picks
 * @param {string} [method="spell"]  Casting method — "pact" for a Warlock, "spell" otherwise.
 */
export async function applyLevelUpSpells(actor, sourceTag, picks, method = "spell") {
  const data = await buildSpellItemData(sourceTag, picks, method);
  if ( data.length ) await actor.createEmbeddedDocuments("Item", data, { render: false });
}

/**
 * The item data for a set of staged spell picks, ready to create on an actor (or to stage onto an
 * advancement clone — the Ember hand-off writes through the clone so Ember's own single write
 * carries the spells too).
 * @param {string} sourceTag  The caster's `sourceItem` tag (`class:<id>` or `subclass:<id>`).
 * @param {{uuid:string}[]} picks
 * @param {string} [method="spell"]  Casting method — "pact" for a Warlock, "spell" otherwise.
 * @returns {Promise<object[]>}
 */
export async function buildSpellItemData(sourceTag, picks, method = "spell") {
  if ( !picks.length ) return [];
  // Load the picked spells' source documents in parallel — sequential fromUuid awaits made
  // Finish scale with the number of picks when any doc wasn't already in the pack cache.
  const docs = await Promise.all(picks.map(pick => fromUuid(pick.uuid).catch(() => null)));
  const data = [];
  docs.forEach((doc, i) => {
    if ( !doc ) return;
    const obj = doc.toObject();
    if ( obj._stats ) obj._stats.compendiumSource = picks[i].uuid;
    foundry.utils.setProperty(obj, "system.prepared", 1);
    foundry.utils.setProperty(obj, "system.method", method);
    if ( sourceTag ) foundry.utils.setProperty(obj, "system.sourceItem", sourceTag);
    data.push(obj);
  });
  return data;
}
