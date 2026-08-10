import { ABILITIES, t } from "../config.mjs";

/**
 * The origins that can carry an ability-score increase. Which one actually does depends on the
 * edition — 2024 puts it on the background, 2014 on the species — so both are modelled and the
 * step that owns each decides whether it has anything to show.
 * @type {Array<"species"|"background">}
 */
export const ORIGIN_ASI_SOURCES = ["species", "background"];

/**
 * The single source of truth for every choice the player makes in the creator.
 *
 * This is a plain data record: it holds values and performs only the data
 * derivations that several layers need (resolved ability scores). All UI
 * concerns live in the step modules; all persistence lives in the assembler.
 * Nothing here imports an Application or touches the DOM.
 *
 * For a junior dev: think of this as the "form data" for the whole wizard. Steps read
 * and write these fields; nothing here is saved to the world until the assembler runs at
 * Create. A few field types recur:
 *   - selections (e.g. classUuid)      – what the player picked, stored as compendium UUIDs
 *   - "…Cache" / "…Info" fields         – pre-resolved data so the *synchronous* isComplete()
 *                                         gates can run without awaiting compendium reads
 *   - "Transient …" fields              – pure UI state (active tab, focused row); not persisted
 * Fields are given as class field initialisers, so a fresh CreatorState starts at these defaults.
 */
export class CreatorState {

  /** @type {Actor} The draft actor being built. */
  actor;

  /** Origin selections, stored as source-compendium UUIDs. */
  classUuid = null;
  speciesUuid = null;
  backgroundUuid = null;

  /**
   * The character level the player wants to end up at. The wizard itself always builds a level-1
   * character — anything above 1 is handed to the level-up wizard after Create, which drives the
   * whole 1→target jump on one advancement manager (see {@link module:levelup/intercept}). Kept out
   * of {@link resetClassDependent} on purpose: "I want a level 5 character" survives changing which
   * class they are.
   */
  targetLevel = 1;

  /**
   * Identity & biography fields. `name` mirrors the actor name (the only mandatory
   * field); the rest are optional and written to `actor.system.details` on build.
   */
  details = {
    name: "", alignment: "", faith: "", gender: "", eyes: "", hair: "", skin: "",
    height: "", weight: "", age: "", trait: "", ideals: "", bonds: "", flaws: "",
    appearance: "", biography: ""
  };

  /** Portrait / prototype-token visual settings, applied to the actor on build. */
  portrait = "icons/svg/mystery-man.svg";
  tokenImg = "icons/svg/mystery-man.svg";
  tokenRingImg = "icons/svg/mystery-man.svg";
  tokenRingEnabled = false;
  tokenLockRotation = false;

  /** Transient Details-step UI: which token image tab is shown ("token"|"ring"). Not persisted. */
  tokenTab = "token";

  /**
   * Transient Details-step UI: which name pool the random-name roller draws from —
   * "any" (both), "male", or "female". Independent of the free-text gender field. Not persisted.
   */
  nameGender = "any";

  /**
   * Transient Details-step UI: which naming style the roller uses — "auto" to follow the
   * chosen species, or an explicit style key (e.g. "elf") to override it. Not persisted.
   */
  nameStyle = "auto";

  /**
   * Level-1 spell picks (spellcaster classes only), each `{uuid, id, name, img, level}`.
   * Cleared whenever the class selection changes — a spell list is class-specific.
   */
  selectedCantrips = [];
  selectedSpells = [];

  /**
   * Advancement choices made on the Choices step: source -> selKey -> chosen key/uuid[].
   * Each source's bucket is cleared when that origin selection changes. Also holds the
   * feat-spells step's picks: a feat's spell `ItemChoice` uuids under its advancement id, and the
   * chosen casting ability under `"<advId>::ability"` (read by the assembler's `applyItemChoice`).
   */
  advChoices = { class: {}, background: {}, species: {} };

