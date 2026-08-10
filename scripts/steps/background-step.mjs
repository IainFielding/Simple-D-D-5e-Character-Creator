import { ABILITIES, t } from "../config.mjs";
import { resolveChoices } from "../data/choice-resolver.mjs";
import {
  ASI_ACTIONS, asiComplete, asiContext, asiHandle, asiHint, asiSummary, increasedAbilities
} from "./origin-abilities-panel.mjs";

/**
 * The Background step. Like the Class step, it pairs the origin card grid with a
 * statistics aside: a 2024 background grants an ability-score increase (typically
 * three points spread across a short list of abilities, capped at +2 each), and
 * the player allocates it here rather than later in the advancement prompt.
 *
 * The aside itself is {@link module:steps/origin-abilities-panel}, shared with the Species step —
 * under the 2014 rules the increase sits on the species instead, so both steps need the same panel
 * and neither needs it unconditionally. A background with no increase (any 2014 one) resolves to a
 * null panel context and the aside is not rendered at all.
 */
export const backgroundStep = {
  id: "background",
  icon: "fa-solid fa-feather",
  labelKey: "step.background.label",
  template: "steps/background",

  isComplete(state) {
    if ( !state.backgroundUuid ) return false;
    return asiComplete(state, "background");
  },

  /** Why Next is blocked: no background, or ability-increase points still to spend. */
  incompleteHint(state) {
    if ( !state.backgroundUuid ) return t("step.background.hint");
    return asiHint(state, "background");
  },

  /** Rail summary: background name, then the chosen increases beneath it. */
  summary(state, source) {
    const name = source.card(state.backgroundUuid)?.name;
    if ( !name ) return "";
    const line = asiSummary(state, "background");
    return line ? `${name} · ${line}` : name;
  },

  async handle(action, el, { state, source }) {
    if ( action === "pick-origin" ) {
      const uuid = el.dataset.uuid;
      // Re-clicking the active card clears it, so a player can back out of a choice.
      state.backgroundUuid = state.backgroundUuid === uuid ? null : uuid;
      // Clears the previous background's advancement picks *and* its ability allocation.
      state.resetSourceChoices("background");
      if ( state.backgroundUuid ) state.originAsi.background = await source.abilityScoreIncrease(uuid);
      state.choiceCache = await resolveChoices(state, source);
      return;
    }

    if ( ASI_ACTIONS.has(action) ) asiHandle(action, el, state, "background");
  },

  async context({ state, source }) {
    const selected = state.backgroundUuid;
    const detail = selected ? await source.detail(selected) : null;
    const groups = selected ? await source.advancementGroups(selected) : null;

    // Tag each card with the abilities its increase can raise (space-joined, for the
    // client-side filter's `data-abilities`), drawn from the same cached ASI config the
    // aside panel uses. The ASI records are already warmed, so these resolve instantly.
    // Scoped to the chosen class's edition: class is the first step, so a 2014 class is already
    // known here and must not be offered the 2024 backgrounds. See `SourceIndex#matchesRules`.
    const cards = source.backgrounds({ rules: source.rulesOf(state.classUuid) });
    const list = await Promise.all(cards.map(async c => {
      const asi = await source.abilityScoreIncrease(c.uuid);
      return { ...c, selected: c.uuid === selected, abilities: increasedAbilities(asi).join(" ") };
    }));

    // Resolve (and cache) the increase config for the active background, so the panel
    // and the completion check share one source of truth.
    if ( selected && state.originAsi.background === undefined ) {
      state.originAsi.background = await source.abilityScoreIncrease(selected);
    }

    return {
      cards: list,
      count: list.length,
      hasSelection: !!selected,
      detail,
      groups,
      abilityOptions: ABILITIES.map(key => ({ value: key, label: abilityLabel(key) })),
      // Null when the chosen background grants no increase (every 2014 one) — the template then
      // renders no aside and the description widens into the freed column.
      abilities: selected ? asiContext(state, "background") : null
    };
  }
};

const abilityLabel = key => CONFIG.DND5E?.abilities?.[key]?.label ?? key.toUpperCase();
