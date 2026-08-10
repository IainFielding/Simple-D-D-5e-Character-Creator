/**
 * Factory that builds an "origin" selection step (class, species, background).
 *
 * All three present a filterable grid of cards; picking one records its UUID on
 * the state and reveals its enriched description inline. Rather than repeat that
 * across three modules, each step is produced by configuring this factory with
 * the state field it writes and the card list it reads. This composition is the
 * unit of reuse here — there is no shared base Application doing the work.
 *
 * For a junior dev — this is a good place to learn the "step module" shape that EVERY step
 * in scripts/steps/ follows. A step is just a plain object the shell (creator-shell.mjs) calls:
 *   id, icon, labelKey, template  – identity + which rail entry and .hbs template it uses
 *   isComplete(state)             – may the player move past this step? drives the Next gate + tick
 *   incompleteHint(state)         – if not complete, the tooltip explaining what's missing
 *   summary(state, source)        – the short line shown under the step in the rail once chosen
 *   handle(action, el, ctx)       – react to a click/change; mutate state (return false to skip re-render)
 *   context(ctx)                  – build the data object this step's template renders with
 * Optional extras some steps add: onEnter, applicable, hideWhenInapplicable. The shell knows
 * nothing about classes or spells — it just calls these methods, so each step stays self-contained.
 *
 * @param {object} cfg
 * @param {string} cfg.id           Step id (also its rail/template key).
 * @param {string} cfg.icon         FontAwesome classes for the rail.
 * @param {string} cfg.labelKey     i18n key for the step label.
 * @param {string} cfg.field        CreatorState property holding the chosen UUID.
 * @param {string} [cfg.hintKey]    i18n key for the "nothing picked yet" Next-button hint.
 * @param {"species"|"background"} [cfg.asiSource]  Compose in the shared ability-increase panel
 *   under this origin key. Set for the species (a 2014 species grants an increase; a 2024 one does
 *   not, and then no aside renders). Omit and the step behaves as a plain grid.
 * @param {(src: import("../data/source-index.mjs").SourceIndex,
 *           state: import("../state/creator-state.mjs").CreatorState) => object[]} cfg.cards
 * @returns {object} A step module.
 */
import { resolveChoices } from "../data/choice-resolver.mjs";
import { t } from "../config.mjs";
import {
  ASI_ACTIONS, asiComplete, asiContext, asiHandle, asiHint, asiSummary
} from "./origin-abilities-panel.mjs";

export function originStep({ id, icon, labelKey, field, cards, hintKey, asiSource }) {
  return {
    id,
    icon,
    labelKey,
    template: "steps/origin",

    isComplete(state) {
      if ( !state[field] ) return false;
      return asiSource ? asiComplete(state, asiSource) : true;
    },

    /** Why Next is blocked: nothing picked yet, or increase points still to spend. */
    incompleteHint(state) {
      if ( !state[field] ) return hintKey ? t(hintKey) : null;
      return asiSource ? asiHint(state, asiSource) : null;
    },

    /** Short label shown on the rail once a choice is made, plus any increase it granted. */
    summary(state, source) {
      const name = source.card(state[field])?.name ?? "";
      if ( !name || !asiSource ) return name;
      const line = asiSummary(state, asiSource);
      return line ? `${name} · ${line}` : name;
    },

    async handle(action, el, { state, source }) {
      if ( asiSource && ASI_ACTIONS.has(action) ) return asiHandle(action, el, state, asiSource);
      if ( action !== "pick-origin" ) return;
      const uuid = el.dataset.uuid;
      // Re-clicking the active card clears it, so a player can back out of a choice.
      state[field] = state[field] === uuid ? null : uuid;
      // The step id doubles as the advancement-choice source key (e.g. "species"). This also
      // clears any ability increase the previous pick granted.
      state.resetSourceChoices(id);
      if ( asiSource && state[field] ) {
        state.originAsi[asiSource] = await source.abilityScoreIncrease(state[field]);
      }
      state.choiceCache = await resolveChoices(state, source);
    },

    async context({ state, source }) {
      const selected = state[field];
      const detail = selected ? await source.detail(selected) : null;
      const groups = selected ? await source.advancementGroups(selected) : null;
      const list = cards(source, state).map(c => ({ ...c, selected: c.uuid === selected }));

      // Resolve (and cache) the increase config for the active pick, so the panel and the
      // synchronous completion check share one source of truth.
      if ( asiSource && selected && state.originAsi[asiSource] === undefined ) {
        state.originAsi[asiSource] = await source.abilityScoreIncrease(selected);
      }

      return {
        cards: list,
        count: list.length,
        hasSelection: !!selected,
        selectedName: detail?.name ?? "",
        detail,
        groups,
        // Null unless this origin both composes the panel and actually grants an increase; the
        // template renders no aside in that case and the description widens into the free column.
        abilities: (asiSource && selected) ? asiContext(state, asiSource) : null
      };
    }
  };
}
