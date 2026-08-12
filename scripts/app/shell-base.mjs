import { MODULE_ID, t } from "../config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * The chrome and navigation both wizard windows share — the creator ({@link module:app/creator-shell})
 * and the level-up ({@link module:levelup/levelup-shell}).
 *
 * Both are the same shape of application: a rail of steps down the left, one step's stage on the
 * right, a single event dispatcher funnelling every click into the active step's `handle()`, and a
 * footer whose Back/Next walk an index through the step list. Only the *step list* differs — the
 * creator's is a fixed registry with hidden/greyed entries, the level-up's is rebuilt every render
 * as choices reveal more choices — so that part stays in each subclass and everything around it
 * lives here.
 *
 * For a junior dev: subclasses supply the step list by overriding four small members —
 * {@link CreatorShellBase#_activeStep}, {@link CreatorShellBase#_stepCount},
 * {@link CreatorShellBase#_completeFlags} and {@link CreatorShellBase#_ctx} — plus `_finish()` for
 * whatever the footer's primary button does (Create / Apply). Everything else (dispatch, Back/Next,
 * rail reachability, the discard prompt, the spell-list filter) is inherited.
 *
 * Note the `_`-prefixed members: they are *protected* by convention — inherited and overridden by
 * the two shells, but not part of any public API. Real `#private` fields can't be shared across a
 * class boundary, which is why these aren't private.
 */

/**
 * The `[data-action]` handlers both shells wire. Foundry invokes each with `this` bound to the
 * application instance, so they delegate straight to the protected methods below.
 *
 * Deliberately a plain exported object rather than static class members: each shell spreads it into
 * its own `DEFAULT_OPTIONS`, so click routing never depends on ApplicationV2 merging static options
 * up the inheritance chain.
 */
export const SHELL_ACTIONS = {
  goto(event, target) { this._goto(Number(target.dataset.index)); },
  navNext() { this._navNext(); },
  navBack() { this._navBack(); },
  stepAction(event, target) { return this._dispatch(target.dataset.stepAction, target); },
  finish(event, target) { return this._finish(target); },
  cancel() { this.close(); }
};

/**
 * The shared `DEFAULT_OPTIONS` for a wizard window: an unframed, unpositioned div (the display-mode
 * setting layers the real framing on at launch — see {@link launchWindowOptions}) carrying the
 * action map above.
 * @param {string} id   The application id, unique per shell.
 * @returns {object}
 */
export function shellOptions(id) {
  return {
    id,
    classes: ["sogrom-creator"],
    tag: "div",
    window: { frame: false, positioned: false },
    actions: { ...SHELL_ACTIONS }
  };
}

/**
 * The shared `PARTS`: the left-hand step rail and the main stage. Splitting them lets either be
 * re-rendered alone — e.g. `render({ parts: ["rail"] })` refreshes the rail without redrawing the
 * image-heavy stage.
 * @param {string[]} scrollable   Stage selectors whose scroll position must survive a re-render.
 * @returns {object}
 */
export function railStageParts(scrollable = []) {
  return {
    rail: { id: "rail", template: `modules/${MODULE_ID}/templates/rail.hbs` },
    stage: {
      id: "stage",
      template: `modules/${MODULE_ID}/templates/stage.hbs`,
      scrollable: [".creator-stage-body", ...scrollable]
    }
  };
}

export class CreatorShellBase extends HandlebarsApplicationMixin(ApplicationV2) {

  /** Index of the step currently on screen, into whatever list the subclass walks. */
  _stepIndex = 0;

  /* -------------------------------------------- */
  /*  Subclass contract                           */
  /* -------------------------------------------- */

  /** The step object currently on screen. @returns {object|null} */
  get _activeStep() { return null; }

  /** How many steps the list holds right now. @returns {number} */
  get _stepCount() { return 0; }

  /** One boolean per step, in list order: is it complete? @returns {boolean[]} */
  _completeFlags() { return []; }

  /** The context object handed to every step's `context()` and `handle()`. @returns {object} */
  _ctx() { return {}; }

  /** The footer's primary button (Create / Apply). @param {HTMLElement} [target] */
  async _finish(target) {}    // eslint-disable-line no-unused-vars

  /* -------------------------------------------- */
  /*  Dispatch                                    */
  /* -------------------------------------------- */

  /**
   * The single funnel every UI interaction flows through. Given an action name and the element that
   * triggered it, hand off to the active step's `handle()`, then re-render — unless the handler
   * returned `false` to say "I already updated the DOM, don't re-render" (used by the Details name
   * roller, whose stage re-render would visibly rebuild the portrait images).
   * @param {string} action
   * @param {HTMLElement} el
   */
  async _dispatch(action, el) {
    this._onDispatch?.(action, el);
    const step = this._activeStep;
    const handled = step?.handle ? await step.handle(action, el, this._ctx()) : undefined;
    if ( handled === false ) return;
    this.render();
  }

  /**
   * Whether this render replaced the stage — i.e. whether the stage's listeners need re-wiring.
   *
   * `_onRender` runs after *every* render, including a partial one, but only the parts that were
   * rendered have fresh DOM. The abilities panel re-renders the rail alone on each point-buy
   * stepper press ({@link module:steps/class-step}) precisely so the image-heavy stage survives
   * untouched — and a `_onRender` that re-wires unconditionally then adds a second, third, nth set
   * of listeners to those surviving nodes. One keystroke in the search box afterwards ran the
   * filter once per press; one change on a `[data-step-change]` control dispatched (and so
   * re-rendered) that many times.
   *
   * A full render leaves `options.parts` listing every part, so this reads true in the normal case.
   * @param {object} options   The render options `_onRender` was handed.
   * @returns {boolean}
   */
  _stageRendered(options) {
    return !options?.parts || options.parts.includes("stage");
  }

  /**
   * Wire the change events the `actions` map can't: a `<select>`/`<input>` carrying
   * `[data-step-change]` dispatches through the same funnel as a click. Call from `_onRender`.
   * @param {HTMLElement} root
   */
  _wireStepChanges(root) {
    for ( const el of root.querySelectorAll("[data-step-change]") ) {
      el.addEventListener("change", ev => this._dispatch(el.dataset.stepChange, ev.currentTarget));
    }
  }

  /* -------------------------------------------- */
  /*  Navigation                                  */
  /* -------------------------------------------- */

  /**
   * A step is reachable once every step before it is complete — the core rule of both flows, which
   * is what stops a player skipping past an unfinished requirement.
   * @param {number} index
   * @param {boolean[]} [flags]
   * @returns {boolean}
   */
  _reachable(index, flags = this._completeFlags()) {
    return index === 0 || flags.slice(0, index).every(Boolean);
  }

  /** The next step index, or -1 at the end. Overridden where steps can be hidden. */
  _nextIndex() {
    return this._stepIndex + 1 < this._stepCount ? this._stepIndex + 1 : -1;
  }

  /** The previous step index, or -1 at the start. Overridden where steps can be hidden. */
  _prevIndex() {
    return this._stepIndex > 0 ? this._stepIndex - 1 : -1;
  }

  /** Jump to a step by index, if it is currently reachable. */
  _goto(index) {
    if ( !Number.isInteger(index) || !this._reachable(index) ) return;
    this._stepIndex = index;
    this.render();
  }

  /** Advance, if there is somewhere to go and the current step is finished. */
  _navNext() {
    const next = this._nextIndex();
    if ( next < 0 || !this._activeStep?.isComplete(this.state) || !this._reachable(next) ) return;
    this._stepIndex = next;
    this.render();
  }

  /** Step back. Always allowed — going backwards can't invalidate anything. */
  _navBack() {
    const prev = this._prevIndex();
    if ( prev < 0 ) return;
    this._stepIndex = prev;
    this.render();
  }

  /* -------------------------------------------- */
  /*  Shared UI behaviour                         */
  /* -------------------------------------------- */

  /**
   * Hide pick-rows that don't match the active spell filters — the name search, spell level, and
   * spell school — combined (a row must satisfy all three to show). Each control reads its value
   * straight from the DOM so any of them can drive the same pass, and nothing re-renders, so the
   * search field keeps focus while typing.
   */
  _applySpellFilters() {
    const root = this.element;
    const needle = (root.querySelector("[data-creator-search]")?.value ?? "").trim().toLowerCase();
    const level = root.querySelector("[data-spell-filter-level]")?.value ?? "";
    const school = root.querySelector("[data-spell-filter-school]")?.value ?? "";
    for ( const row of root.querySelectorAll(".creator-pickrow") ) {
      const matchesName = !needle || (row.dataset.name ?? "").toLowerCase().includes(needle);
      const matchesLevel = !level || (row.dataset.level ?? "") === level;
      const matchesSchool = !school || (row.dataset.school ?? "") === school;
      (row.closest("li") ?? row).classList.toggle("is-hidden", !(matchesName && matchesLevel && matchesSchool));
    }
    this._afterFilter(needle, !!(level || school));
  }

  /**
   * Hook run after a client-side filter pass, for a shell that wants to explain an emptied list.
   * @param {string} needle     The active name search.
   * @param {boolean} filtered  Whether a non-search filter is also narrowing.
   */
  _afterFilter(needle, filtered) {}    // eslint-disable-line no-unused-vars

  /**
   * Ask before a close that would throw away the player's work. Nothing either wizard collects is
   * written to the world until its final button, so an early close discards the lot.
   * @param {string} titleKey   i18n key for the dialog title.
   * @param {string} bodyKey    i18n key for the dialog body.
   * @returns {Promise<boolean>}  Whether the player confirmed the discard.
   */
  async _confirmDiscard(titleKey, bodyKey) {
    return DialogV2.confirm({
      window: { title: t(titleKey), icon: "fa-solid fa-triangle-exclamation" },
      content: `<p>${t(bodyKey)}</p>`,
      modal: true,
      rejectClose: false
    });
  }
}
