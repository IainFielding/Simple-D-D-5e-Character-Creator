import {
  MODULE_ID, SETTINGS, DEFAULTS, MULTICLASS_MODES, bannedAlignments, emberActive, t
} from "../config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The GM-facing House Rules window, opened from the module's settings menu (registered via
 * `game.settings.registerMenu` in main.mjs).
 *
 * One screen for the settings that constrain *what a player may build*, as opposed to the flat
 * settings list's UI toggles and announcements. Everything here answers "may they?" or "how much?" —
 * the ability-score economy, whether multiclassing is on the table, and which alignments the table
 * allows — which is why point-buy budget, roll formula and multiclassing moved in here rather than
 * staying scattered among the launch-button and chat-summary toggles.
 *
 * Unlike {@link module:app/store-config}, there is no working copy to maintain: every control is a
 * real named form field, so Foundry's own form serialisation carries the values straight to
 * {@link HouseRulesApp.#onSubmit}. Closing without saving therefore discards nothing more than the
 * unsubmitted inputs.
 */
export class HouseRulesApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "sogrom-house-rules",
    tag: "form",
    classes: ["sogrom-house-rules", "standard-form"],
    window: {
      title: `${MODULE_ID}.houseRules.title`,
      icon: "fa-solid fa-gavel",
      contentClasses: ["standard-form"]
    },
    position: { width: 620, height: "auto" },
    form: {
      handler: HouseRulesApp.#onSubmit,
      closeOnSubmit: true
    }
  };

  // Each PART must render exactly one root element, so the fields live in their own template and
  // the submit button uses Foundry's generic footer part (which builds its buttons from `buttons`).
  static PARTS = {
    fields: { template: `modules/${MODULE_ID}/templates/house-rules.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** @override */
  async _prepareContext() {
    const banned = new Set(bannedAlignments());
    return {
      // Ember runs its own ability-score step before the hand-off ever reaches us, so a budget or a
      // roll formula set here would never be honoured — the same reason these two were hidden from
      // the flat settings list under Ember before they moved in here.
      showAbilities: !emberActive(),
      pointBuyBudget: game.settings.get(MODULE_ID, SETTINGS.pointBuyBudget),
      rollFormula: game.settings.get(MODULE_ID, SETTINGS.rollFormula),
      manualAbilities: game.settings.get(MODULE_ID, SETTINGS.manualAbilities),
      // `selected` is computed here rather than compared in the template, matching how every other
      // <select> in this module is built (see parts/abilities-panel.hbs and store-config.hbs).
      multiclassOptions: MULTICLASS_MODES.map(value => ({
        value,
        label: t(`settings.allowMulticlass.${value}`),
        selected: value === game.settings.get(MODULE_ID, SETTINGS.multiclass)
      })),
      // Offered in CONFIG order (lawful good through chaotic evil) rather than alphabetically, so
      // the grid reads as the familiar 3x3 rather than a shuffled list.
      alignments: Object.entries(CONFIG.DND5E?.alignments ?? {}).map(([key, label]) => ({
        key,
        label: game.i18n.localize(label),
        banned: banned.has(key)
      })),
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: t("houseRules.save") }]
    };
  }

  /**
   * Write the five settings.
   *
   * Each value is guarded rather than trusted: these are number and string inputs a GM can empty or
   * mistype, and a blank point-buy budget or roll formula reaching the Abilities step would break
   * character creation for the whole table rather than just ignoring one bad edit.
   *
   * The alignment checkboxes are named `banned.<key>`, which Foundry's `expandObject` turns into a
   * `{key: bool}` map — the keys are `CONFIG.DND5E.alignments` keys and so contain no dots, unlike
   * the store's UUID-keyed rows which had to avoid form names entirely.
   * @this {HouseRulesApp}
   */
  static async #onSubmit(_event, _form, formData) {
    const data = foundry.utils.expandObject(formData.object);

    // Only when the fieldset was actually on screen. Under Ember it isn't rendered at all, so its
    // fields arrive absent — and writing them anyway would quietly reset a budget, a formula and a
    // home rule the GM never saw, let alone changed.
    if ( !emberActive() ) {
      const budget = Number(data.pointBuyBudget);
      await game.settings.set(MODULE_ID, SETTINGS.pointBuyBudget,
        Number.isFinite(budget) && (budget > 0) ? Math.round(budget) : DEFAULTS.pointBuyBudget);

      const formula = String(data.rollFormula ?? "").trim();
      await game.settings.set(MODULE_ID, SETTINGS.rollFormula, formula || DEFAULTS.rollFormula);

      // An unchecked checkbox is absent from the form data entirely, so this reads as false rather
      // than falling back to the default — which is what makes turning the rule back off work.
      await game.settings.set(MODULE_ID, SETTINGS.manualAbilities, !!data.manualAbilities);
    }

    await game.settings.set(MODULE_ID, SETTINGS.multiclass,
      MULTICLASS_MODES.includes(data.multiclass) ? data.multiclass : DEFAULTS.multiclass);

    await game.settings.set(MODULE_ID, SETTINGS.bannedAlignments,
      Object.entries(data.banned ?? {}).filter(([, on]) => on).map(([key]) => key));
  }
}
