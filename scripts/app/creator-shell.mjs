import { MODULE_ID, tpl, t, log, ABILITIES, formatMod } from "../config.mjs";
import { CreatorShellBase, shellOptions, dossierStageParts, SHELL_ACTIONS } from "./shell-base.mjs";
import { illuminatePages } from "./page-illumination.mjs";
import { CreatorState } from "../state/creator-state.mjs";
import { STEPS, REQUIRED_STEPS } from "../steps/registry.mjs";
import { getSources, warmSources, onWarmProgress, isStale, invalidateSources } from "../data/source-cache.mjs";
import { assembleActor } from "../build/actor-assembler.mjs";
import { launchLevelUpTo } from "../levelup/intercept.mjs";

/**
 * The creator window. Deliberately thin: it owns which step is active and what is reachable, then
 * delegates all per-step data and behaviour to the step modules. It contains no
 * class/ability/species preparation logic of its own — that lives in scripts/steps/*.
 *
 * The window chrome, the click dispatcher, Back/Next and the discard prompt are all inherited from
 * {@link CreatorShellBase}, shared with the level-up window; what's left here is the creator's own
 * step model (a fixed registry whose entries can be hidden or greyed) and the Create button.
 *
 * For a junior dev: this is a Foundry ApplicationV2 subclass — i.e. a window. The three things that
 * make it tick are the static config blocks just below plus `_prepareContext`:
 *   DEFAULT_OPTIONS – window behaviour + the "actions" map (clickable [data-action] names -> methods)
 *   PARTS           – the named Handlebars templates that make up the window's HTML
 *   _prepareContext – builds the plain-object data those templates render with
 * The mental model: state changes -> we call this.render() -> Foundry re-runs _prepareContext
 * and re-paints the PARTS. We rarely touch the DOM by hand.
 */
export class CreatorShell extends CreatorShellBase {

  // The shared actions plus the picker drawer's two. They live here rather than in each pick
  // step's `handle()` because opening and closing the drawer is window chrome, not a choice: the
  // three pick steps would otherwise carry three identical copies of the same two lines.
  static DEFAULT_OPTIONS = {
    ...shellOptions("sogrom-creator"),
    actions: {
      ...SHELL_ACTIONS,
      openPicker() { this._setPicker(true); },
      closePicker() { this._setPicker(false); }
    }
  };

  // Beyond the shared stage body: the work surface's page and its picker drawer, the spell
  // browser's list and description columns, the details form/media columns, the choices list,
  // and the store's shelf/cart (otherwise picking an option snaps them all back to the top).
  static PARTS = dossierStageParts([
    ".creator-work-page", ".creator-drawer",
    ".creator-picklist", ".creator-pick-desc",
    ".creator-details-form", ".creator-details-media", ".creator-choices",
    ".creator-store-shelf", ".creator-store-cart-list"
  ]);

  /** @type {CreatorState} */
  state;
  /** @type {import("../data/source-index.mjs").SourceIndex} */
  source;
  /** @type {import("../data/spell-source.mjs").SpellSource} */
  spells;
  /** @type {import("../data/equipment-source.mjs").EquipmentSource} */
  equipment;
  /** @type {import("../data/store-source.mjs").StoreSource} */
  store;

  // Instance state that drives rendering but isn't the character data itself
  // (`_stepIndex`, the index into STEPS of the step on screen, lives on the base):
  #loading = true;       // true while the compendium index warms; shows the spinner
  #finished = false;     // set once Create succeeds, so close() won't warn about a discard
  /** Set once the player has made any choice, so closing early can warn before discarding it. */
  #dirty = false;
  /** Live loading caption; null falls back to the initial "reading compendiums" label. */
  #loadingLabel = null;
  /**
   * CSS selector for the control that should hold keyboard focus after the next render, or null
   * to leave focus alone. Set by an interaction that re-renders away the control the player was
   * standing on; consumed once by {@link CreatorShell##restoreFocus}.
   */
  #focusAfterRender = null;

  constructor(actor, options = {}) {
    super(options);
    // `state` is the single source of truth for what the player has chosen so far. Passing an
    // existing actor resumes it; passing null starts a fresh, unsaved draft.
    this.state = new CreatorState(actor);
    // Reuse the shared, warm-once compendium index (warmed in the background at `ready`).
    // `#loadStage` re-grabs these after any staleness check, in case the cache was rebuilt.
    const { source, spells, equipment, store } = getSources();
    this.source = source;
    this.spells = spells;
    this.equipment = equipment;
    this.store = store;
  }

  get title() {
    return t("window.title", { name: this.state.actor?.name ?? t("common.newCharacter") });
  }

