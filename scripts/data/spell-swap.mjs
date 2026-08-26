/**
 * Which spell swaps a level-up may offer, by rules edition.
 *
 * "Swap" here is the one-for-one replacement a class grants *when it gains a level* — not the daily
 * re-preparation a prepared caster does on a long rest, which happens outside both of our wizards.
 * The two editions draw that line in different places:
 *
 *  - **2024.** Every Spellcasting feature says you may replace one cantrip and one spell on your
 *    list whenever you gain a level in the class. Both swaps, for anyone with something to swap.
 *  - **2014.** *No* PHB class replaces a cantrip on level-up — cantrip swapping arrived with the
 *    2024 rules (Tasha's offers it as an *optional* rule, which is a house rule, not a default).
 *    Offering it to a 2014 Sorcerer, as this step used to, grants a replacement the rules never do.
 *
 * The leveled-spell swap stays on offer for every caster, in both editions, and only its wording
 * changes. A 2014 spells-known class (Bard, Ranger, Sorcerer, Warlock, and the third-caster
 * subclasses) trades a spell on level-up outright. A 2014 prepared class (Cleric, Druid, Paladin,
 * Wizard, Artificer) does it after a long rest instead — but in dnd5e a prepared spell is an
 * ordinary embedded Item, so trading one for another *is* how that list changes, and withdrawing
 * the control would remove a real capability to satisfy a label. So we fix the label.
 *
 * @see module:levelup/steps/lvl-spells-step for the step that consumes this
 */

/**
 * The 2014 classes that prepare their spells from a list each day rather than knowing a fixed set.
 * Keyed by `system.identifier`. Used only to choose the wording — never to withhold the control.
 */
const PREPARED_CASTERS_2014 = new Set(["cleric", "druid", "paladin", "wizard", "artificer"]);

/**
 * What this caster may replace when it gains a level.
 *
 * An item with no `system.source.rules` is treated as 2024 — the same default
 * {@link module:data/rules-source} applies, and it is the permissive answer, so third-party content
 * that never sets the field keeps every option rather than being quietly restricted by a table it
 * was never listed in.
 *
 * @param {Item5e|{system?: object}|null} castItem  The class *or subclass* item that casts — whatever
 *   `spellcastingItem()` resolved for the level being gained.
 * @returns {{cantrip: boolean, spell: boolean, labelKey: string}}
 *   `labelKey` is relative to the module namespace, for {@link module:config.t}.
 */
export function swapAllowance(castItem) {
  const is2014 = String(castItem?.system?.source?.rules ?? "") === "2014";
  if ( !is2014 ) return { cantrip: true, spell: true, labelKey: "levelup.step.spells.swapHint" };
  const prepared = PREPARED_CASTERS_2014.has(castItem?.system?.identifier ?? "");
  return {
    cantrip: false,
    spell: true,
    labelKey: prepared ? "levelup.step.spells.swapHintPrepared" : "levelup.step.spells.swapHint"
  };
}