  /**
   * Feat-spells step (Magic Initiate) — the player's picks per grant, keyed `${source}:${featUuid}`:
   * `{ list, ability, cantrips: uuid[], spells: uuid[] }`. The assembler reads these to create the
   * feat's spells directly on the actor (the PHB feat carries no advancement to hang them on).
   */
  featSpells = {};

  /**
   * Cache of the resolved feat-spell *grants* (from {@link module:steps/feat-spells-step}), so the
   * synchronous `applicable`/`isComplete` gates can read them. Refreshed whenever origin selections
   * or feat picks change (the Choices and Feat-Spells steps both refresh it).
   * @type {object[]}
   */
  featSpellCache = [];

  /** Transient feat-spells-step UI: active grant, active tab, focused spell. Not persisted. */
  activeFeatKey = null;
  featSpellTab = "cantrips";
  focusedFeatSpellUuid = null;

  /**
   * Transient Choices-step UI: which decision row of the guided checklist is expanded.
   * `undefined` = auto (open the first unfinished decision); a decision key = that row;
   * `""` = the player collapsed everything. Not persisted; resolved against the available
   * decisions on each render, so a stale key falls back to the first unfinished decision.
   */
  openDecision = undefined;

  /** Starting-equipment selection per source: { selectedOption, orSelections }. */
  equipment = {
    class: { selectedOption: 0, orSelections: {} },
    background: { selectedOption: 0, orSelections: {} }
  };

  /**
   * Transient: set once the player has opened the (optional) Equipment step, so its rail tick
   * stays off until then rather than reading complete from the start. Not persisted.
   */
  equipmentVisited = false;

  /**
   * Starting-gold store cart (the optional Store step): uuid -> `{qty, cp, name, img}`.
   * `cp` caches the multiplied unit price the item was added at, so the synchronous
   * completion gate and the rail summary can total the cart without compendium reads.
   * The assembler creates these items and deducts the total from starting currency.
   */
  store = { purchases: {} };

  /** Transient: set once the player has opened the (optional) Store step. Not persisted. */
  storeVisited = false;

  /** Transient Store-step UI: the active category filter ("" = all). Not persisted. */
  storeCategory = "";

  /**
   * Transient Store-step UI: the active subtype filter within the chosen category
   * ("" = all). Cleared whenever the category changes — subtype keys only mean anything
   * inside their category (tool "art" is artisan's tools; loot "art" is an art object).
   * Not persisted.
   */
  storeSubtype = "";

  /**
   * The spendable store budget in copper — the currency the current equipment-step selection
   * yields — cached so the Store step's synchronous `applicable`/`isComplete` gates can read
   * it. Refreshed by the Equipment and Store steps' contexts (both know the live selection).
   */
  storeBudgetCp = 0;

  /** Transient Spells-step UI: which tab is shown and which spell is focused. Not persisted. */
  spellTab = "cantrips";
  focusedSpellUuid = null;

  /**
   * Slim spellcasting summary for the current class — `{isSpellcaster, maxCantrips, maxSpells}`
   * — so the (synchronous) completion gate can tell whether the Spells step applies and
   * whether every known spell has been chosen. Refreshed whenever the class changes. Null
   * until a class is picked.
   */
  spellInfo = null;

  /**
   * The most recently resolved advancement-choice requirements (from the choice
   * resolver). Cached so the synchronous `isComplete` check — and the assembler — can
   * read completion without re-resolving documents. Refreshed whenever an origin
   * selection or a choice pick changes. `undefined` until first resolved.
   * @type {{sources: object[], hasAny: boolean}|undefined}
   */
  choiceCache;

  /** "point-buy" | "standard-array" | "roll" */
  abilityMethod = "point-buy";

  /** Point-buy working values (8..15 per ability). */
  pointBuy = { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };

  /** array/roll: ability key -> index into the value pool, or null when unassigned. */
  assignment = { str: null, dex: null, con: null, int: null, wis: null, cha: null };

  /** Dice results for the "roll" method, in roll order. */
  rolledPool = [];

