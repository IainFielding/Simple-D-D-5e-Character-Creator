import { ABILITIES, t } from "../../config.mjs";
import { atLevel, advancementHint } from "../levelup-state.mjs";

/**
 * Ability Score Improvement — at this level raise ability scores (spend the point budget, usually
 * +2 split as you like, capped at each ability's maximum) or, where the class allows it, take a
 * feat instead. Everything applies straight to the driver's clone, so Review and the committed
 * actor reflect the choice.
 */
/**
 * The "increases" dropdown's options: one per ability some feat on screen can actually raise.
 *
 * Derived from the rendered feats rather than listed as a fixed six, the way the spell toolbar
 * derives its dropdowns from the rows on screen — a world whose feats never touch Charisma should
 * not offer a filter that can only empty the list. Returns nothing when no feat raises anything, so
 * the caller can drop the control entirely (a table using only the free rules has no half-feats).
 *
 * Both grids feed it: filtering to Strength and finding the "coming later" shelf still populated is
 * the honest answer, since those feats do raise Strength — they are just not available yet.
 * @param {{options: object[], lockedOptions: object[]}} picker
 * @returns {{value: string, label: string}[]}
 */
function abilityFilterOptions(picker) {
  const present = new Set();
  for ( const opt of [...picker.options, ...picker.lockedOptions] ) {
    for ( const key of opt.abilities ?? [] ) present.add(key);
  }
  return ABILITIES
    .filter(key => present.has(key))
    .map(key => ({ value: key, label: CONFIG.DND5E?.abilities?.[key]?.label ?? key.toUpperCase() }));
}

