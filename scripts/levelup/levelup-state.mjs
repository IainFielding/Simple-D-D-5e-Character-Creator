/**
 * The character level on whose screen a decision belongs. Usually the decision's own `level`, but
 * a feat's synthesised sub-choices inherit the granting ASI's level (see {@link LevelUpDriver}).
 * @param {{screenLevel?: number, level: number}} record
 * @returns {number}
 */
export function recordLevel(record) {
  return record.screenLevel ?? record.level;
}

/**
 * The subset of `records` that belong to a given level's screen, in their original order (so the
 * array index a record had — which the templates use to address it — is recoverable via indexOf).
 * @param {object[]} records
 * @param {number} level
 * @returns {object[]}
 */
export function atLevel(records, level) {
  // Tolerates an absent array: every level-screen component is asked about every level, and a state
  // assembled from partial data (the block tests build one per decision type) simply has no array
  // for the kinds it does not exercise. Adding a component should not break the others.
  return (records ?? []).filter(r => recordLevel(r) === level);
}

/**
 * The description an advancement carries for its decision — the dnd5e `hint` field (e.g. the
 * Wizard's Scholar: "While studying magic, you also specialized in another field of study…") —
 * enriched so any `@UUID[…]` markup renders as real links. "" when the advancement has none, so
 * templates can gate on it directly.
 * @param {{advancement: object}} record
 * @returns {Promise<string>}
 */
export async function advancementHint(record) {
  const hint = record.advancement?.hint?.trim();
  if ( !hint ) return "";
  return foundry.applications.ux.TextEditor.implementation.enrichHTML(hint, { secrets: false });
}

import { computeSpellPlan } from "./steps/lvl-spells-step.mjs";

/**
 * Session record for one level-up. Deliberately thin: it carries the actor, the class being
 * levelled, the from→to character levels for display, and a reference to the {@link LevelUpDriver}
 * that owns the working clone and the hit-point decisions. All mutation of the clone happens
 * through the driver; this object holds no DOM or Application concerns.
 *
 * For a junior dev — the mental model of a level-up:
 *   - The real actor is NOT touched while the player is deciding. The driver holds a "clone" (an
 *     in-memory copy), and every decision is applied to that clone. Cancel = throw the clone away.
 *   - "commit" is the moment the clone's changes are written to the real actor (on Apply). After
 *     that, `committed` is true and the post-commit spell step edits the real actor directly.
 *   - This is the counterpart of CreatorState: it's the "form data" for a level-up. The getters
 *     below (hpSteps, asiSteps, …) just forward to the driver's decision arrays for convenience.
 */
export class LevelUpState {

  /** @type {Actor5e} The real actor being levelled (untouched until the driver commits). */
  actor;
  /**
   * The wrapped advancement manager, or null while the session is still on the Class step (a
   * `chooseClass` session opens without one; {@link adoptDriver} installs it once a class is
   * picked). Every decision getter below degrades to "nothing yet" while it is null.
   * @type {import("./manager-driver.mjs").LevelUpDriver|null}
   */
  driver = null;
  /** @type {Item5e} The class item gaining levels (null until a driver is adopted). */
  classItem = null;

  /**
   * Whether this session leads with the in-wizard Class step (the button/context-menu flow on a
   * character with more than one levellable option). Sessions claimed from an already-built
   * manager — the sheet's level selector, a class drag-drop — arrive with the class decided and
   * skip the step.
   */
  needsClassChoice = false;

  /**
   * Whether this session is the Ember hand-off: Ember's own builder has assigned the ancestry,
   * background and class, and handed its advancement manager to us to ask the level-1 questions it
   * doesn't (advancements, starting equipment, spells). Changes three things — the window's title,
   * the rail (a starting-equipment step joins it) and the Apply path (Ember performs the write, so
   * gear and spells are staged onto the clone rather than written after the commit).
   * See {@link module:levelup/ember-creation}.
   */
  emberCreation = false;

  /**
   * The starting-equipment selection, one entry per origin: `{ selectedOption, orSelections }`.
   * Only the Ember hand-off's rail carries the equipment step, so this stays empty on an ordinary
   * level-up. Shaped exactly like the creator's own `state.equipment` so the creation step module
   * is reused verbatim (see {@link module:steps/equipment-step}).
   * @type {Record<string, {selectedOption: number, orSelections: Record<string, string>}>}
   */
  equipment = {};

  /** Total spendable copper the chosen equipment option yields — written by the equipment step. */
  storeBudgetCp = 0;

  /**
   * The starting-gold shop's cart and its filter state, shaped exactly like the creator's so the
   * Store step module is reused verbatim: `purchases` is `uuid -> {qty, cp, name, img}` with the
   * unit price cached at add time. Only the Ember hand-off's rail carries the step.
   */
  store = { purchases: {} };
  storeCategory = "";
  storeSubtype = "";

