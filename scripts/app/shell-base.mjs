import { MODULE_ID, t, fireHook } from "../config.mjs";
import { sourceDetails, rulesDetails } from "./source-details.mjs";
import { buildCompare, MAX_PINS, PinSet } from "./compare.mjs";
import { rulesPageFor } from "../data/rules-source.mjs";

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
  cancel() { this.close(); },
  openSourceDetails(event, target) { return this._openSourceDetails(target.dataset.uuid); },
  openRulesDetails(event, target) {
    return this._openRulesDetails(target.dataset.topic, target.dataset.edition || null);
  },
  closeSourceDetails() { this._closeSourceDetails(); },
  togglePin(event, target) { this._togglePin(target); },
  openCompare(event, target) { return this._openCompare(target.dataset.category); },
  unpinCompare(event, target) { return this._unpinCompare(target.dataset.category, target.dataset.uuid); },
  closeCompare() { this._closeCompare(); }
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

/**
 * The creator's own `PARTS`: a full-width top bar, the dossier column, and the stage.
 *
 * The creator and the level-up window used to share {@link railStageParts}, because both were a
 * step list plus a stage. They aren't the same shape any more. The creator assembles one character
 * across many steps, so its step list is folded into a dossier that shows the character so far
 * (templates/dossier.hbs); the level-up window applies advancements to a character that already
 * exists, where there is no "so far" to show, and keeps the plain rail.
 *
 * Three parts rather than two so the top bar can span both columns, and so a cheap re-render can
 * refresh the dossier and the meter without touching the image-heavy stage.
 * @param {string[]} scrollable   Stage selectors whose scroll position must survive a re-render.
 * @returns {object}
 */