export const asiStep = {
  id: "asi",
  icon: "fa-solid fa-star",
  labelKey: "levelup.step.asi.label",
  template: "levelup/asi",

  isCompleteAt(state, level) {
    return atLevel(state.asiSteps, level).every(r => {
      const st = state.driver.asiState(r);
      if ( st.type === "feat" ) return !!st.feat;
      if ( st.type === "asi" ) return st.available === 0;
      return false;
    });
  },

  async sectionsAt({ state, driver, source }, level) {
    const records = atLevel(state.asiSteps, level);
    if ( !records.length ) return null;

    // A chosen feat may carry its *own* half-feat increase, surfaced as a child ASI record. Render
    // that child inside the feat's panel (its stacked-scores column) rather than as a section of its
    // own, so a half-feat reads as one decision — feat on the left, its ability points on the right.
    const children = new Set();
    for ( const r of state.asiSteps ) for ( const c of r.featSynth?.asi ?? [] ) children.add(c);

    const sections = [];
    for ( const record of records ) {
      if ( children.has(record) ) continue;
      const st = driver.asiState(record);
      const index = state.asiSteps.indexOf(record);

      if ( record.pickingFeat ) {
        // Mid-pick: swap the ability-score/feat panel for the inline feat grid until the player
        // chooses one (or cancels back to whatever this decision held before).
        const picker = await driver.asiFeatOptions(record);
        // The picker declares its own density, the way the choices and trait steps do — the block's
        // is "form", which suits the ability steppers beside it and not a feat list. Counted across
        // both grids (pickable and "coming later"), since one attribute governs the pair, and a feat
        // pool is a chooser: with every book enabled it runs past fifty, which as full 72px cards is
        // several screens of scrolling.
        const shown = picker.options.length + picker.lockedOptions.length;
        // The filter reads a card's abilities off a `data-` attribute, so flatten the set to the
        // space-separated string the DOM wants — the same shape `data-props` carries on a spell
        // row. Written onto the option objects themselves because `groups` holds those very
        // objects, so the grouped and ungrouped renderings both pick it up from one pass.
        for ( const opt of [...picker.options, ...picker.lockedOptions] ) {
          opt.abilityKeys = (opt.abilities ?? []).join(" ");
        }
        sections.push({
          index, picking: true,
          groups: picker.groups, options: picker.options, lockedOptions: picker.lockedOptions,
          pickerDensity: shown >= 9 ? "compact" : "standard",
          abilityOptions: abilityFilterOptions(picker),
          showFuture: !!record.showFuture, hasLocked: picker.lockedOptions.length > 0
        });
        continue;
      }

      if ( st.type === "feat" ) {
        // Feat chosen: description on the left (like a background), stacked ability scores on the
        // right. A feat with an ability *choice* gets live steppers on its child record; otherwise
        // the panel locks every score, surfacing a half-feat's fixed "+1" on the ability it boosts.
        const child = record.featSynth?.asi?.[0] ?? null;
        const childSt = child ? driver.asiState(child) : null;
        sections.push({
          index,
          isFeat: true,
          feat: st.feat,
          detail: st.feat ? await source.detail(st.feat.uuid) : null,
          // Steppers on the feat's own increase must address the child record, not this one.
          stepIndex: child ? state.asiSteps.indexOf(child) : index,
          hasChoice: !!childSt,
          points: childSt?.total ?? 0,
          cap: displayCap(childSt),
          remaining: childSt?.available ?? 0,
          allSpent: childSt ? childSt.available === 0 : true,
          rows: childSt ? abilityRows(childSt) : driver.featAbilityRows(record)
        });
      } else {
        sections.push({
          index,
          stepIndex: index,
          isFeat: false,
          allowFeat: st.allowFeat,
          hasChoice: true,
          hint: await advancementHint(record),
          improvementDesc: t("levelup.step.asi.improvementDesc", { points: st.total }),
          points: st.total,
          cap: displayCap(st),
          remaining: st.available,
          allSpent: st.available === 0,
          rows: abilityRows(st)
        });
      }
    }
    // Steppers and a feat panel, not an option grid — no card-density tier applies.
    //
    // A chosen feat names its sourcebook as a header pill, exactly as the subclass block does for a
    // chosen subclass: the panel below shows the feat's own text but never says which book it came
    // from, and with a shelf of content modules enabled that is the first thing a table asks.
    // `detail.source` is already resolved for the panel, so this costs nothing further.
    //
    // Only when the level holds exactly one chosen feat. A level *can* carry more than one ASI
    // decision, and one pill cannot honestly name two books — better silent than wrong.
    const featSources = sections.filter(s => s.isFeat).map(s => s.detail?.source).filter(Boolean);
    return {
      sections,
      density: "form",
      blockSource: featSources.length === 1 ? featSources[0] : null
    };
  },

  async handle(action, el, { state, driver }) {
    const record = state.asiSteps[Number(el.dataset.index)];
    if ( !record ) return;
    if ( action === "asiInc" ) await driver.adjustAsi(record, el.dataset.key, 1);
    else if ( action === "asiDec" ) await driver.adjustAsi(record, el.dataset.key, -1);
    else if ( action === "asiAbilities" ) await driver.useAsiAbilities(record);
    else if ( action === "asiFeat" ) driver.openAsiFeatPicker(record);
    else if ( action === "asiFeatCancel" ) driver.closeAsiFeatPicker(record);
    else if ( action === "asiFeatPeek" ) driver.toggleAsiFeatPeek(record);
    else if ( action === "asiFeatPick" ) await driver.pickAsiFeat(record, el.dataset.uuid);
  }
};

/**
 * Map a driver ASI state's abilities onto the background increase panel's row shape (score total,
 * "+N" bonus label, lock/stepper flags) so the level-up ASI reuses the creation look verbatim.
 */
function abilityRows(st) {
  return st.abilities.map(a => ({
    key: a.key,
    label: a.label,
    total: a.value,
    bonusLabel: a.delta ? `+${a.delta}` : "",
    locked: a.locked,
    canInc: a.canIncrease,
    canDec: a.canDecrease
  }));
}

/** The "up to +N in any one" cap for the hint — the per-ability cap, or the whole budget if uncapped. */
function displayCap(st) {
  if ( !st ) return 0;
  return Number.isFinite(st.cap) ? st.cap : st.total;
}