  /**
   * The Class step's current pick: `{ kind: "existing", id }` for one of the actor's classes or
   * `{ kind: "new", uuid }` for a multiclass, null while undecided. Kept even though the adopted
   * driver implies it, so the step can mark the active card across re-renders.
   * @type {{kind: "existing", id: string}|{kind: "new", uuid: string}|null}
   */
  classSelection = null;

  /**
   * Which face of the Class step is showing. The step opens on its route screen — the character's
   * own classes as the obvious picks, with a muted card for starting a new one — and flips to the
   * class browser (`true`) only when that muted card is clicked. Purely presentational: the pick
   * itself lives in {@link classSelection}, so flipping back and forth changes nothing.
   */
  classBrowse = false;
  /** Character level before this level-up. */
  fromLevel;
  /** Character level after this level-up. */
  toLevel;
  /**
   * Keys of the level-screen blocks the player has collapsed. Empty by default, so every block
   * starts expanded (the layout as it was before blocks became collapsible); a key is added when
   * its header is toggled shut. Survives re-renders because the shell rebuilds steps but keeps
   * this state object. See {@link module:levelup/steps/level-step}.
   * @type {Set<string>}
   */
  collapsedBlocks = new Set();

  /**
   * Whether the level grant has been committed to the real actor. Flipped by the shell's Apply
   * right after the driver's clone lands, so the spell staging that follows (and any close-path
   * logic) reads the updated actor rather than the clone. Starts false; the level-up decisions
   * drive the clone until it is set, and the window closes shortly after it flips.
   */
  committed = false;

  /**
   * Spells chosen on the pre-review spell step, staged here and written to the actor by the
   * shell's single Apply after the level commit (mirroring how creation stages picks then grants
   * them). Discarded with everything else on cancel.
   * @type {{uuid:string, id:string, name:string, img:string, level:number}[]}
   */
  selectedCantrips = [];
  selectedSpells = [];

  /**
   * A class spell list the player named themselves, when the caster's own could not be worked out
   * — see {@link module:data/spell-source.registeredClassLists}. Empty in every ordinary build:
   * only a caster whose list resolves to nothing ever asks.
   *
   * Session state, deliberately. Persisting it would be a second place a spell list can be
   * declared, able to disagree with the registry that is the real answer; the fix for a caster that
   * needs this is for its content to register a list, and an override that outlived the window
   * would quietly hide that.
   * @type {string}
   */
  spellListOverride = "";

  /** Transient UI state for the spell step: the active tab and the focused spell's UUID. */
  spellTab = "cantrips";
  focusedSpellUuid = null;

  /**
   * The spell list's client-side filters. They filter the DOM directly, but every spell click
   * re-renders the stage and rebuilds the controls — so the values live here and the shell restores
   * them after each render rather than letting them reset. Cleared only with the window.
   *
   * One field per control in `SPELL_FILTER_CONTROLS`; `spellPropFilter` holds a `"<key>:yes|no"`
   * pair ("Ritual only", "Without Concentration") rather than a bare key.
   */
  spellSearch = "";
  spellLevelFilter = "";
  spellSchoolFilter = "";
  spellPropFilter = "";
  spellCastingFilter = "";
  spellRangeFilter = "";

  /**
   * Phase 4b spell swaps: an owned cantrip / leveled spell the player has marked to replace this
   * level-up (the 2024 "swap one spell" rule). Marking one frees a slot in that bucket to learn a
   * different spell; on Finish the marked item is deleted only if the freed slot was actually used.
   * `{ id, name }` of the actor's spell item, or null.
   * @type {{id:string, name:string}|null}
   */
  swapCantrip = null;
  swapSpell = null;

  /**
   * Which chat card this session owes the table when it finishes (see
   * {@link module:build/chat-summary}):
   *  - `"levelup"`  — the ordinary case: a card describing what the level brought.
   *  - `"creation"` — this session is the tail of a character build (the player asked to start
   *                   above level 1, so the creator handed the 1 → N climb straight to us). The
   *                   character is only finished when *this* commits, so the creation card is
   *                   ours to post, and no level-up card is posted at all.
   *  - `"none"`     — announce nothing (the Ember hand-off; see the constructor).
   * Either way the setting still has the final say — `"off"` posts nothing regardless.
   * @type {"levelup"|"creation"|"none"}
   */
  announce = "levelup";

  /**
   * The creator state this character was built from, when `announce === "creation"` — i.e. when
   * this session is the tail of a build that started above level 1. Null for an ordinary level-up.
   *
   * Carried for one reason: the public `characterCreated` hook can finish in either wizard, and a
   * payload that sometimes omits the state would be worse to consume than one that threads it
   * through. Nothing in the level-up itself reads it.
   * @type {import("../state/creator-state.mjs").CreatorState|null}
   */
  creationState = null;