export function dossierStageParts(scrollable = []) {
  return {
    topbar: { id: "topbar", template: `modules/${MODULE_ID}/templates/topbar.hbs` },
    dossier: { id: "dossier", template: `modules/${MODULE_ID}/templates/dossier.hbs`, scrollable: [""] },
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

  /**
   * The public hook this wizard announces step changes on — `HOOKS.creationStepChanged` for the
   * creator, `HOOKS.levelUpStepChanged` for the level-up. Null means "don't announce", which is
   * what a subclass that hasn't opted in gets.
   *
   * Both wizards move through steps in exactly one place ({@link CreatorShellBase#_leaveStepFor}),
   * so naming the hook is all a subclass needs to do to be observable.
   * @returns {string|null}
   */
  get _stepChangeHook() { return null; }

  /** The state object handed to step-change listeners (each subclass calls its own `state`). */
  get _hookState() { return null; }

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

  /**
   * Leave the step currently on screen. The book-page overlay belongs to the entry that opened it,
   * and the footer's Back/Next sit outside the stage body it covers — so without this, paging on
   * with it open carried the previous step's page over the new one.
   *
   * Every navigation path in both wizards funnels through here — Back, Next, a rail click, and the
   * creator's programmatic `gotoStep` — which makes it the one place a step change can be
   * announced from. See {@link CreatorShellBase#_stepChangeHook}.
   * @param {number} index
   */
  _leaveStepFor(index) {
    const from = this._stepIndex;
    this._sourceDetails = null;
    // Same reasoning for the comparison grid: it belongs to the picker that opened it, and the
    // footer sits outside the surface it covers.
    this._compare = null;
    this._stepIndex = index;
    // Announce after the index has moved but before the render, so a listener reading the shell
    // sees the step it is being told about rather than the one being left.
    const hook = this._stepChangeHook;
    if ( hook && (from !== index) ) {
      fireHook(hook, { app: this, state: this._hookState, from, to: index, step: this._activeStep });
    }
    this.render();
  }

  /** Jump to a step by index, if it is currently reachable. */
  _goto(index) {
    if ( !Number.isInteger(index) || !this._reachable(index) ) return;
    this._leaveStepFor(index);
  }

  /** Advance, if there is somewhere to go and the current step is finished. */
  _navNext() {
    const next = this._nextIndex();
    if ( next < 0 || !this._activeStep?.isComplete(this.state) || !this._reachable(next) ) return;
    this._leaveStepFor(next);
  }

  /** Step back. Always allowed — going backwards can't invalidate anything. */
  _navBack() {
    const prev = this._prevIndex();
    if ( prev < 0 ) return;
    this._leaveStepFor(prev);
  }

  /* -------------------------------------------- */
  /*  Shared view-model                           */
  /* -------------------------------------------- */

  /**
   * The top bar's progress meter, for any window that renders `templates/topbar.hbs`.
   *
   * Lives here rather than in the creator because the Ember hand-off renders the same top bar (see
   * {@link module:levelup/levelup-shell}), and this arithmetic has already been wrong in both
   * directions — it is exactly the kind of thing that must not exist twice.
   *
   * The fill measures *position*: how far along the flow the player is.
   *
   * It began as complete-lines over visible-lines, which could never fill, because Review is a
   * summary rather than a task and is deliberately never marked complete — so the bar sat at eight
   * ninths on the screen where the character was finished. The fix was to measure settled required
   * steps instead, which fills exactly when nothing is outstanding — and that produced the opposite
   * lie: with every required step done and only Review left, the bar reads 100% while the counter
   * beside it reads "Step 9 of 10". A full bar next to a counter that is not full is a contradiction
   * the player has to resolve, and the reading they take from it — "I'm finished" — is the wrong one,
   * because they have not pressed Create.
   *
   * Both attempts were trying to make one bar answer two questions. It only has to answer the one
   * its own neighbour asks. The counter next to it says where you are; the bar is the graphic of
   * that counter, and the two now cannot disagree — 9 of 10 draws nine tenths, and the bar is full
   * on Review, which is the last step and where the old bug was.
   *
   * Completion is not lost: it is what the teal outstanding chip immediately to the right reports,
   * and what the ticks down the dossier report per step. Position and completion are genuinely
   * different questions — a player can go back and leave a finished step behind them unfinished
   * again — so they get one readout each instead of one readout each other's shape.
   * @param {object[]} lines     One per visible step, each carrying an `active` flag.
   * @param {object[]} missing   Required steps not yet complete.
   * @returns {object}
   */
  _progressContext(lines, missing) {
    const visible = lines.length;
    const current = Math.max(lines.findIndex(l => l.active) + 1, 1);
    const outstanding = missing.length;
    return {
      // These describe the bar, so they are the position counts the label beside it uses.
      total: visible,
      done: current,
      percent: visible ? Math.round((current / visible) * 100) : 100,
      position: t("nav.position", { current, total: visible }),
      outstanding,
      outstandingLabel: t("dossier.outstanding", { count: outstanding })
    };
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

  /* -------------------------------------------- */
  /*  Source book details                         */
  /* -------------------------------------------- */

  /**
   * The book page currently open over the stage, or null. Read into both shells' contexts, where
   * `templates/stage.hbs` renders it as a full-surface overlay.
   * @type {{name: string, img: string, pageName: string, html: string, fallback: boolean}|null}
   */
  _sourceDetails = null;

  /**
   * Open the source book's own page for a class or subclass over the current step — the "Full
   * Details" control on a detail pane. Both wizards share this: the creator uses it for the class
   * being chosen, the level-up for a subclass just gained, where the pick pane is far too short to
   * hold a progression table.
   *
   * An item that resolves to nothing leaves the overlay closed rather than opening an empty one;
   * the control is normally hidden in that case anyway.
   * @param {string} uuid   Compendium uuid of the class/subclass.
   */
  async _openSourceDetails(uuid) {
    if ( !uuid ) return;
    const item = await fromUuid(uuid).catch(() => null);
    const details = item ? await sourceDetails(item) : null;
    if ( !details ) {
      ui.notifications?.info(t("common.sourceDetails.none"));
      return;
    }
    this._sourceDetails = details;
    // One overlay at a time — see {@link CreatorShellBase#_openCompare} for the other half.
    this._compare = null;
    this.render();
  }

  /**
   * Open the rulebook's own page for a topic over the current step — the "Read the rules" control a
   * step shows when the world has a book covering what it is asking about.
   *
   * Shares the overlay (and its Escape handling) with {@link _openSourceDetails}: to a player these
   * are one feature, and only the source of the page differs — an item's own class page there, a
   * chapter of the rulebook here. See {@link module:data/rules-source} for the topic map.
   * @param {string} topic                  One of `RULE_TOPICS`.
   * @param {"2014"|"2024"|null} edition    The character's rules edition.
   */
  async _openRulesDetails(topic, edition) {
    if ( !topic ) return;
    const page = await rulesPageFor(topic, edition);
    const details = page ? await rulesDetails(page) : null;
    if ( !details ) {
      ui.notifications?.info(t("common.rulesDetails.none"));
      return;
    }
    this._sourceDetails = details;
    // One overlay at a time — see {@link CreatorShellBase#_openCompare} for the other half.
    this._compare = null;
    this.render();
  }

  /** Close the book-page overlay and return to the step underneath. */
  _closeSourceDetails() {
    this._sourceDetails = null;
    this.render();
  }

  /**
   * Wire an open overlay's keyboard dismissal. Called from each shell's `_onRender`; Escape is the
   * expected way out of anything covering the screen, and without it the only exit is the button.
   *
   * Both overlays — the book page and the comparison grid — are handled here because they are the
   * same interaction: one absolute surface over the stage body, closed by its own button or by
   * Escape. Only one can be open at a time (opening either clears the other), so the first match
   * wins and there is never a contest over the key.
   * @param {HTMLElement} root
   */
  _wireOverlays(root) {
    const overlays = [
      [".creator-source-details", ".creator-source-details-close", () => this._closeSourceDetails()],
      [".creator-compare", ".creator-compare-close", () => this._closeCompare()]
    ];
    for ( const [selector, closer, close] of overlays ) {
      const overlay = root.querySelector(selector);
      if ( !overlay ) continue;
      overlay.addEventListener("keydown", ev => {
        if ( ev.key !== "Escape" ) return;
        ev.preventDefault();
        ev.stopPropagation();
        close();
      });
      // Take focus so Escape reaches the handler above without the player clicking first.
      overlay.querySelector(closer)?.focus();
      return;
    }
  }

  /* -------------------------------------------- */
  /*  Comparison                                  */
  /* -------------------------------------------- */

  /**
   * The options pinned for comparison in this window, per pick category. Session-scoped and never
   * written anywhere — see {@link module:app/compare}.
   * @type {PinSet}
   */
  pins = new PinSet();

  /**
   * The comparison grid currently open over the stage, or null. Read into both shells' contexts,
   * where `templates/stage.hbs` renders it as a full-surface overlay beside the book page.
   * @type {?object}
   */
  _compare = null;

  /**
   * Pin or unpin one option, without a re-render.
   *
   * Deliberately hand-patched rather than rendered. Pinning happens inside the picker drawer, where
   * a re-render would rebuild several dozen compendium icons and — worse — discard whatever the
   * player has typed into the search box, which is very often how they found the second thing they
   * want to compare. Two elements change: the row's own button, and the toolbar's compare control.
   * @param {HTMLElement} target   The pin button that was clicked.
   */
  _togglePin(target) {
    const { category, uuid } = target.dataset;
    const outcome = this.pins.toggle(category, uuid);
    if ( outcome === "invalid" ) return;
    if ( outcome === "full" ) {
      ui.notifications?.warn(t("compare.full", { max: MAX_PINS }));
      return;
    }
    const pinned = outcome === "added";
    target.classList.toggle("is-pinned", pinned);
    target.setAttribute("aria-pressed", String(pinned));
    target.dataset.tooltip = t(pinned ? "compare.unpin" : "compare.pin");

    const control = this.element.querySelector(`[data-action="openCompare"][data-category="${category}"]`);
    if ( !control ) return;
    const count = this.pins.count(category);
    const canCompare = this.pins.canCompare(category);
    control.disabled = !canCompare;
    control.dataset.tooltip = canCompare ? t("compare.tooltip") : t("compare.needTwo");
    const label = control.querySelector(".creator-compare-btn-label");
    if ( label ) label.textContent = count ? t("compare.openCount", { count }) : t("compare.open");
  }

  /**
   * Open the comparison grid for a category over the current step.
   *
   * Nothing is pinned to it: the grid is built from the pins as they stand at the moment it opens,
   * so unpinning a column inside it rebuilds rather than mutating what is on screen.
   * @param {string} category   One of `COMPARE_CATEGORIES`.
   */
  async _openCompare(category) {
    const compare = await buildCompare(category, this.pins.list(category), this._ctx().source);
    if ( !compare ) {
      // Reachable when pinned content has gone away since it was pinned (a module disabled
      // mid-session), which leaves fewer than two resolvable columns.
      ui.notifications?.info(t("compare.none"));
      return;
    }
    // One overlay at a time: a book page opened from the detail pane underneath would otherwise
    // still be sitting there when the grid is closed.
    this._sourceDetails = null;
    this._compare = compare;
    this.render();
  }

  /**
   * Drop one column from the open comparison. The grid rebuilds, and closes itself once fewer than
   * two columns are left — a one-column comparison is just the detail pane with extra steps.
   * @param {string} category
   * @param {string} uuid
   */
  async _unpinCompare(category, uuid) {
    this.pins.toggle(category, uuid);
    if ( this.pins.canCompare(category) ) return this._openCompare(category);
    this._closeCompare();
  }

  /** Close the comparison and return to the picker underneath, pins intact. */
  _closeCompare() {
    this._compare = null;
    this.render();
  }

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