  /**
   * Player-allocated ability increases granted by an origin, on top of any that origin fixes
   * itself, keyed by which origin granted them. Which origin carries an increase depends on the
   * edition: a 2024 background does, a 2014 species does, and neither does both. Reset whenever
   * that origin's selection changes (see {@link resetSourceChoices}).
   */
  originAbilities = {
    background: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    species: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }
  };

  /**
   * Each selected origin's ability-score-improvement config, cached so the synchronous completion
   * checks can see them without re-resolving the documents. `undefined` = not yet resolved;
   * `null` = that origin grants no increase.
   * @type {Record<"background"|"species", {id: string, points: number, canAllocate: boolean,
   *   cap: number, fixed: object, locked: string[]}|null|undefined>}
   */
  originAsi = { background: undefined, species: undefined };

  constructor(actor) {
    this.actor = actor;
    this.#prefillFromActor(actor);
  }

  /* -------------------------------------------- */
  /*  Derived data                                */
  /* -------------------------------------------- */
  //
  // These methods compute values from the raw fields above rather than storing them, so there's
  // only one place the truth lives. The "reset…" methods below clear fields that depend on a
  // selection, and are called when that selection changes (e.g. a new class wipes its spell picks).

  /**
   * The pool of assignable values for the current method, or null for point-buy.
   * Standard array is fixed; roll uses whatever was rolled.
   * @returns {number[]|null}
   */
  abilityPool() {
    if ( this.abilityMethod === "standard-array" ) return [15, 14, 13, 12, 10, 8];
    if ( this.abilityMethod === "roll" ) return this.rolledPool;
    return null;
  }

  /**
   * Final base ability scores (before species/background bonuses), resolved for
   * whichever method is active. Unassigned slots resolve to 8.
   * @returns {Record<string, number>}
   */
  resolvedScores() {
    if ( this.abilityMethod === "point-buy" ) return { ...this.pointBuy };
    const pool = this.abilityPool() ?? [];
    const out = {};
    for ( const key of ABILITIES ) {
      const idx = this.assignment[key];
      out[key] = (idx != null && pool[idx] != null) ? pool[idx] : 8;
    }
    return out;
  }

  /**
   * The ability increase one origin confers per ability: the fixed part plus whatever the player
   * allocated in the wizard. Only abilities with a non-zero increase are present, so callers can
   * treat a missing key as "no bonus".
   * @param {"background"|"species"} source
   * @returns {Record<string, number>}
   */
  originDeltas(source) {
    const asi = this.originAsi[source];
    if ( !asi ) return {};
    const out = {};
    for ( const key of ABILITIES ) {
      const total = Number(asi.fixed?.[key] ?? 0) + (this.originAbilities[source]?.[key] ?? 0);
      if ( total ) out[key] = total;
    }
    return out;
  }

  /**
   * Every origin increase merged, for the Review screen: the combined bonus per ability plus which
   * origins contributed it, so the pill can name them rather than assuming the background. Only
   * abilities with a non-zero increase are present.
   * @returns {Record<string, {total: number, sources: Array<{source: string, bonus: number}>}>}
   */
  abilityDeltas() {
    const out = {};
    for ( const source of ORIGIN_ASI_SOURCES ) {
      for ( const [key, bonus] of Object.entries(this.originDeltas(source)) ) {
        const entry = out[key] ??= { total: 0, sources: [] };
        entry.total += bonus;
        entry.sources.push({ source, bonus });
      }
    }
    return out;
  }

  /**
   * Forget everything keyed to the class: its level-1 spell picks, its advancement
   * choices, and its equipment selection. Called when the class selection changes so
   * a spell list or skill pick never carries over to a different class.
   */
  resetClassDependent() {
    this.selectedCantrips = [];
    this.selectedSpells = [];
    this.advChoices.class = {};
    this.#forgetFeatSpellLists("class");
    this.equipment.class = { selectedOption: 0, orSelections: {} };
  }

  /**
   * Forget one origin source's advancement choices (and equipment and ability increase, where it
   * has either). Called when that source's selection changes.
   *
   * The ability increase is cleared here rather than by the owning step so *every* path that drops
   * a selection clears it — including `dropOffEditionOrigins`, which swaps a 2024 class for a 2014
   * one and would otherwise leave the discarded background's increase on the Review screen.
   * @param {"class"|"background"|"species"} source
   */
  resetSourceChoices(source) {
    this.advChoices[source] = {};
    this.#forgetFeatSpellLists(source);
    if ( this.equipment[source] ) this.equipment[source] = { selectedOption: 0, orSelections: {} };
    if ( this.originAbilities[source] ) {
      this.originAbilities[source] = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
      this.originAsi[source] = undefined;
    }
  }

  /** Drop the feat-spells picks belonging to one origin (keys `${source}:…`). */
  #forgetFeatSpellLists(source) {
    for ( const key of Object.keys(this.featSpells) ) {
      if ( key.startsWith(`${source}:`) ) delete this.featSpells[key];
    }
  }

  /* -------------------------------------------- */
  /*  Prefill                                     */
  /* -------------------------------------------- */

  /**
   * Seed the draft from an actor that already carries choices, so re-opening the
   * builder resumes rather than restarts. Only fields we can confidently round-trip
   * are read; everything else keeps its default.
   */
  #prefillFromActor(actor) {
    if ( !actor ) return;

    // An item on the actor remembers the compendium entry it was copied from in _stats.compendiumSource.
    // That UUID is exactly what our selection fields store, so we can map an existing actor's class/
    // background/species items back to the picks that produced them. (dnd5e's item type for species is "race".)
    const source = item => item?._stats?.compendiumSource ?? null;
    this.classUuid = source(actor.items?.find(i => i.type === "class"));
    this.backgroundUuid = source(actor.items?.find(i => i.type === "background"));
    this.speciesUuid = source(actor.items?.find(i => i.type === "race"));

    const abil = actor.system?.abilities ?? {};
    const values = ABILITIES.map(k => abil[k]?.value ?? 10);
    // A fresh character defaults every score to 10; only adopt non-default values.
    if ( values.some(v => v !== 10) ) {
      for ( const key of ABILITIES ) {
        this.pointBuy[key] = Math.min(15, Math.max(8, abil[key]?.value ?? 8));
      }
    }

    // Identity & biography — round-trip whatever the actor already carries. `ideals`,
    // `bonds`, `flaws` map to the singular dnd5e keys; biography is a rich-text object.
    const d = actor.system?.details ?? {};
    // The draft is created with a placeholder name; don't treat that as a real entry,
    // so the Details step stays incomplete until the player actually names the character.
    const placeholder = t("common.newCharacter");
    this.details = {
      name: (actor.name && actor.name !== placeholder) ? actor.name : "",
      alignment: d.alignment ?? "", faith: d.faith ?? "", gender: d.gender ?? "",
      eyes: d.eyes ?? "", hair: d.hair ?? "", skin: d.skin ?? "",
      height: d.height ?? "", weight: d.weight ?? "", age: d.age ?? "",
      trait: d.trait ?? "", ideals: d.ideal ?? "", bonds: d.bond ?? "",
      flaws: d.flaw ?? "", appearance: d.appearance ?? "",
      biography: d.biography?.value ?? ""
    };

    // Portrait & prototype-token visuals. Read each from the actor; if a value is
    // absent or can't be read, keep the field default declared above (FALLBACK_IMG).
    const read = fn => { try { return fn(); } catch { return undefined; } };
    const token = read(() => actor.prototypeToken) ?? {};
    this.portrait = read(() => actor.img) || this.portrait;
    this.tokenImg = read(() => token.texture?.src) || this.tokenImg;
    this.tokenRingImg = read(() => token.ring?.subject?.texture) || this.tokenRingImg;
    this.tokenRingEnabled = !!read(() => token.ring?.enabled);
    this.tokenLockRotation = !!read(() => token.lockRotation);
  }
}