  /** @override The creator walks the fixed step registry. */
  get _activeStep() {
    return STEPS[this._stepIndex];
  }

  /** @override */
  get _stepCount() {
    return STEPS.length;
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    // Kick the load off without awaiting it: ApplicationV2 applies the framed window's
    // position/size only after `_onFirstRender` resolves, so awaiting the multi-second
    // load here would paint the spinner at the wrong size first (windowed mode) and snap
    // to the configured size once it finished. Returning immediately lets the frame size
    // correctly up front; `#loadStage()` flips `#loading` and re-renders when it's done.
    this.#loadStage();
  }

  /**
   * Reveal the first step once the shared compendium index is warm. The warm normally ran in
   * the background at `ready`, so {@link warmSources} resolves instantly here; if the window was
   * opened first (or the enabled-source config changed), it awaits the in-flight work — or kicks
   * off a fresh one — behind the loading spinner. Progress is written straight to the caption's
   * text node (no re-render) so the bar advances smoothly while the player waits.
   */
  async #loadStage() {
    // A changed enabled-source set means the cached index no longer reflects the world; rebuild.
    if ( isStale() ) {
      invalidateSources();
      const { source, spells, equipment, store } = getSources();
      this.source = source;
      this.spells = spells;
      this.equipment = equipment;
      this.store = store;
    }
    const off = onWarmProgress(pct => {
      this.#loadingLabel = t("loading.preparing", { percent: pct });
      const node = this.element?.querySelector(".creator-loading p");
      if ( node ) node.textContent = this.#loadingLabel;
    });
    try {
      await warmSources();
    } catch ( err ) {
      log("source index failed to load", err);
      ui.notifications?.error(t("notify.indexFailed"));
    } finally {
      off();
    }
    this.#loading = false;
    // Resuming an in-progress actor: jump to the first step still needing input.
    this._stepIndex = this.#firstIncompleteIndex();
    if ( this.rendered ) this.render();
  }

  /**
   * @override
   * Foundry calls this before every render to build the data object the templates read.
   * We assemble the whole window's view-model here: the dossier (the character so far, with the
   * step list folded into it), the progress meter, the active step's own context, and the nav bar
   * (Back/Next state, hints). Returning a plain object; the templates never see our live state
   * directly, only this snapshot.
   */
  async _prepareContext() {
    // Let the active step record that it's been shown (e.g. the optional Equipment step's
    // "visited" flag) before completion is read, so its dossier tick and the Next button reflect
    // the arrival on this very render rather than one render late.
    if ( !this.#loading ) this._activeStep.onEnter?.(this.state);
    const step = this._activeStep;
    // Build the active screen BEFORE reading the completion flags: laying it out can refresh the
    // caches those flags read (the Choices step resolves its requirements into `state.choiceCache`),
    // so the dossier tick and the Next button reflect this very render rather than the previous one.
    const stepContext = this.#loading ? {} : await step.context(this._ctx());
    const flags = this._completeFlags();
    // Both derived from `flags`, rather than re-running every step's isComplete() twice more.
    const missing = REQUIRED_STEPS.filter(s => !flags[STEPS.indexOf(s)]);
    const lines = this.#stepLines(flags);

    return {
      loading: this.#loading,
      loadingLabel: this.#loadingLabel ?? t("loading.indexing"),
      version: game.modules.get(MODULE_ID)?.version ?? "",
      cancelLabel: t("nav.cancel"),
      dossier: this.#dossierContext(lines),
      progress: this.#progressContext(lines, missing),
      step: {
        id: step.id,
        template: tpl(`${step.template}.hbs`),
        label: t(step.labelKey),
        // Optional one-line framing under the heading, shown by stage.hbs. Steps opt in.
        instruction: step.instructionKey ? t(step.instructionKey) : null,
        ...stepContext,
        // After the spread: the drawer's state is the shell's to decide, not the step's.
        drawerOpen: this.#drawerOpen(step, stepContext)
      },
      isReview: step.id === "review",
      nav: (() => {
        // Position and Back/Next are measured over the *visible* steps, so a hidden step neither
        // occupies a number nor is landed on when paging through.
        const visible = this.#visibleIndices();
        const hasNext = this._nextIndex() >= 0;
        return {
          index: this._stepIndex,
          total: visible.length,
          position: t("nav.position", { current: visible.indexOf(this._stepIndex) + 1, total: visible.length }),
          canBack: this._prevIndex() >= 0,
          canNext: hasNext && flags[this._stepIndex],
          backLabel: t("nav.back"),
          nextLabel: t("nav.next"),
          // When Next is greyed because this step isn't finished, say what's still needed
          // instead of leaving the player guessing at a dead button.
          hint: (hasNext && !flags[this._stepIndex])
            ? (step.incompleteHint?.(this.state, this.source) ?? t("nav.incomplete"))
            : null
        };
      })(),
      canFinish: missing.length === 0,
      // On the review step, spell out which required steps are still blocking Create.
      finishHint: (step.id === "review" && missing.length)
        ? t("nav.missing", { steps: missing.map(s => t(s.labelKey)).join(", ") })
        : null,
      finishLabel: t("nav.create")
    };
  }

  /**
   * @override
   * Runs after each render, once the fresh HTML is in the DOM. The `actions` map handles clicks
   * for us, but anything else — change events on inputs, drag-and-drop, live search filtering —
   * has to be wired up by hand here each time, because the old listeners died with the old HTML.
   */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    this.#applySourceArt(root);
    // The head artwork lives in stage DOM, so it has to be redrawn whenever the
    // stage is. Cheap and idempotent — it clears its own previous pass first.
    illuminatePages(root);
    // Above the guard below, and deliberately: a pending focus request has to be *consumed* on the
    // very next render whatever kind it is, or a rail-only render would carry it forward and move
    // focus during some later, unrelated one.
    this.#restoreFocus(root);
    // Everything below binds to stage DOM. A rail-only render (the point-buy steppers) leaves that
    // DOM in place, so re-binding would stack a second set of listeners on it — see
    // {@link CreatorShellBase#_stageRendered}.
    if ( !this._stageRendered(options) ) return;
    // Selects/inputs don't fire click "actions"; wire their change events to the dispatcher.
    this._wireStepChanges(root);
    this.#wireDragDrop(root);
    // Client-side filtering — no re-render, so the field keeps focus while typing. The spell steps
    // add level/school dropdowns; when present, search + dropdowns drive the combined spell filter,
    // otherwise the search box filters the card/list grid by name.
    const search = root.querySelector("[data-creator-search]");
    const spellFilters = root.querySelectorAll("[data-spell-filter-level], [data-spell-filter-school]");
    const bgFilter = root.querySelector("[data-bg-filter-ability]");
    if ( spellFilters.length ) {
      const apply = () => this._applySpellFilters();
      if ( search ) search.addEventListener("input", apply);
      for ( const sel of spellFilters ) sel.addEventListener("change", apply);
    } else if ( bgFilter ) {
      // Background step: search box + the increased-ability dropdown drive a combined filter.
      const apply = () => this.#applyBackgroundFilter();
      if ( search ) search.addEventListener("input", apply);
      bgFilter.addEventListener("change", apply);
    } else if ( search ) {
      search.addEventListener("input", ev => this.#filterCards(ev.currentTarget.value));
    }
    this.#wireDrawer(root);
  }

  /**
   * Give the picker drawer the keyboard behaviour the chevron on its switcher promises.
   *
   * Escape closes it — the drawer is the only overlay in the creator and had no keyboard
   * dismissal at all. Only when something is already chosen: with nothing chosen the drawer *is*
   * the step, and closing it would leave an empty surface with no way back except picking
   * something. That is the same condition the template uses to decide whether to render a Close
   * button, so it is read off the DOM here rather than recomputed, and the two cannot drift.
   *
   * Bound to the drawer element, not the document, so the listener dies with the DOM it belongs
   * to and can never fire on a later step.
   * @param {HTMLElement} root  The application's root element.
   */
  #wireDrawer(root) {
    const drawer = root.querySelector(".creator-drawer.is-open");
    if ( !drawer?.querySelector("[data-action='closePicker']") ) return;
    drawer.addEventListener("keydown", ev => {
      if ( ev.key !== "Escape" ) return;
      ev.preventDefault();
      ev.stopPropagation();    // don't let Foundry read it as "close the application"
      this._setPicker(false);
    });
  }

  /**
   * Put keyboard focus back where the interaction that caused this render left it.
   *
   * Opening or closing the drawer re-renders the whole stage, so the control the player just
   * activated stops existing and focus falls back to <body>. A keyboard user who pressed Enter on
   * the switcher then had to Tab past the top bar and the entire dossier to reach the list they
   * had just asked for; closing the drawer dropped them at the top of the window again.
   *
   * `#focusAfterRender` is set by whatever initiated the change and consumed exactly once here, so
   * an ordinary render — navigation, a step action — never moves focus on its own.
   * @param {HTMLElement} root  The application's root element.
   */
  #restoreFocus(root) {
    const selector = this.#focusAfterRender;
    this.#focusAfterRender = null;
    if ( !selector ) return;
    // preventScroll: the target is on screen already, and letting the browser scroll to it jogs
    // the surface underneath for no reason.
    root.querySelector(selector)?.focus({ preventScroll: true });
  }

  /**
   * @override Explain an emptied list after any client-side filter pass — the shared spell filter
   * and the background filter below both land here.
   */
  _afterFilter(needle, filtered) {
    this.#updateNoResults(needle, filtered);
    this.#updateVisibleCount();
  }

  /**
   * Hide background pick-rows that don't match the active name search and increased-ability
   * dropdown (a row must satisfy both). Each row carries the abilities its increase can raise
   * in `data-abilities` (space-joined); the dropdown filters to backgrounds that raise one.
   */
  #applyBackgroundFilter() {
    const root = this.element;
    const needle = (root.querySelector("[data-creator-search]")?.value ?? "").trim().toLowerCase();
    const ability = root.querySelector("[data-bg-filter-ability]")?.value ?? "";
    for ( const row of root.querySelectorAll(".creator-pickrow") ) {
      const matchesName = !needle || (row.dataset.name ?? "").toLowerCase().includes(needle);
      const matchesAbility = !ability || (row.dataset.abilities ?? "").split(" ").includes(ability);
      (row.closest("li") ?? row).classList.toggle("is-hidden", !(matchesName && matchesAbility));
    }
    this.#updateNoResults(needle, !!ability);
    this.#updateVisibleCount();
  }

  /**
   * Toggle a "no matches" line inside any pick-list whose rows are all currently filtered out, so a
   * search or filter that hides everything explains itself instead of leaving a blank column. Lists
   * that were empty to begin with keep their own `.creator-empty` message and are left alone.
   * @param {string} needle    The active name search, for the message wording.
   * @param {boolean} filtered Whether a non-search filter (spell level/school) is also narrowing.
   */
  #updateNoResults(needle, filtered = false) {
    for ( const list of this.element.querySelectorAll(".creator-picklist") ) {
      const rows = [...list.querySelectorAll("li:not(.creator-no-results)")];
      let msg = list.querySelector(".creator-no-results");
      // No real rows at all → the template's empty-state already covers it.
      if ( !rows.length || rows.some(li => !li.classList.contains("is-hidden")) ) {
        msg?.remove();
        continue;
      }
      if ( !msg ) {
        msg = document.createElement("li");
        msg.className = "creator-no-results";
        list.appendChild(msg);
      }
      msg.textContent = needle
        ? t("common.noResults", { query: needle })
        : (filtered ? t("common.noResultsFilters") : t("common.noEntries"));
    }
  }

  /**
   * When the official D&D Player's Handbook module is installed, borrow two of its journal
   * sketches as faded backdrops behind the remaining empty-state placeholders — a general
   * adventuring sketch for the choices/equipment/store steps, plus the abjurer on the spells
   * step. The CSS variables feed `.creator-pick-empty::before`; left unset (no PHB module) the
   * backdrops simply don't render, so the creator looks identical without it.
   *
   * The origin steps used to be the main consumer of the first sketch. They have no placeholder
   * any more — they open on their options rather than on a panel announcing it has nothing to
   * show — but the steps that still have one keep theirs.
   */
  #applySourceArt(root) {
    const phb = "dnd-players-handbook";
    if ( game.modules.get(phb)?.active ) {
      root.style.setProperty("--cc-pick-sketch",
        `url("/modules/${phb}/assets/journal-art/adventuring-equipment-sketch.webp")`);
      root.style.setProperty("--cc-spells-sketch",
        `url("/modules/${phb}/assets/journal-art/abjurer.webp")`);
    } else {
      root.style.removeProperty("--cc-pick-sketch");
      root.style.removeProperty("--cc-spells-sketch");
    }
  }

  /**
   * Generic drag-and-drop bridge to the step dispatcher. A `[data-step-drag]` element
   * carries an opaque payload string; dropping it on a `[data-step-drop]` element stashes
   * that payload on the target's `dataset.dropPayload` and dispatches the drop's action, so
   * a step handler reads it exactly like any other dataset value. Used by the ability panel
   * to drop pooled scores onto abilities, but knows nothing of abilities itself.
   */
  #wireDragDrop(root) {
    for ( const el of root.querySelectorAll("[data-step-drag]") ) {
      el.setAttribute("draggable", "true");
      el.addEventListener("dragstart", ev => {
        ev.dataTransfer.setData("text/plain", el.dataset.stepDrag);
        ev.dataTransfer.effectAllowed = "move";
        el.classList.add("is-dragging");
      });
      el.addEventListener("dragend", () => el.classList.remove("is-dragging"));
    }
    for ( const el of root.querySelectorAll("[data-step-drop]") ) {
      el.addEventListener("dragover", ev => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        el.classList.add("is-dragover");
      });
      el.addEventListener("dragleave", () => el.classList.remove("is-dragover"));
      el.addEventListener("drop", ev => {
        ev.preventDefault();
        el.classList.remove("is-dragover");
        el.dataset.dropPayload = ev.dataTransfer.getData("text/plain");
        this._dispatch(el.dataset.stepDrop, el);
      });
    }
  }

  /** @override */
  async close(options = {}) {
    // Nothing the player picks is written to the world until Create, so closing early throws the
    // whole draft away. Once they've made a choice, confirm before discarding it — every exit path
    // (Cancel, the frame's close, a programmatic close) funnels through here. A finished build, or
    // an explicit `force`, skips the prompt.
    if ( !this.#finished && !options.force && this.#dirty ) {
      if ( !await this._confirmDiscard("cancel.title", "cancel.body") ) return this;
    }
    return super.close(options);
  }

  /* -------------------------------------------- */
  /*  Navigation helpers                          */
  /* -------------------------------------------- */
  //
  // These decide which steps are done, reachable, or hidden. The core rule of the whole flow:
  // a step is only reachable once every step before it is complete — so the player can't skip
  // ahead past an unfinished requirement. "Visible" and "reachable" are separate ideas: a step
  // can be shown-but-locked (dimmed on the dossier), or dropped from the flow entirely (see #hidden).

  /** @override One boolean per step, in STEPS order: is it complete right now? */
  _completeFlags() {
    return STEPS.map(s => s.isComplete(this.state));
  }

  /** When resuming a saved character, the first step that still needs input (or review if all done). */
  #firstIncompleteIndex() {
    const idx = REQUIRED_STEPS.findIndex(s => !s.isComplete(this.state));
    return idx === -1 ? STEPS.length - 1 : STEPS.indexOf(REQUIRED_STEPS[idx]);
  }

  /**
   * Whether a step is hidden from the flow right now — a step that opts into {@link
   * hideWhenInapplicable} is dropped entirely (not just dimmed) while it doesn't apply, so the
   * Feat-Spells step appears on the dossier only once a feat that needs it is chosen.
   */
  #hidden(step) {
    return step.hideWhenInapplicable && !(step.applicable?.(this.state) ?? true);
  }

  /** STEPS indices currently shown, in order (hidden steps omitted). */
  #visibleIndices() {
    return STEPS.map((_s, i) => i).filter(i => !this.#hidden(STEPS[i]));
  }

  /**
   * @override The next / previous *visible* step index, or -1 if none — so paging through the flow
   * skips a step that doesn't currently apply instead of landing on it.
   */
  _nextIndex() {
    for ( let i = this._stepIndex + 1; i < STEPS.length; i++ ) if ( !this.#hidden(STEPS[i]) ) return i;
    return -1;
  }

  /** @override */
  _prevIndex() {
    for ( let i = this._stepIndex - 1; i >= 0; i-- ) if ( !this.#hidden(STEPS[i]) ) return i;
    return -1;
  }

  /**
   * One line per visible step, for the dossier's roll. Each carries both what the step *is*
   * (label, index, reachability) and what the player has put in it (`summary`) — which is what
   * lets the dossier be the navigation and the character summary at once instead of two objects.
   *
   * `summary` is not new: every step module has produced this short line since the old stepper,
   * where it was only ever surfaced as a hover tooltip. On the dossier it is the value on the line.
   * @param {boolean[]} flags   Completion per step, in STEPS order.
   * @returns {object[]}
   */
  #stepLines(flags) {
    const lines = [];
    STEPS.forEach((s, i) => {
      if ( this.#hidden(s) ) return;        // dropped from the roll until it applies
      // A step can still opt out of applicability while remaining visible (e.g. Spells for a
      // non-caster); the line is struck through and shows no completion tick.
      const applicable = s.applicable?.(this.state) ?? true;
      const complete = flags[i] && s.id !== "review" && applicable;
      const reachable = this._reachable(i, flags);
      lines.push({
        index: i,
        id: s.id,
        label: t(s.labelKey),
        icon: s.icon,
        active: i === this._stepIndex,
        applicable,
        complete,
        reachable,
        // "Outstanding" is deliberately narrower than "not complete": a step the player cannot
        // reach yet is not something they have left to do, it is something they have left to
        // arrive at. Marking those too would paint most of the roll teal on the first screen and
        // teach the player to ignore the colour.
        open: reachable && applicable && !complete && s.id !== "review",
        summary: s.summary?.(this.state, this.source) ?? ""
      });
    });
    return lines;
  }

  /**
   * The dossier's view-model: the character as it stands, then the step lines.
   *
   * The identity and score blocks are read-only by design. Every control that *sets* one of these
   * values lives on the work surface; the dossier only ever reports. Keeping that rule is what
   * stops the two halves of the window competing to own the same decision.
   * @param {object[]} lines   From {@link #stepLines}.
   */
  #dossierContext(lines) {
    return {
      portrait: this.state.portrait,
      name: this.state.details.name?.trim() ?? "",
      className: this.source.card(this.state.classUuid)?.name ?? "",
      level: this.state.targetLevel ?? 1,
      ...this.#dossierAbilities(),
      steps: lines
    };
  }

  /**
   * The six ability plates: base score plus whatever the chosen origins add.
   *
   * `abilitiesSet` gates whether numbers show at all. Until the ability step is finished the raw
   * state still holds a full set of values (point-buy starts every ability at 8), and printing
   * those would show the player a set of scores they never chose sitting on their sheet. Blanks
   * are the honest reading of "not decided yet".
   */
  #dossierAbilities() {
    const scores = this.state.resolvedScores();
    const deltas = this.state.abilityDeltas();
    const abilities = ABILITIES.map(key => {
      const bonus = deltas[key]?.total ?? 0;
      const value = (scores[key] ?? 8) + bonus;
      return {
        key,
        abbr: CONFIG.DND5E?.abilities?.[key]?.abbreviation ?? key.slice(0, 3).toUpperCase(),
        value,
        modifier: formatMod(value),
        bonus: bonus ? `+${bonus}` : null,
        bonusTip: bonus
          ? deltas[key].sources.map(s => t(`step.${s.source}.label`) + ` +${s.bonus}`).join(", ")
          : null
      };
    });
    // The class step owns the ability panel, so its completion flag is the one that says whether a
    // full, valid set of scores exists.
    return { abilities, abilitiesSet: STEPS[0].isComplete(this.state) };
  }

  /**
   * The top bar's progress meter. Counted over the *visible* steps, so a step that doesn't apply
   * to this character never makes the bar look short of its own total.
   *
   * `outstanding` is the standing answer to "what is left" — required steps still needing input.
   * It is a separate number from the position because they answer different questions: position
   * says where you are in the sequence, outstanding says how much work remains regardless of
   * order (a player can go back and leave a finished step behind them unfinished again).
   * @param {object[]} lines      From {@link #stepLines}.
   * @param {object[]} missing    Required steps not yet complete.
   */
  #progressContext(lines, missing) {
    const visible = lines.length;
    const current = Math.max(lines.findIndex(l => l.active) + 1, 1);

    // The fill measures *position*: how far along the flow the player is.
    //
    // This has now been wrong in both directions. It began as complete-lines over visible-lines,
    // which could never fill, because Review is a summary rather than a task and is deliberately
    // never marked complete — so the bar sat at eight ninths on the screen where the character was
    // finished. The fix was to measure settled required steps instead, which fills exactly when
    // nothing is outstanding — and that produced the opposite lie: with every required step done
    // and only Review left, the bar reads 100% while the counter beside it reads "Step 9 of 10".
    // A full bar next to a counter that is not full is a contradiction the player has to resolve,
    // and the reading they take from it — "I'm finished" — is the wrong one, because they have not
    // pressed Create.
    //
    // Both attempts were trying to make one bar answer two questions. It only has to answer the
    // one its own neighbour asks. The counter next to it says where you are; the bar is the
    // graphic of that counter, and the two now cannot disagree — 9 of 10 draws nine tenths, and
    // the bar is full on Review, which is the last step and where the old bug was.
    //
    // Completion is not lost: it is what the teal outstanding chip immediately to the right
    // reports, and what the ticks down the dossier report per step. Position and completion are
    // genuinely different questions — a player can go back and leave a finished step behind them
    // unfinished again — so they get one readout each instead of one readout each other's shape.
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

  #filterCards(query) {
    const needle = query.trim().toLowerCase();
    // The pick-lists (class/species/background) and the store's shelf rows share this filter; for a
    // pick-row the <li> wrapper is hidden so the list gap collapses with it.
    for ( const card of this.element.querySelectorAll(".creator-pickrow, .creator-store-row") ) {
      const name = (card.dataset.name ?? "").toLowerCase();
      const target = card.closest("li") ?? card;
      target.classList.toggle("is-hidden", !!needle && !name.includes(needle));
    }
    this.#updateNoResults(needle);
    this.#updateVisibleCount();
    this.#updateStoreGroups(needle);
  }

  /**
   * Hide a store shelf section once the filter has emptied it.
   *
   * The shelf is grouped by item type — Weapons, Armor & Gear, Consumables… — and each section is
   * a `.creator-store-group` around its heading and list. Filtering hides rows, not headings, so
   * without this a search for "rope" left five empty headings with one row lost among them.
   *
   * Purely presentational and keyed off the rows' own hidden state, so it needs no knowledge of
   * what the filter matched on.
   */
  #updateStoreGroups(needle = "") {
    const shelf = this.element.querySelector(".creator-store-shelf");
    if ( !shelf ) return;
    const groups = [...shelf.querySelectorAll(".creator-store-group")];
    for ( const group of groups ) {
      const rows = [...group.querySelectorAll(".creator-store-row")];
      group.classList.toggle("is-hidden", rows.length > 0 && rows.every(r => r.classList.contains("is-hidden")));
    }
    // Hiding whole sections rather than bare rows means a search that matches nothing now empties
    // the shelf completely, where it used to leave the headings standing. Say so, or the step
    // looks like it failed to load.
    const allHidden = groups.length > 0 && groups.every(g => g.classList.contains("is-hidden"));
    let msg = shelf.querySelector(".creator-no-results");
    if ( !allHidden ) return msg?.remove();
    if ( !msg ) {
      msg = document.createElement("p");
      msg.className = "creator-no-results";
      shelf.appendChild(msg);
    }
    msg.textContent = needle ? t("common.noResults", { query: needle }) : t("common.noResultsFilters");
  }

  /**
   * Rewrite the drawer's "Available: N" to the number of options actually on screen.
   *
   * Filtering happens in the DOM with no re-render, deliberately, so the search field keeps focus
   * while typing. The count was rendered by Handlebars and therefore never moved: type "wiz" and
   * one card sits under the words "Available: 87".
   *
   * The element is an aria-live region, so this is also the only thing that speaks the result of a
   * search — rows are hidden with a class, which no screen reader reports. Writing the full string
   * (rather than just the number) is what makes the announcement a sentence instead of a bare
   * numeral, and `aria-atomic` on the element is what makes the whole sentence get read.
   *
   * Silent where there is no such element: the spell steps share the filter passes below and have
   * their own toolbar.
   */
  #updateVisibleCount() {
    const readout = this.element.querySelector("[data-creator-count]");
    if ( !readout ) return;
    // The picker drawer and the store shelf both render this readout over a filterable list.
    const rows = [...this.element.querySelectorAll(".creator-drawer .creator-pickrow, .creator-store-row")];
    // Nothing this count describes → leave the rendered value alone.
    if ( !rows.length ) return;
    const shown = rows.filter(row => !(row.closest("li") ?? row).classList.contains("is-hidden")).length;
    readout.textContent = `${t("common.available")}: ${shown}`;
  }

  /* -------------------------------------------- */
  /*  Dispatch                                    */
  /* -------------------------------------------- */

  /**
   * @override
   * The shared context handed to every step's `context()` and `handle()`. `app` lets a
   * step request a re-render after an async flow that resolves later (e.g. a FilePicker
   * callback), since the dispatch's own render fires immediately.
   */
  _ctx() {
    return { state: this.state, source: this.source, spells: this.spells, equipment: this.equipment, store: this.store, app: this };
  }

  /** @override Any step interaction counts as progress worth confirming before a discard. */
  _onDispatch(action) {
    this.#dirty = true;
    // Choosing an option answers the question the drawer was opened to ask, so it closes itself.
    // Re-clicking the chosen row clears the selection instead, and #drawerOpen() reopens it on the
    // next render — a step with nothing chosen always shows its options.
    if ( action === "pick-class" || action === "pick-origin" ) {
      this.state.pickerFor = null;
      // The card just clicked is about to be re-rendered away with the drawer, so land the
      // keyboard on the switcher that now names the choice. If this click *cleared* a selection
      // instead, the drawer reopens and there is no switcher — #restoreFocus() finds nothing and
      // leaves focus alone, which is the behaviour that was there before.
      this.#focusAfterRender = ".creator-work-switch";
    }
  }

  /**
   * Whether the picker drawer is open on the current step.
   *
   * Derived rather than stored, from one nullable field: the drawer is open when nothing is
   * chosen (there is nothing underneath worth covering, and the choice *is* the step), or when the
   * player explicitly opened it from the switcher. Because `pickerFor` is compared against the
   * active step's id, navigating away closes it with no reset logic anywhere.
   * @param {object} step        The active step module.
   * @param {object} stepContext The context it just produced.
   * @returns {boolean}
   */
  #drawerOpen(step, stepContext) {
    if ( !("hasSelection" in stepContext) ) return false;    // not a pick step; it has no drawer
    return !stepContext.hasSelection || this.state.pickerFor === step.id;
  }

  /**
   * Open or close the picker drawer on the current step. Bound to the `openPicker`/`closePicker`
   * actions above.
   * @param {boolean} open
   */
  _setPicker(open) {
    this.state.pickerFor = open ? this._activeStep?.id ?? null : null;
    // Follow the drawer with the keyboard: opening lands in the search field at the top of the
    // list just asked for, closing returns to the switcher that opened it. Without this the
    // re-render below destroys whichever control was activated and focus falls to <body>.
    this.#focusAfterRender = open ? "[data-creator-search]" : ".creator-work-switch";
    this.render();
  }

  /**
   * Public navigation for step handlers: jump to a step by id when it is currently reachable
   * (Quick Build uses this to land on Review after filling the state). When the requested step's
   * prerequisites aren't all complete, fall back to the first incomplete step instead, so a
   * partial fill still lands the player somewhere sensible.
   * @param {string} id  A step id from STEPS (e.g. "review").
   * @returns {boolean}  Whether the requested step was reached.
   */
  gotoStep(id) {
    const index = STEPS.findIndex(s => s.id === id);
    if ( index < 0 ) return false;
    const reached = this._reachable(index);
    this._stepIndex = reached ? index : this.#firstIncompleteIndex();
    this.render();
    return reached;
  }

  /**
   * @override
   * The "Create" button. This is where the draft finally becomes a real actor in the world:
   * guard that every required step is done, create the actor if we don't already have one, then
   * hand off to assembleActor() to write class/species/spells/equipment onto it. On any failure we
   * roll #finished back so the window stays open and the player can retry.
   */
  async _finish(target) {
    // A build takes seconds (actor create + advancement manager + many embedded writes), so guard
    // against a second click landing while the first is still running — without this, the second
    // pass sees state.actor still null and builds a whole second actor. #finished is our latch.
    if ( this.#finished ) return;
    if ( !REQUIRED_STEPS.every(s => s.isComplete(this.state)) ) return;
    this.#finished = true;
    // Tell the player work is happening, and make the button un-clickable for real (the latch above
    // already blocks re-entry; this is the visible half of the same guard).
    if ( target ) {
      target.disabled = true;
      target.textContent = t("nav.building");
    }
    let actor = this.state.actor;
    // Track whether *this* build created the actor. If assembleActor throws after Actor.create
    // succeeded, we delete the half-built actor below so a retry starts from a clean slate instead
    // of re-running assembly on top of the partial one (which duplicates every already-written item).
    // A resumed character's actor pre-exists in state, so this stays false and we never delete it.
    let createdActor = false;
    try {
      // The draft actor is created only now, at Create — so a cancelled build never leaves an
      // orphan "New Character" in the directory. Resuming an existing character reuses its actor.
      if ( !actor ) {
        actor = await Actor.create({ name: this.state.details.name?.trim() || t("common.newCharacter"), type: "character" });
        if ( !actor ) throw new Error("actor creation returned nothing");
        this.state.actor = actor;
        createdActor = true;
      }
      await assembleActor(this.state, this.source, this.equipment);
    } catch ( err ) {
      log("character build failed", err);
      ui.notifications?.error(t("notify.buildFailed"));
      // Delete the orphaned actor this build created so the retry rebuilds from scratch rather than
      // stacking assembly onto a partially-built actor. Clear state.actor so the next attempt takes
      // the create path again.
      if ( createdActor ) {
        try {
          await actor?.delete();
        } catch ( cleanupErr ) {
          log("failed to clean up half-built actor", cleanupErr);
        }
        this.state.actor = null;
      }
      this.#finished = false;
      // Re-enable the button so the player can retry without reopening the window.
      if ( target ) {
        target.disabled = false;
        target.textContent = t("nav.create");
      }
      return;
    }
    await this.close();
    actor?.sheet?.render(true);
    // The build above always produces a level-1 character. When the player asked for more on the
    // Class step, hand the rest to the level-up wizard: one manager for the whole 1→target jump, so
    // they get a screen per gained level and a single commit. It opens over the sheet we just
    // rendered — so if they close it, they still have the (valid) level-1 character they built.
    const targetLevel = this.state.targetLevel ?? 1;
    if ( actor && targetLevel > 1 ) await launchLevelUpTo(actor, targetLevel);
  }
}
