import { t } from "../../config.mjs";
import { advancementTitle } from "../../data/advancement-util.mjs";
import { atLevel, advancementHint } from "../levelup-state.mjs";
import { choiceBlurb } from "../../data/choice-resolver.mjs";

/**
 * Trait choices — the choice-bearing `Trait` advancements a level grants. Weapon Mastery is the
 * common one (choose N weapons to master), but the same screen serves any trait pick (a bonus
 * language, an extra skill, …). Each decision is a single selectable grid; picks apply straight to
 * the driver's clone via the advancement's own apply/reverse, so Review and the committed actor
 * reflect exactly what is shown here.
 *
 * Unselecting a pick frees a slot and re-enables the pool — which is also how the player swaps one
 * choice for another before applying.
 */

/**
 * Bucket trait options by their category (Simple vs Martial Weapons, …), preserving the options'
 * existing sort within each. A single category yields one unlabelled group, so non-weapon traits
 * (or pools that don't split) render as a plain grid.
 * @param {object[]} options   The flat option list from {@link LevelUpDriver#traitOptions}.
 * @returns {{ key: string, label: string, options: object[] }[]}
 */
function groupOptions(options) {
  const groups = new Map();
  for ( const opt of options ) {
    if ( !groups.has(opt.groupKey) ) groups.set(opt.groupKey, { key: opt.groupKey, label: opt.groupLabel, options: [] });
    groups.get(opt.groupKey).options.push(opt);
  }
  const list = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
  // A lone group needs no header — drop its label so the template skips it.
  if ( list.length === 1 ) list[0].label = "";
  return list;
}

export const traitStep = {
  id: "traits",
  icon: "fa-solid fa-khanda",
  labelKey: "levelup.step.traits.label",
  template: "levelup/trait",

  isCompleteAt(state, level) {
    // `exhausted` is the escape hatch for a quota the pool can no longer fill: refreshed by
    // sectionsAt each render — the shell builds the active screen before it reads these flags — it
    // counts as settled. Two things reach it. A pool with nothing left to pick ("choose 2 weapons"
    // when the character already masters all but one); and a *grant* the character already
    // satisfies, which the system never records in `value.chosen` (unfulfilledChoices excludes
    // already-owned traits), so `current` can never reach the `max` that counts it. The native flow
    // has the same hole and walks past it the same way.
    return atLevel(state.traitSteps, level).every(r => state.driver.traitState(r).full || r.exhausted);
  },

  async sectionsAt({ state, driver }, level) {
    const records = atLevel(state.traitSteps, level);
    if ( !records.length ) return null;
    // One block per decision, always: a level granting several (a new character's "Path Skills",
    // "Path Language", "Cultural Proficiencies", …) gets a collapsible panel each, so the pools
    // stay visibly separate — an option greying out because another decision already took it is
    // obvious when the two are distinct panels, and baffling when they share one.
    const blocks = [];
    for ( const record of records ) {
      const st = driver.traitState(record);
      const options = await driver.traitOptions(record);
      record.exhausted = !st.full && !options.some(o => !o.owned && !o.selected && !o.disabled);
      const section = {
        index: state.traitSteps.indexOf(record),
        title: advancementTitle(record.advancement) || t("levelup.step.traits.choose"),
        // The authored description when there is one; otherwise the creator's generated blurb, so
        // every decision reads with a sentence (Weapon Mastery ships without a hint, for example).
        hint: (await advancementHint(record)) || choiceBlurb({
          type: "Trait",
          mode: record.advancement.configuration?.mode || "default",
          poolType: (options[0]?.key ?? "").split(":")[0],
          count: st.max
        }),
        count: t("levelup.step.traits.count", { current: st.current, max: st.max }),
        complete: st.full || record.exhausted,
        groups: groupOptions(options),
        // The block header carries the title and count, so the body never repeats them.
        collapsed: true
      };
      // Density per decision: art-less keyword pools (languages) become inline chips; a big iconned
      // pool (Weapon Mastery's many weapons) packs into compact cards.
      const count = section.groups.reduce((n, g) => n + g.options.length, 0);
      const anyImg = section.groups.some(g => g.options.some(o => o.img));
      blocks.push({
        key: record.advancement.id ?? String(section.index),
        blockLabel: section.title,
        blockStatus: section.count,
        complete: section.complete,
        density: !anyImg ? "chip" : (count >= 9 ? "compact" : "standard"),
        sections: [section]
      });
    }
    return blocks;
  },

  async handle(action, el, { state, driver }) {
    const record = state.traitSteps[Number(el.dataset.index)];
    if ( !record ) return;
    if ( action === "traitToggle" && el.dataset.key ) await driver.toggleTrait(record, el.dataset.key);
  }
};
