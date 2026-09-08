import { log, levelUpHpRollToChat } from "../config.mjs";
import { withItemSegment, addedEntries } from "../data/advancement-util.mjs";
import { phbWeaponIcon } from "../data/weapon-source.mjs";
import { bg3TraitIcon } from "../data/bg3-icons.mjs";
import { findAsiFeats, classifyAsiFeats } from "../data/choice-resolver.mjs";

/**
 * Drives a native dnd5e {@link AdvancementManager} from the outside.
 *
 * The system's manager keeps its whole pipeline private (`#forward`, `#synthesizeSteps`,
 * `#complete`), and its `render()` aborts the moment our `preAdvancementManagerRender` hook
 * returns `false` — so we cannot ask it to step for us. Instead we take the manager it has
 * already built (which holds the `actor`, an in-memory `clone`, and a fully-enumerated
 * `steps` array) and re-run the relevant pieces of that pipeline ourselves against the clone.
 *
 * The real actor is never touched until {@link commit}; everything happens on the clone, so a
 * cancelled level-up rolls back for free by simply discarding this driver.
 *
 * Every decision a level-up raises is ours now: hit points, ability-score improvements (points or
 * a feat), subclasses, feature/spell choices, choosable traits, optional grants (Tasha's), and a
 * granted spell's casting ability — plus, on the headless path only, a choosable size. What the
 * driver declines is spelled out in {@link canDrive}: reversals (a level-*down*, or modifying an
 * earlier choice), a level-up that raises no class level, a brand-new class unless the world opts
 * into multiclassing, and any advancement type {@link isStepSupported} does not recognise. Those
 * fall through to the native wizard untouched.
 *
 * Two callers drive it: the interactive level-up wizard, answering the decision arrays as the
 * player clicks; and character creation, answering the same arrays headlessly from a choice
 * provider via {@link autoResolve} — through the very same apply methods, so the two paths cannot
 * drift apart.
 *
 * ── For a junior dev: how to read this file ──
 * The system's AdvancementManager is a state machine with a private `steps` array and a private
 * cursor. Normally it renders a wizard and walks itself. We can't call its private walk, so we
 * re-implement the walk here against its `clone` (a throwaway copy of the actor). Roughly:
 *   canDrive / isStepSupported  – the GATE: can we handle this whole level-up? If not, bail out.
 *   prepare()                    – WALK every step: auto-apply the ones with no choice, and collect
 *                                  the ones that DO need a choice into the decision arrays (hpSteps,
 *                                  asiSteps, choiceSteps, traitSteps, subclassSteps, grantSteps,
 *                                  optionalGrantSteps, sizeSteps).
 *   the apply/reverse helpers    – when the player picks in the UI, apply it to the clone (reversible).
 *   autoResolve()                – the same decisions, answered from a provider instead of the UI.
 *   commit()                     – write the finished clone onto the real actor.
 * "Synthesis" = choosing something (a subclass, a feat) can spawn NEW advancement steps mid-walk;
 * the code below detects those new items and folds their decisions in. Read prepare() first, then
 * follow one advancement type (e.g. HitPoints) through record -> apply -> commit to see the pattern.
 */
export class LevelUpDriver {

  /** @type {AdvancementManager} The native manager we are wrapping. */
  manager;
  /** @type {Actor5e} The real actor; only written to by {@link commit}. */
  actor;
  /** @type {Actor5e} The manager's in-memory working clone. */
  clone;
  /** @type {object[]} The manager's step array (we mutate it as the native code would). */
  steps;
  /** Our own cursor into {@link steps}, mirroring the manager's private `#stepIndex`. */
  index = 0;

  /**
   * The hit-point decisions surfaced to the wizard, one per gained level:
   * `{ level, screenLevel, advancement, item, average, hitDie, value }`. `value` is the current
   * pick ("avg" | "max" | <rolled number>), already applied to the clone.
   *
   * Every decision array below also carries `screenLevel`: the character level on whose screen the
   * decision appears (the registry groups decisions by it for the one-screen-per-level UI). It is
   * usually the decision's own `level`, but a feat's synthesised sub-choices come off level-0 flows
   * and inherit the granting ASI's level instead, so they land on the right screen.
   */
  hpSteps = [];

  /**
   * The feature decisions surfaced to the wizard, one per `ItemChoice` advancement gained this
   * level: `{ level, advancement, item }`. Unlike hit points these are left unselected until the
   * player picks in the UI, which applies straight to the clone via the advancement's own apply.
   */
  choiceSteps = [];

  /**
   * The ability-score-improvement decisions, one per `AbilityScoreImprovement` advancement gained
   * this level: `{ level, advancement, item }`. Defaulted to the "improve abilities" mode so the
   * distribution UI is ready; the player may switch to a feat.
   */
  asiSteps = [];

  /**
   * Ability-score improvements that raise no decision — a capstone's fixed `+4` (Primal Champion,
   * Body and Mind), a half-feat's `+1`, or a point budget with a single legal target — as
   * `{ level, advancement, key, points }`.
   *
   * Held back rather than applied where they are found, because {@link prepare} walks *every* level
   * before any decision is answered. Applying a level-20 `+4 Strength` during that walk consumes the
   * headroom the level-4 improvement is entitled to: the player's own points then clamp against the
   * maximum and are silently discarded, and a Barbarian carried 1→20 finishes on 20 Strength where
   * the rules — and the system's own wizard, which applies each level in turn — give 24.
   *
   * They are re-applied on top of the player's allocations by {@link #applyDeferredAsi}, and
   * suspended again around every edit, so level order is preserved however the screens are visited.
   * {@link asiState} discounts them so the budget on an ASI screen is the player's alone.
   */
  deferredAsi = [];

  /**
   * The trait decisions, one per choice-bearing `Trait` advancement gained this level (Weapon
   * Mastery being the common one): `{ level, advancement, item }`. Like feature choices these are
   * left unpicked until the player selects in the UI, which applies straight to the clone via the
   * advancement's own apply/reverse. Pure-grant traits (no choice) apply automatically instead.
   */
  traitSteps = [];

  /**
   * The subclass decisions, one per `Subclass` advancement gained this level:
   * `{ level, classLevel, advancement, item, featSynth }`. Choosing the subclass adds its item and
   * synthesises its features into the other decision arrays; `featSynth` tracks what was added so
   * the choice can be cleanly reversed. See {@link resolveSubclass}.
   */
  subclassSteps = [];

  /**
   * The optional-grant decisions, one per `ItemGrant` advancement whose items the player may decline
   * — in practice Tasha's optional class features, injected into every 2014-rules class.
   *
   * Seeded *selected* at ingest, because that is how the native manager presents them: dnd5e's
   * `initial` apply grants every item not individually marked optional, so the screen opens with the
   * boxes ticked and the player unticks what they do not want.
   */
  optionalGrantSteps = [];

  /**
   * The spell-grant decisions, one per `ItemGrant` advancement that grants a spell with a choosable
   * casting ability (a species lineage's Int/Wis/Cha spell, granted at a class level):
   * `{ level, screenLevel, advancement, item }`. The spell is granted to the clone immediately with a
   * sensible default ability so the clone stays valid; the wizard surfaces the ability picker, and
   * changing it re-points the granted spell's ability via {@link applyGrantAbility}. Plain grants
   * (no ability choice) apply automatically instead and never appear here.
   */
  grantSteps = [];

  /**
   * The size decisions, one per choice-bearing `Size` advancement (a species offering e.g. Small
   * *or* Medium): `{ level, screenLevel, advancement, item }`. A single fixed size applies
   * automatically and never appears here. The interactive level-up flow never surfaces these — the
   * claim gate rejects a multi-size level-up — but the headless {@link autoResolve} path
   * (character creation) drives them from the wizard's recorded pick.
   */
  sizeSteps = [];

  /** Snapshot of the clone's items before a step, used to detect synthesised additions. */
  #preItems = null;

  constructor(manager) {
    this.manager = manager;
    this.actor = manager.actor;
    this.clone = manager.clone;
    this.steps = manager.steps;
  }

