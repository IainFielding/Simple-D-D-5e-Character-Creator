import { MODULE_ID, tpl, t, log } from "../config.mjs";
import { CreatorShellBase, shellOptions, railStageParts } from "../app/shell-base.mjs";
import { buildSteps } from "./registry.mjs";
import { getSources, isStale, invalidateSources } from "../data/source-cache.mjs";
import { forEachLimit, WARM_CONCURRENCY } from "../data/concurrency.mjs";
import { applyLevelUpSpells, spellChanges } from "./steps/lvl-spells-step.mjs";
import { stageEmberGear, abandonEmberCreation } from "./ember-creation.mjs";

/**
 * The level-up window. Like the creator's shell it is deliberately thin — it owns its step list and
 * delegates per-step data and behaviour to the step modules — but it drives a {@link LevelUpDriver}
 * (the wrapped native AdvancementManager) instead of the creation state, and it commits the driver's
 * clone rather than assembling a new actor.
 *
 * The window chrome, the click dispatcher, Back/Next, rail reachability and the discard prompt all
 * come from {@link CreatorShellBase}, shared with the creator window.
 *
 * For a junior dev: this is the same ApplicationV2 pattern as creator-shell.mjs (see the big
 * teaching note there for DEFAULT_OPTIONS/PARTS/actions/_prepareContext). Two things are specific
 * to level-up:
 *   1. The step list is REBUILT every render (buildSteps), because choices reveal more choices —
 *      e.g. picking a subclass adds its feature steps. So the rail can grow between renders.
 *   2. Nothing touches the real actor until the single Apply on the review step: the level
 *      decisions live on the driver's clone, the spell picks are staged on the state, and
 *      {@link #applyLevelUp} writes both in one go before closing.
 */
export class LevelUpShell extends CreatorShellBase {

  static DEFAULT_OPTIONS = shellOptions("sogrom-levelup");

  // Beyond the shared stage body: the subclass picker's independently scrolling list/detail columns
  // (which reuse the creator's pick layout).
  static PARTS = railStageParts([".creator-picklist", ".creator-pick-desc"]);

  /** @type {import("./levelup-state.mjs").LevelUpState} */
  state;
  /** @type {object[]} The per-session step set (built from the driver's surfaced decisions). */
  #steps;
  /** Keys of level-screen blocks complete at the previous render, plus the step they belong to, so
   *  {@link #guideToNext} can tell a fresh completion from a block that was already done. */
  #completeBlocks = null;
  #completeStep = null;
  /** The shared compendium index (subclass picker, origin details) — see {@link getSources}. */
  #source;
  /** The shared spell source; the post-commit spell step's pool persists across windows. */
  #spells;
  /** The shared starting-equipment and shop sources — only the Ember hand-off's rail uses them. */
  #equipment;
  #store;

  constructor(state, options = {}) {
    super(options);
    this.state = state;
    this.#steps = buildSteps(state);
    // Reuse the world's shared, warm-once compendium caches (read-only — no session state): the
    // level-up benefits from the background warm at `ready`, and its own loads (the subclass
    // index, the spell pool) stay cached for the next level-up instead of dying with this window.
    // A changed enabled-source set means those caches no longer reflect the world; rebuild first.
    if ( isStale() ) invalidateSources();
    const { source, spells, equipment, store } = getSources();
    this.#source = source;
    this.#spells = spells;
    this.#equipment = equipment;
    this.#store = store;
    // Subclass decisions are fixed once the driver has prepared, so their data can start
    // loading immediately — long before the player scrolls down to the subclass block.
    this.#warmSubclasses();
  }

  /**
   * Called by the Class step the moment a driver is adopted mid-session: the class (and so the
   * subclass list and spell pool worth warming) is only known now. The spell pool re-warms on the
   * next render anyway ({@link #warmSpellPool}); the subclass warm is kicked here.
   */
  warmForDriver() {
    this.#warmSubclasses();
  }

