import { t } from "../../config.mjs";
import { advancementTitle } from "../../data/advancement-util.mjs";
import { atLevel, advancementHint } from "../levelup-state.mjs";

/**
 * Spell grants with a choosable casting ability — the `ItemGrant` advancements a species lineage
 * surfaces at a class level (e.g. a High Elf's Detect Magic at level 3, Misty Step at level 5),
 * each of which lets the player cast the granted spell with Intelligence, Wisdom, or Charisma.
 *
 * The spell is already granted to the driver's clone with a sensible default ability (so the clone
 * is always valid), so this block never blocks Next — it just lets the player re-point the casting
 * ability, applied straight to the granted spell via the advancement's own apply.
 */
export const grantStep = {
  id: "grant",
  icon: "fa-solid fa-wand-sparkles",
  labelKey: "levelup.step.grant.label",
  template: "levelup/grant",

  isCompleteAt(state, level) {
    // An ability is always pre-selected, so the block is satisfied on sight; it never gates a level.
    return atLevel(state.grantSteps, level).every(r => !!state.driver.grantState(r).ability);
  },

  async sectionsAt({ state, driver }, level) {
    const records = atLevel(state.grantSteps, level);
    if ( !records.length ) return null;
    const single = records.length === 1;
    // The leveled class's spellcasting ability is the recommended pick, so the player can align a
    // species/background lineage spell's casting ability with their class — mirroring how the
    // creation choices screen stars the class ability (see choice-resolver.mjs).
    const hint = spellAbilityHint(state);
    const sections = await Promise.all(records.map(async record => {
      const st = driver.grantState(record);
      return {
        index: state.grantSteps.indexOf(record),
        title: advancementTitle(record.advancement) || record.item?.name || t("levelup.step.grant.label"),
        hint: await advancementHint(record),
        prompt: t("levelup.step.grant.prompt"),
        spells: st.spells,
        abilities: st.abilities.map(key => {
          const opt = {
            key,
            label: CONFIG.DND5E.abilities[key]?.label ?? key,
            selected: key === st.ability
          };
          if ( hint && key === hint.ability ) {
            opt.recommended = true;
            opt.recommendTip = t("choice.recommendedAbility", { class: hint.className });
          }
          return opt;
        }),
        // A lone block shows its title in the header rather than repeating it inside.
        collapsed: single
      };
    }));
    return {
      blockLabel: single ? sections[0].title : null,
      sections
    };
  },

  async handle(action, el, { state, driver }) {
    const record = state.grantSteps[Number(el.dataset.index)];
    if ( !record ) return;
    if ( action === "grantAbility" && el.dataset.key ) await driver.applyGrantAbility(record, el.dataset.key);
  }
};

/**
 * The spellcasting ability to recommend for a granted spell: the configured ability of a caster
 * class on the character, preferring the class being levelled. Null when the character has no
 * spellcasting class (so nothing is starred). Reads the pre-commit clone or the committed actor,
 * matching where the rest of the step reads from.
 * @param {import("../levelup-state.mjs").LevelUpState} state
 * @returns {{ ability: string, className: string }|null}
 */
function spellAbilityHint(state) {
  const source = state.committed ? state.actor : state.driver.clone;
  const leveled = state.classItem ? source.items.get(state.classItem.id) : null;
  const classes = source.items.filter(i => i.type === "class");
  for ( const cls of [leveled, ...classes] ) {
    const ability = cls?.system?.spellcasting?.ability;
    if ( ability ) return { ability, className: cls.name };
  }
  return null;
}
