import {
  MODULE_ID, SETTINGS, DEFAULTS, HP_MODES, SUMMARY_MODES, levelUpEnabled, t
} from "../config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The GM-facing Level-Up Options window, opened from the module's settings menu (registered via
 * `game.settings.registerMenu` in main.mjs).
 *
 * Everything about levelling in one place: where the flow can be started from, what it offers for
 * hit points, and what it announces afterwards. Seven settings that were scattered down the flat
 * list between unrelated creation ones — a GM tuning level-ups had to pick them out of four
 * separate stretches of that list.
 *
 * Multiclassing deliberately stays in {@link module:app/house-rules}: it is only reachable from the
 * level-up flow, but the question it answers ("may a player build this?") is a house rule, not a
 * level-up option.
 *
 * Same shape as {@link module:app/house-rules}: every control is a real named form field, so
 * Foundry's own serialisation carries the values straight to {@link LevelUpOptionsApp.#onSubmit}
 * and there is no working copy to maintain.
 */
export class LevelUpOptionsApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "sogrom-levelup-options",
    tag: "form",
    classes: ["sogrom-levelup-options", "standard-form"],
    window: {
      title: `${MODULE_ID}.levelUpOptions.title`,
      icon: "fa-solid fa-trophy-star",
      contentClasses: ["standard-form"]
    },
    position: { width: 620, height: "auto" },
    form: {
      handler: LevelUpOptionsApp.#onSubmit,
      closeOnSubmit: true
    }
  };

  // Each PART must render exactly one root element, so the fields live in their own template and
  // the submit button uses Foundry's generic footer part (which builds its buttons from `buttons`).
  static PARTS = {
    fields: { template: `modules/${MODULE_ID}/templates/levelup-options.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /**
   * Build the `{value, label, selected}` option list for one of the choice settings.
   * Computed here rather than compared in the template, matching how every other `<select>` in this
   * module is built (see parts/abilities-panel.hbs and store-config.hbs).
   * @param {string[]} values     The setting's allowed values, in display order.
   * @param {string} key          The setting key, for reading the current value.
   * @param {(v: string) => string} labelFor
   */
  #options(values, key, labelFor) {
    const current = game.settings.get(MODULE_ID, key);
    return values.map(value => ({ value, label: labelFor(value), selected: value === current }));
  }

  /** @override */
  async _prepareContext() {
    const get = key => game.settings.get(MODULE_ID, key);
    // dnd5e's HP mode values are hyphenated but their i18n keys are camelCase.
    const hpLabel = { "choice": "choice", "average-roll": "averageRoll", "average": "average" };
    return {
      // Everything here is inert when the module is not doing level-ups at all; say so rather than
      // letting a GM tune a flow that will never run.
      levelUpOff: !levelUpEnabled(),
      showLevelUpButton: get(SETTINGS.levelUpButton),
      showLevelUpHeaderMenu: get(SETTINGS.headerMenu),
      showContextMenu: get(SETTINGS.contextMenu),
      hpModes: this.#options(HP_MODES, SETTINGS.levelUpHpMode,
        v => t(`settings.levelUpHpMode.${hpLabel[v]}`)),
      levelUpHpRollToChat: get(SETTINGS.levelUpHpRollToChat),
      summaryModes: this.#options(SUMMARY_MODES, SETTINGS.levelUpSummary,
        v => t(`settings.levelUpSummary.${v}`)),
      readyModes: this.#options(SUMMARY_MODES, SETTINGS.levelUpReadyNotice,
        v => t(`settings.levelUpReadyNotice.${v}`)),
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: t("levelUpOptions.save") }]
    };
  }

  /**
   * Write the seven settings.
   *
   * The two select values are guarded against anything outside their known set — a hand-edited or
   * stale stored value reaching `levelUpHpMode()` or `levelUpSummaryMode()` would otherwise fall
   * through their own guards to the default anyway, so writing a valid one keeps the stored world
   * data honest rather than merely surviving it.
   * @this {LevelUpOptionsApp}
   */
  static async #onSubmit(_event, _form, formData) {
    const data = formData.object;
    const set = (key, value) => game.settings.set(MODULE_ID, key, value);
    const oneOf = (allowed, value, fallback) => (allowed.includes(value) ? value : fallback);

    await set(SETTINGS.levelUpButton, !!data.showLevelUpButton);
    await set(SETTINGS.headerMenu, !!data.showLevelUpHeaderMenu);
    await set(SETTINGS.contextMenu, !!data.showContextMenu);
    await set(SETTINGS.levelUpHpMode, oneOf(HP_MODES, data.levelUpHpMode, DEFAULTS.levelUpHpMode));
    await set(SETTINGS.levelUpHpRollToChat, !!data.levelUpHpRollToChat);
    await set(SETTINGS.levelUpSummary,
      oneOf(SUMMARY_MODES, data.levelUpSummary, DEFAULTS.levelUpSummary));
    await set(SETTINGS.levelUpReadyNotice,
      oneOf(SUMMARY_MODES, data.levelUpReadyNotice, DEFAULTS.levelUpReadyNotice));
  }
}