  /**
   * Whether the player asked for a character-sheet PDF once this level-up is applied. Set from the
   * review screen's export control and acted on by {@link module:levelup/levelup-shell} after the
   * commit — see {@link module:build/pdf-export}.
   *
   * Seeded from the creator's answer on a creation climb, so a player who ticked the box in the
   * creator sees it already ticked here rather than being asked the same question twice about the
   * same character.
   * @type {boolean}
   */
  exportPdf = false;

  /**
   * @param {Actor5e} actor
   * @param {import("./manager-driver.mjs").LevelUpDriver|null} [driver]  Prepared driver, or null
   *   to open on the Class step and adopt one later.
   * @param {object} [options]
   * @param {boolean} [options.chooseClass=false]    Lead with the in-wizard Class step.
   * @param {boolean} [options.emberCreation=false]  This session is the Ember hand-off.
   * @param {"levelup"|"creation"|"none"} [options.announce]  Override the chat card this session
   *   posts on Apply; defaults by flow (see {@link announce}).
   * @param {import("../state/creator-state.mjs").CreatorState} [options.creationState]  See
   *   {@link creationState}.
   */
  constructor(actor, driver = null, {
    chooseClass = false, emberCreation = false, announce = null, creationState = null
  } = {}) {
    this.actor = actor;
    this.fromLevel = actor.system?.details?.level ?? 0;
    this.toLevel = this.fromLevel + 1;
    this.needsClassChoice = chooseClass;
    this.emberCreation = emberCreation;
    this.creationState = creationState;
    this.exportPdf = !!creationState?.exportPdf;
    // The Ember hand-off announces nothing by default: Ember's builder finishes the character
    // *after* our Apply (it owns the final write and the sheet swap), so a card posted here could
    // describe a character that is still a step from done. Ember owns that moment, not us.
    this.announce = announce ?? (emberCreation ? "none" : "levelup");
    if ( driver ) this.adoptDriver(driver);
  }

  /**
   * The origin documents the starting-equipment step should read its trees from, or null to let the
   * {@link module:data/equipment-source.EquipmentSource} resolve compendium UUIDs as usual. The
   * Ember hand-off returns the clone's own class and background items: Ember builds its background
   * by combining a culture and a path at completion time, so it has no compendium entry — but it
   * does carry both origins' concatenated `system.startingEquipment`.
   * @returns {{class: Item5e|null, background: Item5e|null}|null}
   */
  equipmentDocs() {
    const clone = this.driver?.clone;
    if ( !this.emberCreation || !clone ) return null;
    return {
      class: clone.items.find(i => i.type === "class") ?? null,
      background: clone.items.find(i => i.type === "background") ?? null
    };
  }

  /**
   * Install a prepared driver: the moment the session's class is decided. Derives the class item
   * and target level exactly as the constructor's driver path always has.
   * @param {import("./manager-driver.mjs").LevelUpDriver} driver
   */
  adoptDriver(driver) {
    this.driver = driver;
    this.classItem = driver.steps.find(s => s.class)?.class?.item ?? null;
    // The trailing marker step carries the final character level the manager is targeting.
    this.toLevel = driver.steps.reduce((max, s) => Math.max(max, s.level ?? 0), this.fromLevel);
  }

  /**
   * Discard the adopted driver (the player changed their mind on the Class step). The driver's
   * clone dies with it — nothing was written to the actor — but everything staged against the old
   * class (spell picks, swaps, collapsed blocks, spell-step UI) must go too, or it would leak
   * into the next class's session.
   */
  clearDriver() {
    this.driver = null;
    this.classItem = null;
    this.toLevel = this.fromLevel + 1;
    this.selectedCantrips = [];
    this.selectedSpells = [];
    this.swapCantrip = null;
    this.swapSpell = null;
    this.spellTab = "cantrips";
    this.focusedSpellUuid = null;
    // The filters narrowed the old class's list. A school or casting time that matched half of it
    // can easily match none of the next one, leaving the player on an empty list with no clue why.
    this.spellSearch = "";
    this.spellLevelFilter = "";
    this.spellSchoolFilter = "";
    this.spellPropFilter = "";
    this.spellCastingFilter = "";
    this.spellRangeFilter = "";
    // The override answered "which list does *this* caster use", so it dies with the caster.
    this.spellListOverride = "";
    this.collapsedBlocks.clear();
  }

  /**
   * Whether the levelled class is brand-new to the character — a multiclass: until the commit,
   * the class item exists only on the driver's clone, not the real actor.
   * @returns {boolean}
   */
  get isNewClass() {
    return !!this.classItem && !this.actor.items?.get(this.classItem.id);
  }