  /**
   * Start loading the subclass picker's data in the background while the player is still on the
   * earlier decisions: the world's subclass index, then the detail panel and feature groups of
   * this class's own subclasses. Fire-and-forget — everything lands in the shared source cache's
   * promise-memos, so the subclass block reads it back instantly (or joins the tail of this same
   * work). A single card's failure only costs that card its warmth. A no-op until a driver
   * exists (a chooseClass session's constructor runs before any class is picked).
   */
  async #warmSubclasses() {
    try {
      for ( const record of this.state.subclassSteps ) {
        const identifier = record.advancement?.item?.identifier;
        if ( !identifier ) continue;
        // Same edition scoping the step itself applies, or the warm-up would prefetch cards the
        // screen will never show.
        const rules = record.advancement?.item?.system?.source?.rules ?? null;
        const cards = await this.#source.subclasses(identifier, { rules });
        await forEachLimit(cards, WARM_CONCURRENCY, async card => {
          try {
            await this.#source.detail(card.uuid);
            await this.#source.advancementGroups(card.uuid);
          } catch ( err ) {
            log(`failed to warm subclass ${card.uuid}`, err);
          }
        });
      }
    } catch ( err ) {
      log("subclass warm-up failed", err);
    }
  }

  get title() {
    const name = this.state.actor?.name ?? "";
    // The Ember hand-off isn't a level-up from the player's point of view — they are still creating
    // the character, and Ember's builder is waiting behind this window.
    if ( this.state.emberCreation ) return t("levelup.window.emberTitle", { name });
    return t("levelup.window.title", { name, level: this.state.toLevel });
  }

  /** @override The level-up walks the per-session step set rebuilt on every render. */
  get _activeStep() {
    return this.#steps[this._stepIndex];
  }

  /** @override */
  get _stepCount() {
    return this.#steps.length;
  }

  /** @override One boolean per step, in list order: is it complete right now? */
  _completeFlags() {
    return this.#steps.map(s => s.isComplete(this.state));
  }

  /** Steps that must be complete before the level-up may be applied (everything but review). */
  get #requiredSteps() {
    return this.#steps.filter(s => s.id !== "review");
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext() {
    // A level-up is a pipeline: choosing a subclass reveals its feature steps. Rebuild the step
    // set each render so the rail grows (or shrinks) with the decisions the driver has surfaced,
    // keeping the active index in range.
    this.#steps = buildSteps(this.state);
    this._stepIndex = Math.min(this._stepIndex, this.#steps.length - 1);
    const step = this._activeStep;
    // Build the active screen BEFORE the completion flags: laying out its blocks refreshes the
    // per-record caches the flags read (e.g. a choice quota whose pool is exhausted), so Next
    // enables on the same render that shows the screen.
    const stepContext = await step.context(this._ctx());
    const flags = this._completeFlags();

    return {
      loading: false,
      version: game.modules.get(MODULE_ID)?.version ?? "",
      cancelLabel: t("nav.cancel"),
      rail: this.#railContext(flags),
      step: {
        id: step.id,
        template: tpl(`${step.template}.hbs`),
        // Per-level steps carry a resolved label ("Level 4"); the review step uses its labelKey.
        label: step.label ?? t(step.labelKey),
        ...stepContext
      },
      // The finish button (Apply) replaces Next in the footer on the review step only.
      isReview: step.id === "review",
      nav: {
        index: this._stepIndex,
        total: this.#steps.length,
        position: t("nav.position", { current: this._stepIndex + 1, total: this.#steps.length }),
        canBack: this._stepIndex > 0,
        canNext: this._stepIndex < this.#steps.length - 1 && flags[this._stepIndex]
          && this._reachable(this._stepIndex + 1, flags),
        backLabel: t("nav.back"),
        nextLabel: t("nav.next")
      },
      // Derived from `flags` rather than re-running every step's isComplete() a second time; the
      // review step is the last one, so "everything before it is done" is the Apply gate.
      canFinish: this.#steps.every((s, i) => (s.id === "review") || flags[i]),
      // The Ember hand-off is still character creation as far as the player is concerned — nothing
      // is being levelled up — so the primary button says so.
      finishLabel: t(this.state.emberCreation ? "levelup.nav.emberApply" : "levelup.nav.apply")
    };
  }

  #railContext(flags) {
    return this.#steps.map((s, i) => ({
      index: i,
      id: s.id,
      label: s.label ?? t(s.labelKey),
      icon: s.icon,
      ordinal: i + 1,
      active: i === this._stepIndex,
      applicable: true,
      complete: flags[i] && s.id !== "review",
      reachable: this._reachable(i, flags),
      summary: s.summary?.(this.state) ?? ""
    }));
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#warmSpellPool();
    // Everything below binds to stage DOM, which a rail-only render leaves in place — see
    // {@link CreatorShellBase#_stageRendered}. This shell renders whole today, so the guard is
    // insurance against a partial render being added later, not a fix for a live fault.
    if ( !this._stageRendered(options) ) return;
    this._wireStepChanges(this.element);
    // Client-side spell-list filters on the spell step — search box plus the level/school
    // dropdowns. All filter in the DOM without a re-render, so the search field keeps focus
    // while typing; their values live on the state so the re-render a spell click causes
    // restores them (a rebuilt control would otherwise reset to "show everything").
    const filters = [
      [this.element.querySelector("[data-creator-search]"), "spellSearch", "input"],
      [this.element.querySelector("[data-spell-filter-level]"), "spellLevelFilter", "change"],
      [this.element.querySelector("[data-spell-filter-school]"), "spellSchoolFilter", "change"]
    ].filter(([el]) => el);
    for ( const [el, key, event] of filters ) {
      el.value = this.state[key];
      el.addEventListener(event, () => {
        this.state[key] = el.value;
        this._applySpellFilters();
      });
    }
    if ( filters.length ) this._applySpellFilters();
    this.#guideToNext();
  }

  /**
   * Guided flow between a level's decision blocks: when the player has just finished a section, draw
   * their eye to the next unfinished one. Every action re-renders the whole level screen, so we
   * detect the moment of completion by diffing the set of complete blocks against the previous
   * render — a block that flipped to complete means the last click settled it.
   *
   * Deliberately gentle (the "less jarring, still guided" brief): the finished block stays put, we
   * only scroll the next incomplete block into view if it isn't already, and a short CSS ring pulse
   * marks where to look. When the whole level is done we pulse the enabled Next button instead, so
   * the invitation to move on is just as clear. A step change swaps the entire block set, so those
   * renders only snapshot the new screen's state without moving anything.
   */
  #guideToNext() {
    const stepId = this._activeStep?.id;
    const blocks = [...this.element.querySelectorAll(".levelup-block")];
    const keyOf = b => b.querySelector(".levelup-block-head")?.dataset.block ?? "";
    const complete = new Set(blocks.filter(b => b.classList.contains("is-complete")).map(keyOf));

    // First render of this level screen (open, or arriving via nav): baseline only, no movement.
    if ( stepId !== this.#completeStep ) {
      this.#completeStep = stepId;
      this.#completeBlocks = complete;
      return;
    }
    const justDone = blocks.find(b => b.classList.contains("is-complete") && !this.#completeBlocks.has(keyOf(b)));
    this.#completeBlocks = complete;
    if ( !justDone ) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const after = blocks.slice(blocks.indexOf(justDone) + 1);
    const nextIncomplete = after.find(b => !b.classList.contains("is-complete"))
      ?? blocks.find(b => !b.classList.contains("is-complete"));
    if ( nextIncomplete ) {
      // rAF so this runs after the framework has restored the pre-render scroll position.
      requestAnimationFrame(() => nextIncomplete.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" }));
      this.#pulse(nextIncomplete);
    } else {
      // Level fully decided — invite the player onward via the Next button.
      this.#pulse(this.element.querySelector(".creator-btn--trail:not(:disabled)"));
    }
  }

  /** Retrigger the guide ring on an element, restarting the animation if it's still mid-pulse. */
  #pulse(el) {
    if ( !el ) return;
    el.classList.remove("cc-guide-pulse");
    void el.offsetWidth; // Force reflow so re-adding the class restarts the keyframes.
    el.classList.add("cc-guide-pulse");
    el.addEventListener("animationend", () => el.classList.remove("cc-guide-pulse"), { once: true });
  }

  /**
   * Start loading the level-up spell pool in the background while the player is still making
   * level decisions, so reaching the post-commit spell step doesn't stall on the compendium
   * fetch. Fire-and-forget: the pool is memoised per class/level key inside {@link SpellSource}
   * (as an in-flight promise, so the spell step's own load joins this one rather than racing it),
   * which also makes re-running on every render free — and re-running matters, because the plan
   * can change mid-wizard: picking an Eldritch Knight-style subclass turns the class into a
   * caster only after that pick, and this warms the new key the render after it happens.
   */
  #warmSpellPool() {
    const plan = this.state.spellPlan();
    if ( !plan.isSpellcaster || !plan.hasDelta || !plan.castUuid ) return;
    // Same arguments the step itself uses, so the warm and the step share one memoised load.
    this.#spells.forClassAtLevel(plan.castUuid, plan.maxSpellLevel, plan.listType, { doc: plan.castItem })
      .catch(err => log("level-up spell pool warm-up failed", err));
  }

  /* -------------------------------------------- */
  /*  Navigation                                  */
  /* -------------------------------------------- */

  /** @override */
  _ctx() {
    return {
      state: this.state, driver: this.state.driver, source: this.#source,
      spells: this.#spells, equipment: this.#equipment, store: this.#store, app: this
    };
  }

  /** Re-entrancy guard: a second Apply click while the first is writing must be a no-op. */
  #applying = false;

  /**
   * @override
   * The footer's Apply button: commit the whole level-up in one go — the driver's clone (the level
   * decisions), then the staged spell picks and any swap onto the freshly-updated actor, then close.
   * The spell picks are staged on the state by the pre-review spell step, so a single Apply covers
   * everything the review screen showed. A commit failure leaves the actor untouched and the
   * window open for a retry; a spell failure after a successful commit keeps the level (it is
   * already applied) and tells the player to add the spells from the sheet.
   *
   * The Ember hand-off differs on both ends: the gear and spells are folded onto the clone *before*
   * the commit (Ember performs the write, so a second write of ours would race it), and afterwards
   * the sheet is left alone — Ember's builder finishes the character and swaps the sheet itself.
   * See {@link module:levelup/ember-creation}.
   */
  async _finish() {
    if ( this.#applying || !this.#requiredSteps.every(s => s.isComplete(this.state)) ) return;
    this.#applying = true;
    const ember = this.state.emberCreation;

    if ( ember ) {
      try {
        await stageEmberGear(this.state, this._ctx());
      } catch ( err ) {
        // Non-fatal: the advancements are the important part, and gear can be added on the sheet.
        log("staging Ember starting equipment / spells failed", err);
        ui.notifications?.warn(t("levelup.notify.emberGearFailed"));
      }
    }

    try {
      await this.state.driver.commit();
    } catch ( err ) {
      log("level-up apply failed", err);
      ui.notifications?.error(t("levelup.notify.applyFailed"));
      this.#applying = false;
      return;
    }
    this.state.committed = true;

    // The sourceTag guard covers a rare edge: picks staged while the class was briefly a caster
    // (an Eldritch Knight pick later undone) must not be created against a non-caster.
    const { actor } = this.state;
    const { sourceTag, method, create, deleteIds } = spellChanges(this.state);
    if ( !ember && sourceTag && (create.length || deleteIds.length) ) {
      try {
        // Create the replacements before deleting the swapped-out spell, so a failure part-way
        // can only ever leave an extra spell to tidy up — never a destroyed one.
        await applyLevelUpSpells(actor, sourceTag, create, method);
        if ( deleteIds.length ) await actor.deleteEmbeddedDocuments("Item", deleteIds, { render: false });
      } catch ( err ) {
        log("level-up spell grant failed", err);
        ui.notifications?.error(t("levelup.notify.spellsFailed"));
      }
    }

    await this.close({ force: true });
    if ( !ember ) actor?.sheet?.render(true);
  }

  /**
   * Confirm before a close that would lose the player's work. Every exit path funnels through
   * here — the Cancel button, the window frame's close, Escape, and programmatic closes. Nothing
   * touches the real actor until Apply, so closing with decisions made (or spells staged)
   * discards the whole level-up — safe, but rolled HP and picked features silently vanish, hence
   * the prompt. Apply itself passes `force` because its work is already saved; an untouched
   * window (or a pre-seeded one the player never interacted with) closes without ceremony.
   *
   * An abandoned Ember hand-off has one extra obligation: Ember's builder is blocked on the
   * manager we suppressed, so it has to be released or it waits forever. Discarding drops only the
   * advancement answers — the character keeps everything Ember already wrote, and its Complete
   * button will offer the questions again.
   * @override
   */
  async close(options = {}) {
    const abandoning = this.state.emberCreation && !this.state.committed;
    if ( !options.force && !this.state.committed && this.state.hasPlayerInput() ) {
      const key = this.state.emberCreation ? "levelup.emberCancel" : "levelup.cancel";
      if ( !await this._confirmDiscard(`${key}.title`, `${key}.body`) ) return this;
    }
    if ( abandoning ) await abandonEmberCreation(this.state.driver?.manager);
    return super.close(options);
  }

  /**
   * Every exit funnels through here — the Cancel button, the window frame's close, and any
   * programmatic close. The sheet's level selector shows the *target* level the player picked to
   * open this wizard, but that pick is never persisted: the driver works on a throwaway clone and
   * only {@link LevelUpDriver#commit} touches the real actor. So on any close we re-render the actor
   * sheet, snapping the selector back to the character's actual level after a cancel. When the
   * level-up was committed the same re-render simply reflects the new level.
   * @override
   */
  _onClose(options) {
    super._onClose(options);
    // In the Ember hand-off the actor's sheet *is* Ember's character builder, waiting behind this
    // window with all of the player's creation choices in it. Re-rendering it would reset that UI,
    // and there is no level selector to snap back — so leave it to Ember either way.
    if ( this.state.emberCreation ) return;
    const sheet = this.state.actor?.sheet;
    if ( sheet?.rendered ) sheet.render(true);
  }
}