  /** The static AdvancementManager class, for its `flowsForLevel` helper. */
  get #AdvancementManager() {
    return this.manager.constructor;
  }

  /** The step currently at the cursor (mirrors `manager.step`). */
  get #step() {
    return this.steps[this.index] ?? null;
  }

  /* -------------------------------------------- */
  /*  Claim gate                                  */
  /* -------------------------------------------- */

  /**
   * Synchronous test of whether this driver can fully own a manager — used by the intercept
   * to decide whether to suppress the native UI. Conservative by design: it claims only
   * genuine level-*increases* of a class the character has — or, when the world's multiclass
   * setting opts in (`allowNewClass`), is gaining. A step that might need a choice we don't
   * yet re-skin makes the whole level-up ineligible, so it falls through to the native
   * manager untouched.
   * @param {AdvancementManager} manager
   * @param {object} [options]
   * @param {boolean} [options.allowNewClass=false]   Also claim a level-up whose class item is
   *   new (a multiclass: `forNewItem` put it on the manager's clone, not the real actor).
   * @returns {boolean}
   */
  static canDrive(manager, { allowNewClass = false } = {}) {
    const steps = manager?.steps ?? [];
    if ( !steps.length ) return false;

    // Reversals mean a level-*down* or a choice-modify/delete flow — never our concern.
    if ( steps.some(s => s.type === "reverse" || s.type === "delete") ) return false;

    // The level-up must raise a class of the character's. Usually that class is already on the
    // real actor; a brand-new class (multiclassing) lives only on the manager's clone and is
    // claimable only when the multiclass setting opts in.
    const classItem = steps.find(s => s.class)?.class?.item;
    if ( !classItem ) return false;
    const onActor = !!manager.actor?.items?.get(classItem.id);
    if ( !onActor && !(allowNewClass && manager.clone?.items?.get(classItem.id)) ) return false;

    const actorLevel = manager.actor.system?.details?.level ?? 0;
    const raisesLevel = steps.some(s => s.type === "forward" && s.class && (s.level ?? 0) > actorLevel);
    if ( !raisesLevel ) return false;

    // Every renderable step must be one we can present. `automatic` steps and structurally
    // forced advancements need no input; anything else (ASI, ItemChoice, Subclass, a real
    // Trait/Size/ItemGrant choice) blocks the claim.
    return steps.every(s => s.automatic || this.isStepSupported(s));
  }

  /**
   * The dnd5e advancement types this driver knows how to handle, most specific first.
   *
   * Order matters: several of these subclass one another in the system (`ItemChoice` extends
   * `ItemGrant`), so the first match down this list is the narrowest correct answer.
   */
  static KNOWN_TYPES = ["HitPoints", "ItemChoice", "AbilityScoreImprovement", "Subclass",
    "ScaleValue", "Size", "Trait", "ItemGrant"];

  /**
   * The type to treat an advancement as: its own, or the nearest system type it subclasses.
   *
   * A module may register an advancement type of its own. Switching on the bare type string then
   * drops it — which is not a cosmetic failure, because a third-party type is usually a *system*
   * type with a different screen bolted on, and its `apply`/`reverse` are the ones we already know
   * how to drive.
   *
   * Tasha's `TCOEReplacementGrant` is exactly that: `insertReplacements` takes a plain `ItemGrant`
   * already on a 2014 class, marks the replaced item optional, appends the replacements, and flips
   * the type string. The advancement still grants everything it always did — the 2014 Ranger's
   * level-3 grant still carries *Ranger Archetype* — so a character built past it silently lost a
   * class feature for no reason other than the name of its class.
   * @param {Advancement} adv
   * @returns {string|null}
   */
  static baseType(adv) {
    if ( !adv ) return null;
    if ( this.KNOWN_TYPES.includes(adv.type) || (adv.type === "EmberKnowledge") ) return adv.type;
    const types = dnd5e.documents?.advancement ?? {};
    for ( const name of this.KNOWN_TYPES ) {
      const cls = types[`${name}Advancement`];
      if ( cls && (adv instanceof cls) ) {
        log(`treating third-party advancement "${adv.type}" as ${name}`);
        return name;
      }
    }
    return adv.type;
  }

  /**
   * Whether a single step is supported without user choice beyond hit points. Mirrors each
   * advancement type's `automaticApplicationValue` structurally (so it stays in step with the
   * driver's async classification) and treats hit points as the one renderable type we own.
   */
  static isStepSupported(step) {
    const adv = step.flow?.advancement;
    if ( !adv ) return true;                       // marker steps with no flow are inert
    switch ( this.baseType(adv) ) {
      case "HitPoints":  return true;              // the hit-point decision the wizard presents
      case "ItemChoice": return true;              // a feature/spell choice the wizard presents
      case "AbilityScoreImprovement": return true; // the ASI / feat decision the wizard presents
      case "Subclass":   return true;              // the subclass pick the wizard presents
      case "ScaleValue": return true;              // always automatic
      case "Size":       return (adv.configuration?.sizes?.size ?? 0) <= 1;
      case "Trait":      return true;              // grants apply automatically; choices the wizard presents
      // Plain grants apply automatically; a spell grant with a choosable casting ability (a species
      // lineage's Int/Wis/Cha spell at a class level) is presented as the ability picker; an
      // *optional* grant (Tasha's optional class features) is seeded like the native manager seeds
      // it and surfaced so the player can decline. Declining this used to hand the whole level-up
      // back to dnd5e, which meant our wizard never appeared for a 2014 class in a Tasha's world.
      case "ItemGrant":  return true;
      // Ember registers its own advancement type on background items (a culture/path granting
      // knowledge areas). It is pure grant — its `automaticApplicationValue()` returns the whole
      // grant list, so `#ingestFlow`'s default branch applies it with no screen of its own —
      // but it still has to pass this gate, or the Ember hand-off would fall through to the
      // native manager. The case is inert in a world without Ember: the type never appears.
      case "EmberKnowledge": return true;
      default:           return false;             // (no renderable types left)
    }
  }

  /* -------------------------------------------- */
  /*  Pipeline                                    */
  /* -------------------------------------------- */

  /**
   * Walk every step the manager enumerated, applying the automatic ones to the clone and
   * recording the hit-point decisions for the wizard (each seeded with its average so the
   * clone is always valid). Replicates the manager's private forward loop, including the
   * mid-flight step synthesis that granted items with their own advancements trigger.
   */
  async prepare() {
    while ( this.#step ) {
      // Before each step, as the native manager does before each render — not once up front. The
      // listeners read state the walk itself produces: Tasha's decides whether to prune the level-6
      // Roving grant by checking whether Deft Explorer is in `value.added`, which is empty until
      // level 1 has been processed. Firing once at the start would prune it for everyone.
      this.#firePreRender();
      const step = this.#step;
      if ( !step ) break;                // a listener pruned everything that was left
      await this.#processStep(step);
    }
    // Now the walk is over, the increases nobody decides go on top — in level order, after any
    // allocation the player will make. See {@link deferredAsi}.
    await this.#applyDeferredAsi();
    return this.hpSteps;
  }

  /**
   * Give other modules the chance to prune this manager's steps before we walk it.
   *
   * `AdvancementManager#render` fires `dnd5e.preAdvancementManagerRender` before processing, and
   * content modules use it to remove steps a character does not qualify for. Our wizard *replaces*
   * that render, so nothing ever fired it and every such step applied unconditionally.
   *
   * The case that found this: Tasha's grants a Ranger **Roving** at level 6 only if they took Deft
   * Explorer at level 1, and enforces it by deleting the advancement in this hook
   * (`hideAdvancementsOnTab` / `hideAdvancementsInManager`). A Ranger who kept Natural Explorer was
   * handed Roving anyway.
   *
   * Fired before **each** step, matching the native manager's per-render cadence, because listeners
   * read state the walk itself produces — see the note at the call site.
   *
   * A listener may *reassign* `manager.steps` rather than splice it (Tasha's filters into a new
   * array), so the driver's own reference is re-synced afterwards; without that the pruning would
   * be invisible to the very loop it is meant to shorten.
   * @returns {boolean}   False when a listener vetoed the walk.
   */
  #firePreRender() {
    try {
      const ok = Hooks.call("dnd5e.preAdvancementManagerRender", this.manager) !== false;
      // Re-sync: `this.steps` is captured in the constructor, and a listener that filters into a
      // fresh array would otherwise leave us walking the unpruned one.
      if ( this.manager?.steps && (this.manager.steps !== this.steps) ) this.steps = this.manager.steps;
      if ( !ok ) log("a module vetoed dnd5e.preAdvancementManagerRender");
      return ok;
    } catch ( err ) {
      // A third-party listener throwing must not take the level-up with it — the steps it would
      // have pruned simply stay, which is the behaviour we had before firing this at all.
      log("dnd5e.preAdvancementManagerRender listener failed", err);
      return true;
    }
  }

  /**
   * Apply every {@link deferredAsi} in level order, on top of whatever the point allocations
   * currently hold. Idempotent: an already-applied increase is reversed first, so this can run
   * again after any edit.
   */
  async #applyDeferredAsi() {
    for ( const rec of [...this.deferredAsi].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)) ) {
      const adv = rec.advancement;
      if ( adv.value?.type ) await adv.reverse(rec.level);
      // `initial` is what applies the configuration's fixed part, exactly as the native manager
      // pre-fills the screen this advancement would have rendered.
      await adv.apply(rec.level, {}, { initial: true });
      if ( rec.key ) await adv.apply(rec.level, { type: "asi", assignments: { [rec.key]: rec.points } });
    }
    if ( this.deferredAsi.length ) this.clone.reset();
  }

  /** Take the deferred increases back off the clone, so an allocation sees its true headroom. */
  async #suspendDeferredAsi() {
    for ( const rec of this.deferredAsi ) {
      if ( rec.advancement.value?.type ) await rec.advancement.reverse(rec.level);
    }
    if ( this.deferredAsi.length ) this.clone.reset();
  }

  /**
   * Run an ability-score edit against the scores as they stand *without* the increases nobody
   * decides, then put those back. Without this a level-4 allocation made after the walk would be
   * clamped by a level-20 capstone that has not happened yet.
   * @param {() => Promise<*>} edit
   */
  async #withOwnHeadroom(edit) {
    if ( !this.deferredAsi.length ) return edit();
    await this.#suspendDeferredAsi();
    try { return await edit(); }
    finally { await this.#applyDeferredAsi(); }
  }

  /** Process the step at the cursor, then advance — mirrors one iteration of `#forward`. */
  async #processStep(step) {
    const flow = step.flow;
    const type = step.type;
    this.#preItems ??= Array.from(this.clone.items);

    if ( type === "delete" && step.item ) {
      this.clone.items.delete(step.item.id);
    } else if ( type === "delete" && step.advancement ) {
      step.advancement.item.deleteAdvancement(step.advancement.id, { source: true });
    } else if ( type === "restore" ) {
      await flow.advancement.restore(flow.level, flow.retainedData);
    } else if ( type === "reverse" ) {
      await flow.retainData(await flow.advancement.reverse(flow.level));
    } else if ( flow ) {
      await this.#ingestFlow(flow, step);
    }

    delete step.error;
    this.#synthesizeSteps();
    this.#preItems = null;
    this.index++;

    // Keep the class item's level in step with the next step, exactly as the manager does.
    if ( this.#step?.class ) {
      let level = this.#step.class.level;
      if ( this.#step.type === "reverse" ) level -= 1;
      this.#step.class.item.updateSource({ "system.levels": level });
    }
    this.clone.reset();
  }

  /**
   * Classify and process one forward flow: apply the automatic advancements straight to the clone,
   * and record the renderable ones (hit points, feature/spell choices, ASI, subclass) as decisions
   * for the wizard. Shared by the main walk and the subclass synthesis so both stay consistent.
   * @param {AdvancementFlow} flow
   * @param {object} [step]   The owning step, when called from the main walk (carries class level).
   */
  async #ingestFlow(flow, step) {
    const adv = flow.advancement;
    // The same normalisation `isStepSupported` uses, or the two would disagree: the gate would claim
    // a third-party advancement it recognised as an ItemGrant and then the walk would drop it.
    switch ( this.constructor.baseType(adv) ) {
      case "HitPoints":
        // The original class's *first* level takes maximum hit points by rule, with nothing to
        // choose — the system applies it automatically (see HitPointsAdvancement
        // #automaticApplicationValue), so a creation-shaped walk (the Ember hand-off, or our own
        // headless creation) must not offer a roll there. A multiclass's first level is a real
        // decision, hence the original-class test rather than a bare `level === 1`.
        if ( (flow.level === 1) && adv.item?.isOriginalClass ) return adv.apply(flow.level, { 1: "max" });
        // Otherwise always a player decision, even on a multi-level jump. This is the one
        // deliberate exception to {@link #seed}: the native pre-fill silently inherits a prior
        // level's "avg" across a multi-level jump, and we want every gained level chosen here.
        return this.#recordHitPoints(flow);
      case "ItemChoice":
        // Record the decision but leave it unselected; the wizard applies the picks later. The seed
        // still runs — for a spell-granting choice it is what settles the casting ability the
        // granted spells are configured with before anything is picked.
        await this.#seed(flow);
        this.choiceSteps.push({ level: flow.level, screenLevel: flow.level, advancement: adv, item: adv.item });
        return;
      case "AbilityScoreImprovement": {
        const cfg = adv.configuration ?? {};
        const points = cfg.points ?? 0;
        // PHB-style single-stat half-feats (Actor's "+1 Cha") are data-modelled as 1 point with
        // every other ability locked, not as a fixed bonus. When only one ability can take the
        // whole budget the allocation is forced — there is nothing to choose.
        const open = Object.keys(CONFIG.DND5E.abilities)
          .filter(k => adv.canImprove(k) && !cfg.locked?.has?.(k));
        const forced = (open.length === 1) && ((cfg.cap ?? Infinity) >= points);

        // Nothing for the player to decide: a fixed increase, or a forced allocation. Deferred
        // rather than applied here — see {@link deferredAsi} for why the order matters.
        if ( (points <= 0) || forced ) {
          this.deferredAsi.push({
            level: flow.level, advancement: adv, item: adv.item,
            key: forced ? open[0] : null, points: forced ? points : 0
          });
          return;
        }

        // A real allocation. The seed applies the configuration's `fixed` part and settles
        // `value.type`, exactly as the native screen arrives pre-filled; where the class also allows
        // a feat it leaves the type unset (native renders both options and commits to neither) and
        // our screen opens on the points view, so settle it — taking a feat reverses and re-applies.
        await this.#seed(flow);
        if ( !adv.value.type ) await adv.apply(flow.level, { type: "asi" });
        this.asiSteps.push({ level: flow.level, screenLevel: flow.level, advancement: adv, item: adv.item });
        return;
      }
      case "Trait": {
        // A real choice (Weapon Mastery, a "choose a language", …) is surfaced for the player;
        // a pure grant (one forced option) applies straight away via its automatic value.
        const auto = await flow.getAutomaticApplicationValue();
        if ( auto !== false ) return adv.apply(flow.level, auto, { automatic: true });
        // Seed the rest: `{ initial: true }` lands the advancement's automatic `grants` plus any
        // pool that has collapsed to a single remaining option, and leaves the genuine picks open.
        // Without it a mixed grant-and-choice Trait (Dragon's Tongue, which *grants* Draconic and
        // *chooses* a second language) dropped its grants entirely on this path.
        await this.#seed(flow);
        this.traitSteps.push({ level: flow.level, screenLevel: flow.level, advancement: adv, item: adv.item });
        return;
      }
      case "Subclass":
        // Record only; choosing the subclass (in the UI) adds its item and synthesises its
        // features via {@link resolveSubclass}.
        this.subclassSteps.push({
          level: flow.level, screenLevel: flow.level, classLevel: step?.class?.level ?? flow.level,
          advancement: adv, item: adv.item, featSynth: null
        });
        return;
      case "ItemGrant": {
        // A plain grant applies automatically; a spell grant that lets the player choose its casting
        // ability (a species lineage spell at a class level) is granted now with a default ability —
        // so the clone stays valid — and surfaced as the ability picker.
        const auto = await flow.getAutomaticApplicationValue();
        if ( auto !== false ) return adv.apply(flow.level, auto, { automatic: true });
        if ( this.#isAbilityGrant(adv) ) {
          // The seed grants the non-optional items and defaults the casting ability to the first the
          // configuration allows, which is how the native screen arrives. Then re-point it at an
          // ability a sibling grant on the same item already uses, so a species lineage that picks
          // one ability at level 1 doesn't default its later spells to a different one.
          await this.#seed(flow);
          const ability = this.#defaultGrantAbility(adv);
          if ( ability && (ability !== adv.value?.ability) ) {
            await adv.apply(flow.level, { ability, selected: this.#grantUuids(adv) });
          }
          this.grantSteps.push({ level: flow.level, screenLevel: flow.level, advancement: adv, item: adv.item });
          return;
        }
        // A *replacement* grant — an ItemGrant subclass whose configuration carries a base→
        // replacement map, so its items are alternatives rather than a list. Tasha's builds these by
        // mutating a plain grant already on a 2014 class: the replaced item is marked optional, the
        // alternative is appended, and the type string is changed.
        //
        // Seeding it like an ordinary grant would hand the character *both* halves of every pair —
        // Favored Enemy and Favored Foe, Natural Explorer and Deft Explorer — which no edition
        // gives. Not choosing means keeping the base, so that is the default applied here; the
        // decision is recorded so a screen can offer the swap. The items outside any pair (the 2014
        // Ranger's level-3 *Ranger Archetype*) are unconditional and land either way, which is the
        // feature that went missing while this type was unrecognised entirely.
        const replacements = adv.configuration?.replacements;
        if ( replacements && !foundry.utils.isEmpty(replacements) ) {
          // Keyed off each item's own `optional` flag, not off the replacement map: one base can map
          // to *several* items (Tasha's swaps Natural Explorer for Deft Explorer **and** Canny) while
          // the map records only the first, so the map alone leaks the rest in. Everything in a pair
          // — base and alternatives alike — is flagged optional; everything outside one is not.
          //
          // The map's keys are stored without the `.Item.` segment, the same pre-v10 shape the
          // Ranger's "Hunter's Prey" pool uses; Tasha's own flow re-inserts it, so we do too.
          const bases = new Set(Object.keys(foundry.utils.flattenObject(replacements)).map(withItemSegment));
          // Normalised on the way out too, not just when matching: this content stores its item
          // uuids in the same pre-v10 form, and `value.added` records whatever it is handed — so
          // passing them through verbatim recorded a different uuid than the native flow does for
          // the identical feature.
          const keep = Array.from(adv.configuration?.items ?? [])
            .map(i => (typeof i === "string") ? { uuid: i } : i)
            .filter(i => i.uuid && (!i.optional || bases.has(withItemSegment(i.uuid))))
            .map(i => withItemSegment(i.uuid));
          if ( keep.length ) await adv.apply(flow.level, { selected: keep });
          this.optionalGrantSteps.push({
            level: flow.level, screenLevel: flow.level, advancement: adv, item: adv.item, replacements
          });
          return;
        }

        // An *optional* grant — Tasha's optional class features are the case in the wild, injected
        // into every 2014-rules class by `dnd-tashas-cauldron`.
        //
        // These used to be skipped outright, on the reasoning that `canDrive()` had already declined
        // the level-up. That left creation — which has no such gate — building characters missing
        // everything the grant carries, and it misread what "optional" means to the system. dnd5e's
        // own seed grants every item the grant does *not* individually mark optional
        // (`ItemGrantAdvancement#apply` under `initial`), so on the native path an untouched optional
        // grant arrives *applied*, not skipped. Seeding here is what makes the two agree, and it is
        // the right default besides: the world only carries these at all because the GM turned them
        // on, and the player can still decline in the wizard.
        await this.#seed(flow);
        this.optionalGrantSteps.push({ level: flow.level, screenLevel: flow.level, advancement: adv, item: adv.item });
        return;
      }
      case "Size": {
        // A single fixed size applies automatically; a size *choice* (Small or Medium) is surfaced.
        // Only the headless creation path resolves it — the level-up claim gate rejects multi-size.
        //
        // The size count is tested here rather than taken from `getAutomaticApplicationValue()`,
        // because the system's SizeAdvancement compares the `sizes` *Set* against a number:
        //   `if ( this.configuration.sizes > 1 ) return false;`
        // That is never true, so it reports the first size as automatic even for a real choice —
        // which silently forced every Small-or-Medium species (Human, Halfling, Gnome…) to Small
        // and swallowed the player's pick. Testing `.size` keeps this in agreement with
        // {@link isStepSupported}, which already gates on the count correctly.
        if ( (adv.configuration?.sizes?.size ?? 0) <= 1 ) {
          const auto = await flow.getAutomaticApplicationValue();
          if ( auto !== false ) return adv.apply(flow.level, auto, { automatic: true });
        }
        // Seed the first configured size so the clone is never sizeless while the choice is open —
        // the same fallback the native pre-fill leaves in place until the player picks.
        await this.#seed(flow);
        this.sizeSteps.push({ level: flow.level, screenLevel: flow.level, advancement: adv, item: adv.item });
        return;
      }
      default: {
        const auto = await flow.getAutomaticApplicationValue();
        if ( auto !== false ) return adv.apply(flow.level, auto, { automatic: true });
        // Should be unreachable on the main walk: canDrive() rejects unsupported renderable steps.
        // Reachable for a subclass feature we don't yet re-skin — skip it rather than break.
        log("skipping unsupported renderable advancement", adv?.type);
      }
    }
  }

  /**
   * Pre-fill a decision the way the native manager does before it renders the flow behind it.
   *
   * `AdvancementManager#render` applies `advancement.apply(level, {}, { initial: true })` to every
   * interactive step before the player ever sees it. That single call is how a Trait's automatic
   * grants, an ItemGrant's non-optional items, an ItemChoice's default casting ability and an ASI's
   * fixed increase all land whether or not the screen is touched. We used to hand-roll a seed per
   * type and had none at all for Trait, so a choice-bearing Trait's grants were silently dropped and
   * the *same* decision left untouched produced different characters through the two paths.
   * Deferring to the system's own `initial` keeps every type in step by construction.
   *
   * Hit points are the one deliberate exception — see the `HitPoints` case in {@link #ingestFlow}.
   * @param {AdvancementFlow} flow
   * @returns {Promise<void>}
   */
  #seed(flow) {
    return flow.advancement.apply(flow.level, {}, { initial: true });
  }

  /** Seed a hit-point decision with its average and apply it so the clone stays valid. */
  #recordHitPoints(flow) {
    const adv = flow.advancement;
    const record = {
      level: flow.level,
      screenLevel: flow.level,
      advancement: adv,
      item: adv.item,
      average: adv.average,
      hitDie: adv.hitDie,
      value: "avg",
      // Which control the value came from: "avg" | "roll" | "manual". Drives the UI highlight.
      mode: "avg"
    };
    this.hpSteps.push(record);
    // apply() reverses any prior value first, so re-applying on every change is safe.
    return adv.apply(flow.level, { [flow.level]: "avg" });
  }

  /**
   * Re-apply a hit-point decision to the clone after the player changes it.
   * @param {object} record   One of {@link hpSteps}.
   * @param {"avg"|"max"|number} value
   * @param {"avg"|"roll"|"manual"} [mode]   How the value was chosen (defaults from the value).
   */
  async applyHitPoints(record, value, mode = value === "avg" ? "avg" : "manual") {
    record.value = value;
    record.mode = mode;
    await record.advancement.apply(record.level, { [record.level]: value });
    this.clone.reset();
  }

  /**
   * Roll this class's hit die on the clone and return the rolled total, leaving the decision
   * applied. Mirrors {@link HitPointsFlow}, but the chat card is the GM's call (the
   * `levelUpHpRollToChat` world setting): off by default so the wizard shows the result inline
   * without mid-flow chat noise, on when the table wants the roll visible to everyone.
   * @param {object} record   One of {@link hpSteps}.
   * @returns {Promise<number>}
   */
  async rollHitPoints(record) {
    const toChat = levelUpHpRollToChat();
    const roll = await this.clone.rollClassHitPoints(record.item, { chatMessage: toChat });
    // Without a chat card, show the Dice So Nice 3D animation (if installed) ourselves; with one,
    // Dice So Nice already animates the message's roll. Awaiting lets the dice settle before the
    // value updates on screen.
    if ( roll && game.dice3d && !toChat ) {
      try { await game.dice3d.showForRoll(roll, game.user, true); } catch ( err ) { log("dice animation failed", err); }
    }
    const total = roll?.total ?? record.average;
    await this.applyHitPoints(record, total, "roll");
    return total;
  }

  /* -------------------------------------------- */
  /*  Feature choices (ItemChoice)                */
  /* -------------------------------------------- */

  /**
   * Current selection state of an {@link choiceSteps} decision, mirroring the native
   * ItemChoiceFlow: how many of how many are chosen, which pool UUIDs are picked, and (when the
   * level allows it) which earlier pick is currently marked for replacement.
   * @param {object} record   One of {@link choiceSteps}.
   * @returns {{ current: number, max: number, full: boolean, selected: Set<string>,
   *            replaceable: boolean, replacing: string|null, priorEntries: {id: string, uuid: string}[],
   *            ownedElsewhere: Set<string> }}   `ownedElsewhere` — pool uuids the character already
   *            holds from another source, shown taken rather than pickable.
   */
  choiceState(record) {
    const adv = record.advancement;
    const level = record.level;
    const { current, max, full } = adv.getCounts(level);
    const added = adv.value.added?.[level] ?? {};

    // Originals swapped out at an *earlier* level-up are still listed in `value.added` (dnd5e keeps
    // them, tracked via `value.replaced`), but their items were removed — so they must not reappear
    // as pickable "owned" choices. We keep the one being replaced *this* level so it can be unticked.
    const replacedElsewhere = new Set();
    for ( const [rl, r] of Object.entries(adv.value.replaced ?? {}) ) {
      if ( (Number(rl) !== level) && r?.original ) replacedElsewhere.add(r.original);
    }

    // Earlier-level picks of this same advancement — candidates the player may swap out.
    const priorEntries = [];
    for ( const [lvl, map] of Object.entries(adv.value.added ?? {}) ) {
      if ( Number(lvl) >= level ) continue;
      for ( const [id, uuid] of Object.entries(map ?? {}) ) {
        if ( !replacedElsewhere.has(id) ) priorEntries.push({ id, uuid });
      }
    }

    // Pool items the character already owns from ANOTHER source — the classic case is a Champion's
    // level-7 "Additional Fighting Style" whose pool still lists the style already granted by the
    // base Fighting Style. A non-repeatable feature can't be taken twice, so those must show as
    // already-taken rather than pickable. We mirror dnd5e's own prerequisite check (sourcedItems
    // keyed by compendium source), excluding this advancement's own grants (handled as priors).
    const ownAdvIds = new Set();
    for ( const map of Object.values(adv.value.added ?? {}) ) for ( const id of Object.keys(map ?? {}) ) ownAdvIds.add(id);
    const ownedElsewhere = new Set();
    const sourced = adv.actor?.sourcedItems;
    if ( sourced ) {
      for ( const p of adv.configuration?.pool ?? [] ) {
        const uuid = p.uuid ?? p;
        const owners = sourced.get(uuid);
        if ( owners?.size && [...owners].some(it => !ownAdvIds.has(it.id)) ) ownedElsewhere.add(uuid);
      }
    }

    return {
      current, max, full,
      selected: new Set(Object.values(added)),
      replaceable: !!adv.configuration?.choices?.[level]?.replacement,
      replacing: adv.value.replaced?.[level]?.original ?? null,
      priorEntries,
      ownedElsewhere
    };
  }

  /**
   * Add or remove one item from a feature choice, applied straight to the clone via the
   * advancement's own apply/reverse (which create or delete the granted item). Selecting beyond
   * the limit is ignored, matching the native flow. A picked item that carries advancements of
   * its own (a Paladin's "Blessed Warrior" fighting style brings a cantrip choice; a Warlock's
   * "Lessons of the First Ones" invocation brings an origin-feat choice) is cycled through like
   * a subclass pick: its automatic advancements apply and its choices surface as new decisions,
   * all reversed again if the pick is unticked.
   * @param {object} record   One of {@link choiceSteps}.
   * @param {string} uuid     Source UUID of the pool item being toggled.
   */
  async toggleChoice(record, uuid) {
    const { selected, full } = this.choiceState(record);
    if ( selected.has(uuid) ) {
      await this.#reversePickSynth(record, uuid);
      await record.advancement.reverse(record.level, { uuid });
    } else if ( !full ) {
      await record.advancement.apply(record.level, { selected: [uuid] });
      await this.#synthesizePick(record, uuid);
    }
    this.clone.reset();
  }

  /**
   * Fold a just-picked choice item's own advancements into the clone (see {@link toggleChoice}),
   * remembering what was synthesised per pick so unticking it can reverse cleanly.
   * @param {object} record   One of {@link choiceSteps}.
   * @param {string} uuid     Source UUID of the pick that was just applied.
   */
  async #synthesizePick(record, uuid) {
    const adv = record.advancement;
    const added = adv.value.added?.[record.level] ?? {};
    const id = Object.entries(added).find(([, u]) => u === uuid)?.[0];
    this.clone.reset();
    const item = id ? this.clone.items.get(id) : null;
    if ( !item?.hasAdvancement ) return;

    const targetLevel = this.steps.reduce((max, s) => Math.max(max, s.class?.level ?? 0), record.level);
    const synth = await this.#ingestItemFeatures(item, targetLevel);
    // A pick's sub-decisions usually come off level-0 flows — surface them on the pick's screen.
    const screen = record.screenLevel ?? record.level;
    for ( const r of [...synth.choices, ...synth.asi, ...synth.traits, ...synth.grants] ) {
      r.screenLevel = Math.max(r.screenLevel ?? r.level, screen);
    }
    (record.pickSynth ??= {})[uuid] = synth;
  }

  /** Reverse whatever {@link #synthesizePick} folded in for one pick, if anything. */
  async #reversePickSynth(record, uuid) {
    const synth = record.pickSynth?.[uuid];
    if ( !synth ) return;
    delete record.pickSynth[uuid];
    await this.#reverseSynth(synth);
  }

  /**
   * Mark (or unmark) an earlier pick for replacement. Marking it removes that item from the clone
   * and frees a slot so the player can choose a different option; clicking the marked one again —
   * or another — clears the previous mark first. The system recreates a cleared item from its
   * recorded source UUID, so nothing needs caching here.
   * @param {object} record       One of {@link choiceSteps}.
   * @param {string} originalId    Embedded id of the earlier pick being toggled.
   */
  async toggleReplacement(record, originalId) {
    const adv = record.advancement;
    const level = record.level;
    const { replacing } = this.choiceState(record);

    if ( replacing ) {
      // Drop any pick made to fill the freed slot before restoring the original, so we never keep
      // both. The first `count` entries are the level's own grants; anything beyond is the swap-in.
      const baseCount = adv.configuration?.choices?.[level]?.count ?? 0;
      for ( const uuid of Object.values(adv.value.added?.[level] ?? {}).slice(baseCount) ) {
        await this.#reversePickSynth(record, uuid);
        await adv.reverse(level, { uuid });
      }
      await adv.reverse(level, { clearReplacement: true });
    }
    // Clicking the already-marked item just clears it; clicking a different one marks that instead.
    if ( replacing !== originalId ) await adv.apply(level, { replace: originalId });
    this.clone.reset();
  }

  /* -------------------------------------------- */
  /*  Trait choices (Weapon Mastery, languages…)  */
  /* -------------------------------------------- */

  /**
   * Current selection state of a {@link traitSteps} decision: how many of how many keys are picked
   * and whether the quota is filled. Mirrors the native TraitFlow's slot count (grants + the sum of
   * each choice's `count`), reading the running picks off the advancement's own `value.chosen`.
   * @param {object} record   One of {@link traitSteps}.
   * @returns {{ chosen: Set<string>, current: number, max: number, full: boolean }}
   */
  traitState(record) {
    const adv = record.advancement;
    const chosen = new Set(adv.value.chosen ?? []);
    const max = adv.maxTraits;
    return { chosen, current: chosen.size, max, full: chosen.size >= max };
  }

  /**
   * The full option list for a trait decision. Shows the whole pool this advancement draws from
   * (intersected with the mode's eligibility — for mastery, weapons the character is proficient
   * with), so keys taken at an earlier level appear too: those are flagged `owned` and locked
   * (selected, not toggleable, like the fighting-style screen shows the current pick), this
   * advancement's own picks are toggleable, and the rest disable once the quota is full.
   *
   * The mastered/eligible split comes from the system's {@link actorSelected} (reading the clone),
   * so the mode rules are the system's, not ours; we only scope it to this advancement's pool.
   * Each option also carries its category (`groupKey`/`groupLabel` — e.g. Simple vs Martial Weapons)
   * so the step can group them under headers.
   *
   * When the advancement allows replacements and a grant is already satisfied (Cult of the Dragon
   * Initiate's Dragon's Tongue grants Draconic to a character who may already know it), the pool
   * widens to the whole trait type — the granted key shows owned/locked and the player picks the
   * replacement — matching the native flow's behaviour for `allowReplacements`.
   * @param {object} record   One of {@link traitSteps}.
   * @returns {Promise<{ key: string, label: string, img: string|null, selected: boolean, owned: boolean,
   *                     disabled: boolean, groupKey: string, groupLabel: string }[]>}
   */
  async traitOptions(record) {
    const adv = record.advancement;
    const Trait = dnd5e.documents.Trait;
    const { chosen, full } = this.traitState(record);

    // This advancement's pool (its grants + every choice pool), expanded to concrete prefixed keys.
    const poolKeys = new Set(adv.configuration.grants ?? []);
    for ( const c of adv.configuration.choices ?? [] ) for ( const k of c.pool ) poolKeys.add(k);
    const expanded = (await Trait.mixedChoices(poolKeys)).asSet();

    // The advancement's automatic grants, which the ingest seed has already applied. They sit in
    // `value.chosen` alongside the player's own picks and are indistinguishable there, so they are
    // identified from the configuration and locked below — the native flow never offers a grant for
    // removal, and letting one be un-toggled here would hand back a slot the rules never opened.
    const granted = (await Trait.mixedChoices(new Set(adv.configuration.grants ?? []))).asSet();

    // `selected` = keys already taken on the clone (this advancement's picks plus any from earlier
    // levels); `available` = eligible but not yet taken. Scope both to this advancement's pool —
    // except this advancement's own picks, which always stay visible (and toggleable): a
    // replacement pick lives outside the configured pool by definition.
    const { selected, available } = await adv.actorSelected();
    const keys = new Set([...selected, ...available, ...chosen].filter(k => expanded.has(k) || chosen.has(k)));

    // A grant the character already satisfies leaves nothing pickable inside the pool; with
    // `allowReplacements` the rules let them learn any trait of the same type instead. The
    // system's own availableChoices() widens the pool in exactly that case, so fold its keys in
    // (a no-op while the pool still has open picks, since it then stays pool-scoped). Chosen is
    // passed empty so the widened pool stays visible once the replacement is picked — its options
    // disable via `full` like any other filled pool instead of vanishing. The system's ":ALL"
    // pseudo-entries ("All Languages") are skipped: SelectChoices.filter drops them itself when
    // the trait tree is top-level, but on a real actor the widened tree nests under a per-type
    // node it never recurses into, and "learn every language" is not a pickable replacement.
    if ( adv.configuration.allowReplacements ) {
      const widened = await adv.availableChoices(new Set()).catch(err => { log("availableChoices failed", err); return null; });
      for ( const k of widened?.choices?.asSet() ?? [] ) {
        if ( !k.endsWith(":ALL") ) keys.add(k);
      }
    }

    // Keys are prefixed (e.g. "weapon:mar:longsword"), so keyLabel/keyIcon derive the trait type,
    // and the prefix-minus-leaf ("weapon:mar") labels the category the option belongs to. For weapon
    // picks (Weapon Mastery) we prefer the Player's Handbook item art when that pack is active,
    // matching the creator's grids, then the Baldur's Gate 3 module's proficiency art for skills
    // and armour/weapon categories, and fall back to the system's generic icon otherwise.
    const options = await Promise.all([...keys].map(async key => {
      const isGrant = granted.has(key) && chosen.has(key);
      const isChosen = chosen.has(key) && !isGrant;
      // Shown selected but locked: granted outright by this advancement, or taken at an earlier one.
      const owned = isGrant || (!isChosen && selected.has(key));
      const parts = key.split(":");
      const groupKey = parts.length > 2 ? parts.slice(0, -1).join(":") : parts[0];
      return {
        key,
        label: Trait.keyLabel(key),
        img: (await phbWeaponIcon(key)) ?? bg3TraitIcon(key) ?? Trait.keyIcon(key),
        selected: isChosen || owned,
        owned,
        disabled: owned || (!isChosen && full),
        groupKey,
        groupLabel: Trait.keyLabel(groupKey)
      };
    }));
    options.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    return options;
  }

  /**
   * Add or remove one trait key, applied straight to the clone via the advancement's own
   * apply/reverse (which write the proficiency/mastery onto the actor). Selecting beyond the quota
   * is ignored; unselecting a pick frees a slot, which is also how the player swaps a choice.
   * @param {object} record   One of {@link traitSteps}.
   * @param {string} key      The trait key being toggled.
   */
  async toggleTrait(record, key) {
    const adv = record.advancement;
    const { chosen, full } = this.traitState(record);
    // An automatic grant sits in `chosen` too (the ingest seed applies it), but it is not the
    // player's to give back — removing it would free a slot the rules never opened.
    if ( adv.configuration?.grants?.has?.(key) ) return;
    if ( chosen.has(key) ) await adv.reverse(record.level, { key });
    else if ( !full ) await adv.apply(record.level, { key });
    this.clone.reset();
  }

  /* -------------------------------------------- */
  /*  Spell grants with a choosable ability       */
  /* -------------------------------------------- */

  /** The source UUIDs an ItemGrant grants. */
  #grantUuids(adv) {
    return Array.from(adv.configuration?.items ?? []).map(i => (typeof i === "string") ? i : i?.uuid).filter(Boolean);
  }

  /**
   * Whether an ItemGrant is non-automatic *only* because it lets the player choose the casting
   * ability for a granted spell — the case the wizard re-skins. A grant that is optional, or has
   * optional items, is excluded (canDrive() leaves those to the native flow).
   */
  #isAbilityGrant(adv) {
    const cfg = adv.configuration ?? {};
    if ( cfg.optional || Array.from(cfg.items ?? []).some(i => i?.optional) ) return false;
    return (cfg.spell?.ability?.size ?? 0) > 1;
  }

  /**
   * The ability to seed a spell grant with. Reuses an ability already chosen for a sibling grant on
   * the same item — a species lineage picks one ability at level 1 and reuses it for its later
   * spells — reading it from the sibling's recorded value or, failing that, the spell it granted on
   * the clone; otherwise falls back to the first allowed ability (matching the native default).
   */
  #defaultGrantAbility(adv) {
    const abilities = Array.from(adv.configuration?.spell?.ability ?? []);
    for ( const sib of Object.values(adv.item?.advancement?.byId ?? {}) ) {
      if ( sib === adv ) continue;
      if ( sib.value?.ability && abilities.includes(sib.value.ability) ) return sib.value.ability;
      // Siblings are of mixed type, and `value.added` is flat on an ItemGrant but keyed by level
      // on an ItemChoice — reading an ItemChoice's flat would yield level numbers where item ids
      // were expected, so every lookup below would quietly miss. {@link addedEntries} normalises.
      for ( const id of Object.keys(addedEntries(sib)) ) {
        const ability = this.clone.items.get(id)?.system?.ability;
        if ( ability && abilities.includes(ability) ) return ability;
      }
    }
    return adv.value?.ability ?? abilities[0] ?? null;
  }

  /**
   * Current state of a {@link grantSteps} decision: the chosen casting ability, the allowed
   * abilities, and the granted spell(s) read off the clone (so Review and the picker agree).
   * @param {object} record   One of {@link grantSteps}.
   * @returns {{ ability: string|null, abilities: string[], spells: {name: string, img: string, uuid: string}[] }}
   */
  grantState(record) {
    const adv = record.advancement;
    const spells = Object.keys(adv.value?.added ?? {}).reduce((arr, id) => {
      const item = this.clone.items.get(id);
      if ( item ) arr.push({ name: item.name, img: item.img, uuid: item._stats?.compendiumSource ?? item.uuid });
      return arr;
    }, []);
    return { ability: adv.value?.ability ?? null, abilities: Array.from(adv.configuration?.spell?.ability ?? []), spells };
  }

  /**
   * Re-point a granted spell to a different casting ability. The native apply updates the
   * already-created spell items in place when handed a new ability, so the spell is not re-granted;
   * passing `selected` again is harmless (existing items are skipped).
   * @param {object} record   One of {@link grantSteps}.
   * @param {string} ability  One of the allowed ability keys.
   */
  async applyGrantAbility(record, ability) {
    const adv = record.advancement;
    if ( !adv.configuration?.spell?.ability?.has?.(ability) ) return;
    await adv.apply(record.level, { ability, selected: this.#grantUuids(adv) });
    this.clone.reset();
  }

  /* -------------------------------------------- */
  /*  Ability Score Improvement / feat            */
  /* -------------------------------------------- */

  /**
   * Current state of an {@link asiSteps} decision: the chosen mode, the point budget and what is
   * spent, the per-ability rows (with current score, this-ASI delta, and whether +/- is allowed),
   * and the chosen feat if any. Mirrors the native AbilityScoreImprovementFlow.
   * @param {object} record   One of {@link asiSteps}.
   */
  asiState(record) {
    const adv = record.advancement;
    const cfg = adv.configuration;
    const value = adv.value;
    const total = cfg.points ?? 0;
    const cap = cfg.cap ?? Infinity;
    const assignments = value.assignments ?? {};
    const isLocked = key => !!cfg.locked?.has?.(key);
    const fixedFor = key => cfg.fixed?.[key] ?? 0;

    // Spent points exclude both fixed and locked abilities, mirroring the native flow.
    const assigned = Object.keys(CONFIG.DND5E.abilities).reduce((n, key) => {
      if ( !adv.canImprove(key) || isLocked(key) ) return n;
      return n + Math.max(0, (assignments[key] ?? 0) - fixedFor(key));
    }, 0);
    const available = total - assigned;

    const abilities = [];
    for ( const [key, data] of Object.entries(CONFIG.DND5E.abilities) ) {
      if ( !adv.canImprove(key) ) continue;
      const abil = this.clone.system.abilities[key];
      // Discount the increases nobody decides (a level-20 capstone's +4). They sit on the clone so
      // Review shows the true score, but they are not this screen's to spend against — counting
      // them would price the player out of points the rules give them. See {@link deferredAsi}.
      const deferred = this.#deferredAsiBonus(key);
      const sourceValue = (this.clone.system._source.abilities[key]?.value ?? abil.value) - deferred;
      const assignment = assignments[key] ?? 0;
      const fixed = fixedFor(key);
      const locked = isLocked(key);
      const initial = sourceValue - assignment;          // the score before this ASI touched it
      const abilityMax = Math.max(abil.max, cfg.max ?? -Infinity);
      const floor = Math.min(initial + fixed, abilityMax);
      const ceil = locked ? floor : Math.min(sourceValue + available, abilityMax);
      abilities.push({
        key,
        label: data.label,
        abbr: data.abbreviation ?? key.slice(0, 3).toUpperCase(),
        value: sourceValue,
        delta: assignment,
        locked,
        canIncrease: !locked && (sourceValue < ceil) && (assignment < cap),
        canDecrease: !locked && (sourceValue > floor)
      });
    }

    return { type: value.type ?? null, total, cap, assigned, available, abilities, feat: this.#asiFeat(adv), allowFeat: adv.allowFeat };
  }

  /** How much of an ability's current score comes from a {@link deferredAsi} rather than a choice. */
  #deferredAsiBonus(key) {
    return this.deferredAsi.reduce((n, r) => n + (r.advancement.value?.assignments?.[key] ?? 0), 0);
  }

  /** The chosen feat for an ASI decision, or null. */
  #asiFeat(adv) {
    const [id, uuid] = Object.entries(adv.value.feat ?? {})[0] ?? [];
    const item = this.clone.items.get(id);
    return item ? { id, uuid, name: item.name, img: item.img } : null;
  }

  /**
   * The current ability scores as read-only rows (background-panel shape) — used to fill the
   * ability aside beside a chosen feat that carries no ability *choice* of its own. A half-feat's
   * automatic increase (a fixed +1, or a one-open-ability point auto-applied at ingest) is read
   * back off what its synthesised ASI advancements actually assigned and shown as that ability's
   * "+1" bonus; every other ability locks, so the panel reads as "this one applies, the rest are
   * set" rather than a blank list of scores.
   * @param {object} record   One of {@link asiSteps}.
   * @returns {{key: string, label: string, total: number, bonusLabel: string, locked: boolean, canInc: boolean, canDec: boolean}[]}
   */
  featAbilityRows(record) {
    const bonus = {};
    for ( const flow of record?.featSynth?.flows ?? [] ) {
      if ( flow.advancement?.type !== "AbilityScoreImprovement" ) continue;
      for ( const [key, value] of Object.entries(flow.advancement.value?.assignments ?? {}) ) {
        if ( value ) bonus[key] = (bonus[key] ?? 0) + value;
      }
    }
    const rows = [];
    for ( const [key, data] of Object.entries(CONFIG.DND5E.abilities) ) {
      if ( data.improvement === false ) continue;
      rows.push({
        key,
        label: data.label,
        total: this.clone.system.abilities[key]?.value ?? 10,
        bonusLabel: bonus[key] ? `+${bonus[key]}` : "",
        locked: !bonus[key],
        canInc: false,
        canDec: false
      });
    }
    return rows;
  }

  /**
   * Raise or lower one ability by a point. Re-applies the whole assignment from scratch
   * (reverse → apply) so the additive native apply stays idempotent across edits.
   * @param {object} record   One of {@link asiSteps}.
   * @param {string} key      Ability key.
   * @param {number} dir      +1 or -1.
   */
  async adjustAsi(record, key, dir) {
    const adv = record.advancement;
    const abil = this.asiState(record).abilities.find(a => a.key === key);
    if ( !abil || (dir > 0 && !abil.canIncrease) || (dir < 0 && !abil.canDecrease) ) return;

    const assignments = { ...(adv.value.assignments ?? {}) };
    assignments[key] = (assignments[key] ?? 0) + dir;
    if ( assignments[key] <= 0 ) delete assignments[key];

    return this.#withOwnHeadroom(async () => {
      await adv.reverse(record.level);
      await adv.apply(record.level, { type: "asi", assignments });
      this.clone.reset();
    });
  }

  /** The clone's chosen feat item for an ASI decision, or null. */
  #asiFeatItem(adv) {
    const id = Object.keys(adv.value.feat ?? {})[0];
    return id ? this.clone.items.get(id) : null;
  }

  /** Switch an ASI decision back to the ability-improvement mode (clearing any chosen feat). */
  async useAsiAbilities(record) {
    const adv = record.advancement;
    return this.#withOwnHeadroom(async () => {
      if ( record.featSynth ) { await this.#reverseSynth(record.featSynth); record.featSynth = null; }
      if ( adv.value.type ) await adv.reverse(record.level);
      await adv.apply(record.level, { type: "asi" });
      this.clone.reset();
    });
  }

  /**
   * Open the inline feat picker for an ASI decision — flips `record.pickingFeat`, which
   * {@link asiFeatOptions} and the ASI step's template key off to swap the ability-score panel for
   * a choice grid. Reset `record.showFuture` on open, so a previous "coming later" toggle doesn't
   * leak into a fresh pick.
   * @param {object} record   One of {@link asiSteps}.
   */
  openAsiFeatPicker(record) {
    record.pickingFeat = true;
    record.showFuture = false;
  }

  /** Close the inline feat picker without changing the decision. */
  closeAsiFeatPicker(record) {
    record.pickingFeat = false;
  }

  /** Toggle whether the picker's locked "coming later" section is shown. */
  toggleAsiFeatPeek(record) {
    record.showFuture = !record.showFuture;
  }

  /**
   * The feat picker's current option grid: every eligible general feat, split into pickable
   * options (grouped Recommended/Other) and a locked "coming later" list — see
   * {@link module:data/choice-resolver.findAsiFeats} and
   * {@link module:data/choice-resolver.classifyAsiFeats}.
   * @param {object} record   One of {@link asiSteps}.
   * @returns {Promise<{groups: object[]|null, options: object[], lockedOptions: object[]}>}
   */
  async asiFeatOptions(record) {
    const level = this.clone.system.details.level ?? 0;
    const entries = await findAsiFeats(level);
    const owned = new Set(record.advancement.actor?.identifiedItems?.keys() ?? []);
    const taken = this.#takenFeatNames(record);
    return classifyAsiFeats(entries, level, owned, taken);
  }

  /**
   * Names (lowercased) of every non-repeatable feat the clone already holds, from any source —
   * an earlier ASI's pick, a class/background grant, whatever. {@link classifyAsiFeats} drops these
   * from the picker entirely: a second copy is never a legal pick (dnd5e's own
   * `validatePrerequisites` would reject it), so offering it — let alone flagging it "Recommended"
   * — is nothing but a dead end for the player.
   * @param {object} record   One of {@link asiSteps}.
   * @returns {Set<string>}
   */
  #takenFeatNames(record) {
    const names = new Set();
    for ( const item of record.advancement.actor?.items ?? [] ) {
      if ( (item.type !== "feat") || item.system?.prerequisites?.repeatable ) continue;
      names.add(item.name.trim().toLowerCase());
    }
    return names;
  }

  /**
   * Pick a feat from the inline picker: grant it (via {@link applyAsiFeat}) and close the picker.
   * @param {object} record   One of {@link asiSteps}.
   * @param {string} uuid     Source UUID of the feat to take.
   * @returns {Promise<boolean>}  Whether the feat was taken.
   */
  async pickAsiFeat(record, uuid) {
    const taken = await this.applyAsiFeat(record, uuid);
    if ( taken ) this.closeAsiFeatPicker(record);
    return taken;
  }

  /**
   * Take a specific feat for an ASI decision: grant it and fold in the feat's *own* advancements —
   * so a half-feat's ability bonus actually applies, granted features and proficiencies land, and
   * any sub-choice surfaces as a further decision.
   *
   * Split out from {@link pickAsiFeat} so the decision can also be answered without a UI, which
   * is what {@link autoResolve} needs to honour a `{ feat }` answer — the interactive path is just
   * this preceded by the inline feat picker.
   * @param {object} record        One of {@link asiSteps}.
   * @param {string} uuid          Source UUID of the feat to take.
   * @param {object} [options]
   * @param {boolean} [options.showMessage=true]   Warn the player when prerequisites fail. Off for
   *   a headless resolve, where there is no one at the keyboard to read it.
   * @returns {Promise<boolean>}   Whether the feat was taken.
   */
  async applyAsiFeat(record, uuid, { showMessage = true } = {}) {
    const item = await fromUuid(uuid).catch(() => null);
    if ( !item ) { log("ASI feat not found", uuid); return false; }
    if ( item.system.validatePrerequisites?.(this.clone, { showMessage }) !== true ) {
      log("ASI feat rejected by its own prerequisites", uuid);
      return false;
    }

    // Suspended for the same reason an allocation is: the feat's own increase is deferred, and
    // re-applying at the end puts every undecided increase back in level order.
    return this.#withOwnHeadroom(async () => {
      // Drop any previous feat's synthesised features, then the ASI value itself, before re-granting.
      if ( record.featSynth ) { await this.#reverseSynth(record.featSynth); record.featSynth = null; }
      if ( record.advancement.value.type ) await record.advancement.reverse(record.level);
      await record.advancement.apply(record.level, { type: "feat", uuid });
      this.clone.reset();

      // Run the feat's own advancements (fixed ASI bonus, granted features, sub-choices).
      const featItem = this.#asiFeatItem(record.advancement);
      if ( featItem ) {
        record.featSynth = await this.#ingestItemFeatures(featItem, 0);
        // The feat's own advancements come off level-0 flows; surface any choices they reveal on the
        // same screen as the granting ASI rather than a phantom "level 0" screen.
        for ( const r of [...record.featSynth.choices, ...record.featSynth.asi, ...record.featSynth.traits, ...record.featSynth.grants] ) {
          r.screenLevel = record.level;
        }
      }
      this.clone.reset();
      return true;
    });
  }

  /* -------------------------------------------- */
  /*  Synthesised sub-features (subclass / feat)  */
  /* -------------------------------------------- */

  /**
   * Fold an item's own advancements into the clone: enumerate its flows up to `maxLevel` and ingest
   * each (auto-apply the automatic ones, surface any renderable ones as new decisions) — then do
   * the same for every feature those flows themselves granted. An Artillerist's level-3 grant hands
   * out "Tools of the Trade", whose own Trait choice (an artisan tool) must surface too, and
   * "Artillerist Spells", whose spell grants must land. Returns the flows it ran and the decision
   * records it added, so the caller can reverse them cleanly later.
   * @param {Item5e} item
   * @param {number} maxLevel
   * @returns {Promise<{flows: object[], choices: object[], asi: object[], traits: object[],
   *                    grants: object[]}>}
   */
  async #ingestItemFeatures(item, maxLevel) {
    const beforeChoices = this.choiceSteps.length;
    const beforeAsi = this.asiSteps.length;
    const beforeTraits = this.traitSteps.length;
    const beforeGrants = this.grantSteps.length;
    const flows = [];
    await this.#ingestItemTree(item, maxLevel, flows, new Set([item.id]));
    // A feature synthesised after the main walk — a subclass's, or a chosen feat's — can carry an
    // increase nobody decides. Put the deferred set back so it lands here too, not only at the end
    // of {@link prepare}; the re-apply is idempotent, so doing it twice costs nothing.
    await this.#applyDeferredAsi();
    return {
      flows,
      choices: this.choiceSteps.slice(beforeChoices),
      asi: this.asiSteps.slice(beforeAsi),
      traits: this.traitSteps.slice(beforeTraits),
      grants: this.grantSteps.slice(beforeGrants)
    };
  }

  /**
   * Run one item's advancement flows against the clone, then recurse into any item those flows
   * added that carries advancements of its own — the driver-side counterpart of the manager's
   * mid-walk step synthesis, which only covers the main walk (a subclass or feat chosen in the UI
   * lands after that walk has finished). `flows` accumulates depth-first, so the reverse-order undo
   * in {@link #reverseSynth} unwinds a granted feature's advancements before the grant that created
   * it. `seen` guards against a grant cycle re-ingesting the same item.
   * @param {Item5e} item
   * @param {number} maxLevel
   * @param {object[]} flows     Accumulator for every flow run, in application order.
   * @param {Set<string>} seen   Item ids already ingested (or being ingested).
   */
  async #ingestItemTree(item, maxLevel, flows, seen) {
    const preIds = new Set(this.clone.items.map(i => i.id));
    for ( let l = 0; l <= maxLevel; l++ ) {
      for ( const flow of this.#AdvancementManager.flowsForLevel(item, l) ) {
        flows.push(flow);
        await this.#ingestFlow(flow);
      }
    }
    // Reset so a freshly-granted feature is fully prepared (its advancement.byLevel ready)
    // before its own flows are enumerated.
    this.clone.reset();
    for ( const added of this.clone.items.filter(i => !preIds.has(i.id) && !seen.has(i.id) && i.hasAdvancement) ) {
      seen.add(added.id);
      await this.#ingestItemTree(added, maxLevel, flows, seen);
    }
  }

  /**
   * Reverse what {@link #ingestItemFeatures} applied: undo each synthesised advancement and drop the
   * decisions it added. Best-effort — reversing a flow the player never touched is a no-op.
   * @param {{flows: object[], choices: object[], asi: object[], traits: object[], grants: object[]}} synth
   */
  async #reverseSynth(synth) {
    if ( !synth ) return;
    // A choice decision this synth surfaced may itself carry synthesised picks (a subclass reveals
    // a feature choice, whose pick brought advancements of its own) — unwind those deepest-first.
    for ( const c of synth.choices ?? [] ) {
      for ( const uuid of Object.keys(c.pickSynth ?? {}) ) await this.#reversePickSynth(c, uuid);
    }
    for ( const flow of [...(synth.flows ?? [])].reverse() ) {
      try { await flow.advancement.reverse(flow.level); } catch ( err ) { log("synth feature reverse failed", err); }
    }
    if ( synth.choices?.length ) this.choiceSteps = this.choiceSteps.filter(c => !synth.choices.includes(c));
    if ( synth.asi?.length ) this.asiSteps = this.asiSteps.filter(a => !synth.asi.includes(a));
    // A half-feat's fixed increase was deferred rather than applied, so dropping the feat has to
    // drop its record too — otherwise the next re-apply would reach for an advancement that has
    // been reversed off an item no longer on the clone.
    if ( synth.flows?.length ) {
      const gone = new Set(synth.flows.map(f => f.advancement));
      this.deferredAsi = this.deferredAsi.filter(r => !gone.has(r.advancement));
    }
    if ( synth.traits?.length ) this.traitSteps = this.traitSteps.filter(tr => !synth.traits.includes(tr));
    if ( synth.grants?.length ) this.grantSteps = this.grantSteps.filter(g => !synth.grants.includes(g));
    this.clone.reset();
  }

  /* -------------------------------------------- */
  /*  Subclass                                    */
  /* -------------------------------------------- */

  /**
   * The clone's subclass item for a decision, or null. `value.document` is a LocalDocumentField,
   * so it resolves to the embedded Item directly; we fall back to the source id just in case.
   */
  #subclassDoc(record) {
    const val = record.advancement.value;
    let doc = val?.document ?? null;
    if ( typeof doc === "string" ) doc = this.clone.items.get(doc);
    if ( !doc && val?._source?.document ) doc = this.clone.items.get(val._source.document);
    return doc ?? null;
  }

  /** The chosen subclass for a decision, or null. */
  subclassState(record) {
    const doc = this.#subclassDoc(record);
    return {
      chosen: !!doc,
      name: doc?.name ?? "",
      img: doc?.img ?? "",
      uuid: record.advancement.value?.uuid ?? null
    };
  }

  /**
   * Select a subclass by UUID from the wizard's own picker (no compendium browser). Clicking the
   * already-selected subclass clears it; clicking a different one swaps it, reversing everything the
   * previous subclass brought in first.
   * @param {object} record   One of {@link subclassSteps}.
   * @param {string} uuid     Source UUID of the subclass.
   */
  async selectSubclass(record, uuid) {
    const current = record.advancement.value?.uuid ?? null;
    if ( current ) await this.clearSubclass(record);
    if ( current !== uuid ) await this.resolveSubclass(record, uuid);
  }

  /**
   * Grant the chosen subclass to the clone and fold its features in: enumerate the subclass's
   * advancement flows up to the current class level and ingest each (auto-apply the automatic ones,
   * surface any renderable ones as new decisions). Records what was synthesised on the step so it
   * can be reversed if the player changes their mind.
   * @param {object} record   One of {@link subclassSteps}.
   * @param {string} uuid     Source UUID of the subclass.
   */
  async resolveSubclass(record, uuid) {
    await record.advancement.apply(record.level, { uuid });
    // Reset so the freshly-added subclass item is fully prepared (its advancement.byLevel ready)
    // before we enumerate its flows.
    this.clone.reset();
    const subclassItem = this.#subclassDoc(record);
    if ( !subclassItem ) return;

    // Ingest up to the class level this level-up finishes at, not just the level the subclass is
    // picked at: a multi-level jump (2→5) must also collect the subclass's level-4/5 features.
    const targetLevel = this.steps.reduce((max, s) => Math.max(max, s.class?.level ?? 0), record.classLevel);
    record.featSynth = await this.#ingestItemFeatures(subclassItem, targetLevel);
    // A decision revealed at or below the subclass's own level belongs on the subclass's screen
    // (there is no earlier screen to host it); later-level ones keep their own screens.
    for ( const r of [...record.featSynth.choices, ...record.featSynth.asi, ...record.featSynth.traits, ...record.featSynth.grants] ) {
      r.screenLevel = Math.max(r.screenLevel ?? r.level, record.screenLevel);
    }
    this.clone.reset();
  }

  /**
   * Undo a subclass choice: reverse its synthesised feature advancements, drop the decisions they
   * added, then reverse the subclass itself (removing its item). Best-effort — reversing a flow the
   * player never touched is a no-op.
   * @param {object} record   One of {@link subclassSteps}.
   */
  async clearSubclass(record) {
    if ( record.featSynth ) { await this.#reverseSynth(record.featSynth); record.featSynth = null; }
    try { await record.advancement.reverse(record.level); } catch ( err ) { log("subclass reverse failed", err); }
    this.clone.reset();
  }

  /* -------------------------------------------- */
  /*  Step synthesis (mirror of #synthesizeSteps) */
  /* -------------------------------------------- */

  /**
   * Add synthetic steps for items the just-applied step added that carry their own
   * advancement (e.g. a granted feature). Faithful port of the manager's private
   * `#synthesizeSteps`, restricted to additions — Phase 1 never reverses or deletes.
   */
  #synthesizeSteps() {
    const initialIds = this.steps.reduce((ids, step) => {
      if ( step.synthetic || !step.flow?.item ) return ids;
      ids.add(step.flow.item.id);
      return ids;
    }, new Set());

    const preIds = new Set(this.#preItems.map(i => i.id));
    const postIds = new Set(this.clone.items.map(i => i.id));
    const addedIds = postIds.difference(preIds).difference(initialIds);

    for ( const addedId of addedIds ) {
      const item = this.clone.items.get(addedId);
      if ( !item?.hasAdvancement ) continue;

      let handledLevel = 0;
      for ( let idx = this.index; idx < this.steps.length; idx++ ) {
        const getLevel = step => (item.system.advancementClassLinked ? undefined : step?.level)
          ?? step?.flow?.level ?? step?.class?.level ?? step?.level;
        const thisLevel = getLevel(this.steps[idx]);
        const nextLevel = getLevel(this.steps[idx + 1]);
        if ( (thisLevel < handledLevel) || (thisLevel >= nextLevel) ) continue;

        const steps = Array.fromRange(thisLevel - handledLevel + 1, handledLevel)
          .flatMap(l => this.#AdvancementManager.flowsForLevel(item, l, { findExisting: this.steps }))
          .map(flow => ({ type: "forward", flow, synthetic: true }));

        this.steps.splice(idx + 1, 0, ...steps);
        idx += steps.length;
        handledLevel = nextLevel ?? handledLevel;
      }
    }
  }

  /* -------------------------------------------- */
  /*  Commit (mirror of #complete)                */
  /* -------------------------------------------- */

  /**
   * Whether an item still carries a rider list the system would have cleaned away.
   *
   * `flags.dnd5e.riders` records which of an item's activities and effects ride along with an
   * enchantment. The system maintains it in `preUpdateActivities` (`data/item/templates/activities.mjs`),
   * which recomputes it on every item update and deletes whatever ends up empty — the whole flag, or
   * an individual empty list. Compendium packs ship items whose flag is already empty, and the
   * *native* manager clears them for free because it re-writes every item the actor owns; skipping
   * unchanged items (see {@link commit}) means ours never got the chance, so a creator-built
   * character kept stale bookkeeping a natively-built one shed.
   *
   * Testing for it here rather than stripping the flag ourselves keeps the rule where it belongs:
   * the item goes through a normal update, and the system's own hook decides what to remove. It
   * costs one extra write per affected item, once — the clone reflects the actor next time round.
   * @param {object} data   Item source data from the clone.
   * @returns {boolean}
   */
  #hasStaleRiders(data) {
    const riders = data?.flags?.dnd5e?.riders;
    if ( riders === undefined ) return false;
    if ( Array.isArray(riders) ) return !riders.length;
    if ( !riders || (typeof riders !== "object") ) return false;
    const lists = Object.values(riders);
    return !lists.length || lists.some(v => Array.isArray(v) ? !v.length : !v);
  }

  /**
   * Persist the driven clone onto the real actor — a port of the manager's private `#complete`:
   * diff the clone's items into create/update/delete sets and write everything with
   * `isAdvancement: true`, then fire the system's completion hook so other modules react exactly
   * as they would after a native level-up.
   *
   * ── This is a copy. Here is the original ──
   * `AdvancementManager##complete` — `dnd5e/module/applications/advancement/advancement-manager.mjs`,
   * around line 880 in **5.3.3**, the version this was ported from. `module.json` declares a wider
   * floor than that (`minimum: 5.3.0`), so this has to hold for the oldest system it claims as well
   * as the newest it is verified on.
   *
   * Everywhere else the driver merely *drives* the system: if dnd5e changes an advancement's
   * `apply`, we call the changed one. This method is the exception — it reimplements system
   * behaviour rather than calling it, and it is the last thing to run, on the real actor, after the
   * clone is already correct. A dnd5e change here therefore does not break us loudly; it makes us
   * quietly write a different actor than the native wizard would, on a path the equivalence harness
   * only catches if a scenario happens to cover the difference. It is the single most valuable
   * thing to re-read on a system upgrade.
   *
   * What to diff, in the order it bites:
   *  1. **The create/update/delete partition** — which items land in which set, and the
   *     `toDelete.findSplice` that spares an item the actor already has.
   *  2. **Both hooks**: `dnd5e.preAdvancementManagerComplete` (cancellable, and its argument order
   *     `manager, updates, toCreate, toUpdate, toDelete` is part of the contract other modules read)
   *     and `dnd5e.advancementManagerComplete` after the writes.
   *  3. **The write options** — `isAdvancement: true` on all four, `keepId: true` on the creates,
   *     `diff: false, recursive: false` on the updates. These are what tell the system, and every
   *     module listening, that this is advancement rather than an edit.
   *  4. **The `Promise.all` ordering**, which the note at the end of this comment depends on.
   *
   * Two deliberate departures from the native code, both for Apply speed — and they are departures
   * to re-justify rather than reapply if the original moves:
   *  - The native manager re-writes *every* item the actor owns (`diff: false` over the full
   *    list), so applying scales with inventory size. Untouched items are byte-identical between
   *    the clone and the actor, so they are compared and skipped here — only what the level-up
   *    actually changed is written. {@link #hasStaleRiders} covers the one thing that rewrite did
   *    for free.
   *  - The four writes suppress their per-operation renders (each would re-render the open
   *    character sheet behind the wizard); the sheet is re-rendered once at the end instead.
   *
   * The wholesale `clone.toObject()` actor write looks like it should race the hooks this very
   * `Promise.all` triggers — `SubclassData._onCreate` sets `attributes.spellcasting` from a
   * deliberately un-awaited `actor.update` — and an earlier note here proposed writing only changed
   * keys to avoid it. Measured, it does not: `Promise.all` starts the actor update first, so the
   * hook's write always lands after and survives. The equivalence harness reported otherwise only
   * because it read the actor before that un-awaited write arrived. Left as the faithful port.
   * @returns {Promise<Actor5e>}  The updated real actor.
   */
  async commit() {
    const updates = this.clone.toObject();
    const items = updates.items;
    delete updates.items;

    const { toCreate, toUpdate, toDelete } = items.reduce((obj, item) => {
      const existing = this.actor.items.get(item._id);
      if ( !existing ) obj.toCreate.push(item);
      else {
        const changed = !foundry.utils.equals(existing.toObject(), item);
        if ( changed || this.#hasStaleRiders(item) ) obj.toUpdate.push(item);
        obj.toDelete.findSplice(id => id === item._id);
      }
      return obj;
    }, { toCreate: [], toUpdate: [], toDelete: this.actor.items.map(i => i.id) });

    if ( Hooks.call("dnd5e.preAdvancementManagerComplete", this.manager, updates, toCreate, toUpdate, toDelete) === false ) {
      log("level-up completion prevented by preAdvancementManagerComplete hook");
      return this.actor;
    }

    await Promise.all([
      this.actor.update(updates, { isAdvancement: true, render: false }),
      this.actor.createEmbeddedDocuments("Item", toCreate, { keepId: true, isAdvancement: true, render: false }),
      this.actor.updateEmbeddedDocuments("Item", toUpdate, { diff: false, recursive: false, isAdvancement: true, render: false }),
      this.actor.deleteEmbeddedDocuments("Item", toDelete, { isAdvancement: true, render: false })
    ]);

    Hooks.callAll("dnd5e.advancementManagerComplete", this.manager);
    // The one render the four suppressed ops deferred to: surface the new level on the sheet.
    if ( this.actor.sheet?.rendered ) this.actor.sheet.render();
    return this.actor;
  }

  /* -------------------------------------------- */
  /*  Headless resolution (character creation)    */
  /* -------------------------------------------- */

  /**
   * Answer every decision this driver surfaced from a {@link CreationChoiceProvider} instead of
   * from the wizard UI — the character-creation path, where the player already made every choice in
   * the creator's own steps. It walks the same decision arrays {@link prepare} populated and applies
   * each through the *same* apply methods the level-up UI calls, so creation and level-up can never
   * drift. Resolving a choice (a picked feature, a subclass) can synthesise fresh decisions
   * mid-drain, so this loops to a fixed point rather than a single forward pass, tracking resolved
   * records in `done`.
   *
   * Types with no creation-time decision (`subclass` — subclasses come later, still interactive) or
   * that the provider defers (spell-type `ItemChoice`, owned by the feat-spells step and applied
   * after commit) are marked resolved and skipped.
   *
   * The provider answers one decision per method, each returning null to leave it alone:
   * `hp(rec)` → `"avg" | "max" | number`; `size(rec)` → a size key; `grantAbility(rec)` → an
   * ability key; `subclass(rec)` → a subclass uuid; `traitKeys(rec)` → the complete key set
   * (grants ∪ picks); `defer(rec)`/`choiceUuids(rec)` for feature choices; and `asi(rec)` → either
   * a per-ability allocation (`{int: 2}`) or `{ feat: uuid }` to take a feat instead — the same
   * two modes the interactive ASI screen offers.
   * @param {import("../build/creation-advancement.mjs").CreationChoiceProvider} provider
   */
  async autoResolve(provider) {
    const done = new Set();
    const drain = async (steps, resolve, { byLevel = false } = {}) => {
      // Insertion order is the walk order for everything `prepare()` found, but a decision a
      // subclass or feat *synthesised* is appended after the whole main walk — so a level-3 feature's
      // choice lands behind a level-6 one. That only matters where one decision depends on another
      // having already applied, which among these is traits: an expertise upgrade writes nothing
      // unless the character is already proficient (`TraitAdvancement#apply` skips it when the
      // current value is 0). A Rogue Phantom picking Expertise in a skill that the subclass's own
      // level-3 feature grants would silently keep plain proficiency.
      // A decision array is absent rather than empty on a driver assembled from partial state (the
      // unit tests build one per decision type), so an added array must not break the others.
      const list = steps ?? [];
      const order = byLevel
        ? [...list].sort((a, b) => ((a.screenLevel ?? a.level ?? 0) - (b.screenLevel ?? b.level ?? 0)))
        : [...list];
      for ( const rec of order ) {
        if ( done.has(rec) ) continue;
        done.add(rec);
        try { await resolve(rec); } catch ( err ) { log("headless resolve failed", err); }
      }
    };

    // Loop until a full pass adds nothing new — a synthesised feature/subclass can append decisions
    // to any array after we have already walked it.
    let seen = -1;
    while ( done.size !== seen ) {
      seen = done.size;
      await drain(this.hpSteps,       rec => this.applyHitPoints(rec, provider.hp(rec)));
      await drain(this.sizeSteps,     rec => { const k = provider.size(rec); return k ? this.applySize(rec, k) : null; });
      await drain(this.grantSteps,    rec => { const a = provider.grantAbility(rec); return a ? this.applyGrantAbility(rec, a) : null; });
      await drain(this.subclassSteps, rec => { const u = provider.subclass(rec); return u ? this.selectSubclass(rec, u) : null; });
      // An optional grant arrives seeded (every item taken). A provider that says nothing leaves it
      // that way — matching the native manager — so only an explicit answer changes anything, and
      // `null` and `[]` have to stay distinguishable: the first means "no opinion", the second
      // means "decline all of them".
      await drain(this.optionalGrantSteps, rec => {
        const uuids = provider.optionalGrant?.(rec);
        return Array.isArray(uuids) ? this.setOptionalGrant(rec, uuids) : null;
      });
      // An ASI decision is answered either with a per-ability allocation or with a feat to take
      // in its place — the two modes the interactive screen offers. A `{ feat }` answer routes to
      // the same grant-and-synthesise path the UI uses, minus the compendium browser.
      await drain(this.asiSteps,      rec => {
        const a = provider.asi(rec);
        if ( !a ) return null;
        if ( typeof a.feat === "string" ) return this.applyAsiFeat(rec, a.feat, { showMessage: false });
        return this.setAsi(rec, a);
      });
      await drain(this.traitSteps,
        rec => { const keys = provider.traitKeys(rec); return keys.length ? this.applyTraitKeys(rec, keys) : null; },
        { byLevel: true });
      await drain(this.choiceSteps,   async rec => {
        if ( provider.defer(rec) ) return;
        for ( const uuid of provider.choiceUuids(rec) ) await this.toggleChoice(rec, uuid);
      });
    }
  }

  /**
   * The current state of an optional-grant decision: every item it offers, and whether each is
   * currently taken. Read off `value.added` rather than remembered, so it stays true after a
   * reverse/re-apply.
   * @param {object} record   One of {@link optionalGrantSteps}.
   */
  optionalGrantState(record) {
    const adv = record.advancement;
    // Both sides normalised. This content stores its uuids in the pre-v10 shape while `value.added`
    // records whatever `apply` was handed — so comparing them raw reported a taken item as untaken,
    // which showed a replacement grant's *base* as unselected and made clicking it do nothing.
    const taken = new Set(Object.values(adv.value?.added ?? {}).map(withItemSegment));
    return {
      options: Array.from(adv.configuration?.items ?? []).map(i => {
        const uuid = (typeof i === "string") ? i : i?.uuid;
        return uuid ? { uuid: withItemSegment(uuid), selected: taken.has(withItemSegment(uuid)) } : null;
      }).filter(Boolean)
    };
  }

  /**
   * Set exactly which of an optional grant's items the character takes.
   *
   * Reverse-then-apply rather than an incremental toggle: `ItemGrantAdvancement#apply` only ever
   * *adds* (it skips a uuid already in `value.added`), so there is no subtractive call to make and
   * un-ticking a box has to go through a full reverse. Reversing deletes the granted items, which is
   * exactly what declining one should do.
   * @param {object} record     One of {@link optionalGrantSteps}.
   * @param {string[]} uuids    The uuids to end up holding; anything else offered is dropped.
   */
  async setOptionalGrant(record, uuids) {
    const adv = record.advancement;
    // Both sides normalised, as {@link optionalGrantState} and the replacement-grant ingest already
    // are: this content stores its uuids in the pre-v10 shape while `value.added` records whatever
    // `apply` was handed, so comparing them raw never matched. The no-op short-circuit below then
    // never fired, and every click on a replacement grant paid a full reverse-and-re-apply to end
    // up exactly where it started.
    const wanted = new Set(uuids.map(withItemSegment));
    const current = new Set(Object.values(adv.value?.added ?? {}).map(withItemSegment));
    if ( (wanted.size === current.size) && [...wanted].every(u => current.has(u)) ) return;
    await adv.reverse(record.level);
    if ( wanted.size ) await adv.apply(record.level, { selected: [...wanted] });
    this.clone.reset();
  }

  /**
   * Set a size decision's chosen size on the clone (headless). Mirrors the native SizeFlow's apply.
   * @param {object} record   One of {@link sizeSteps}.
   * @param {string} key       The size key (e.g. "sm", "med").
   */
  async applySize(record, key) {
    await record.advancement.apply(record.level, { size: key });
    this.clone.reset();
  }

  /**
   * Apply a full ability-score-improvement assignment in one shot (headless) — the reverse→apply
   * pattern of {@link adjustAsi}, but taking the whole map (fixed + the player's allocation) the
   * creator recorded, rather than a single +/- step. Used for an origin's ability increase — the
   * 2024 background's, or the 2014 species'.
   * @param {object} record          One of {@link asiSteps}.
   * @param {Record<string, number>} assignments   Per-ability point totals.
   */
  async setAsi(record, assignments) {
    const adv = record.advancement;
    return this.#withOwnHeadroom(async () => {
      if ( adv.value.type ) await adv.reverse(record.level);
      await adv.apply(record.level, { type: "asi", assignments });
      this.clone.reset();
    });
  }

  /**
   * Apply a trait decision's full key set in one shot (headless): the player's picks already merged
   * with the advancement's automatic grants (see {@link CreationChoiceProvider#traitKeys}). The
   * choice-bearing Trait was surfaced without applying its grants, so a single `apply({ chosen })`
   * sets the complete set — matching the native flow's committed value.
   * @param {object} record        One of {@link traitSteps}.
   * @param {string[]} keys        The full chosen key set (grants ∪ picks).
   */
  async applyTraitKeys(record, keys) {
    await record.advancement.apply(record.level, { chosen: keys });
    this.clone.reset();
  }
}