  /**
   * Whether the wizard should name the class on its level labels. The decision records are keyed
   * by *class* level, so for a character with more than one class (or gaining one) a bare
   * "Level 3" is ambiguous between class and character level — "Wizard 3" isn't.
   * @returns {boolean}
   */
  get isMulticlassed() {
    return this.isNewClass || (this.actor.items?.filter(i => i.type === "class").length ?? 0) > 1;
  }

  /**
   * The spell capacity this level-up opens up, computed from the driver's clone (whose derived data
   * already reflects the new level). Used to decide whether the spell step exists and, once
   * committed, what the step offers. Sync — the spell *pool* is loaded separately by the step.
   * @returns {import("./steps/lvl-spells-step.mjs").SpellPlan}
   */
  spellPlan() {
    // No driver yet (the Class step): nothing has changed, so there is nothing to offer.
    if ( !this.driver && !this.committed ) return computeSpellPlan(this.actor, null);
    const source = this.spellSource;
    const classItem = this.classItem ? source.items.get(this.classItem.id) : null;
    return computeSpellPlan(source, classItem);
  }

  /**
   * The actor-alike whose spells and derived data the spell step should read: the driver's clone
   * while the level-up is still being decided (its derived data already reflects the gained level,
   * and it carries anything this level-up's advancements just granted), and the real actor once the
   * commit has happened. Shared with the step's own "already owned" test so the capacity arithmetic
   * and the pool can never disagree about which character they are looking at.
   * @returns {Actor5e}
   */
  get spellSource() {
    return (this.committed || !this.driver) ? this.actor : this.driver.clone;
  }

  /**
   * Whether a spell step should appear (between the level screens and the review): the leveled
   * class is a caster and this level-up opened new cantrip or prepared-spell capacity.
   * @returns {boolean}
   */
  hasSpellStep() {
    return this.spellPlan().hasDelta;
  }

  /** The hit-point decisions surfaced for this level-up (one per gained level). */
  get hpSteps() {
    return this.driver?.hpSteps ?? [];
  }

  /** The feature-choice decisions surfaced for this level-up. */
  get choiceSteps() {
    return this.driver?.choiceSteps ?? [];
  }

  /** The ability-score-improvement decisions surfaced for this level-up. */
  get asiSteps() {
    return this.driver?.asiSteps ?? [];
  }

  /** The trait decisions (Weapon Mastery, language picks…) surfaced for this level-up. */
  get traitSteps() {
    return this.driver?.traitSteps ?? [];
  }

  /** The subclass decisions surfaced for this level-up. */
  get subclassSteps() {
    return this.driver?.subclassSteps ?? [];
  }

  /** The optional-class-feature decisions (Tasha's optional and replacement grants). */
  get optionalGrantSteps() {
    return this.driver?.optionalGrantSteps ?? [];
  }

  /** The spell-grant ability decisions (a species lineage spell at a class level). */
  get grantSteps() {
    return this.driver?.grantSteps ?? [];
  }

  /**
   * Whether the player has actually made a decision yet — used by the shell to decide if closing
   * before Apply deserves a "discard this level-up?" confirmation. Pre-seeded defaults (average
   * hit points, a granted spell's default casting ability) don't count; anything the player
   * picked, rolled, or spent does.
   * @returns {boolean}
   */
  hasPlayerInput() {
    const d = this.driver;
    // On the Class step nothing exists to lose: a bare class pick costs one click to redo.
    if ( !d ) return false;
    return this.hasStagedSpells()
      || this.hpSteps.some(r => r.mode !== "avg")
      || this.subclassSteps.some(r => d.subclassState(r).chosen)
      || this.traitSteps.some(r => d.traitState(r).chosen.size > 0)
      || this.choiceSteps.some(r => {
        const st = d.choiceState(r);
        return st.selected.size > 0 || !!st.replacing;
      })
      || this.asiSteps.some(r => {
        const st = d.asiState(r);
        return st.type === "feat" || st.assigned > 0;
      });
  }

  /**
   * Whether the spell step holds staged, unsaved picks (or a marked swap) that closing the
   * window would silently discard.
   * @returns {boolean}
   */
  hasStagedSpells() {
    return this.selectedCantrips.length > 0 || this.selectedSpells.length > 0
      || !!this.swapCantrip || !!this.swapSpell;
  }

  /**
   * The gained character levels that each get a screen, in ascending order. Every gained level
   * grants at least hit points, so the decisions across all arrays define the set; a choice
   * revealed later (a subclass feature, a feat's grant) carries the screen level it belongs to and
   * folds into one of these rather than adding a new screen.
   * @returns {number[]}
   */
  gainedLevels() {
    const levels = new Set();
    for ( const arr of [this.hpSteps, this.asiSteps, this.subclassSteps, this.choiceSteps, this.traitSteps,
      this.grantSteps, this.optionalGrantSteps] ) {
      for ( const record of arr ) levels.add(recordLevel(record));
    }
    return [...levels].sort((a, b) => a - b);
  }
}
