import { describe, expect, it } from "vitest";
import { LevelUpDriver } from "../scripts/levelup/manager-driver.mjs";

/**
 * Synthesised sub-features — the driver-side mirror of the manager's mid-walk step synthesis.
 * When a subclass (or feat) is chosen in the UI, the main walk has already finished, so the
 * driver itself must cycle through everything the choice reveals: the subclass's advancement
 * flows AND the advancements of any feature those flows grant. The shape under test is the
 * Eberron Artificer's Artillerist (module `dnd-forge-artificer`): its level-3 "Subclass
 * Features" ItemGrant hands out feature items that carry their own advancements —
 *
 *   Artillerist (subclass)
 *   └─ ItemGrant lvl 3 ─ grants → Tools of the Trade   (Trait grant + Trait CHOICE: 1 artisan tool)
 *                               → Artillerist Spells   (ItemGrant lvl 3: Shield, Thunderwave)
 *                               → Eldritch Cannon      (no further advancements)
 *
 * Without recursion the granted features land inert: no ranged-weapon proficiencies, no tool
 * choice surfaced, no subclass spells. These tests drive stubs shaped like that data.
 */

/** A Foundry-Collection-ish item store: get/set/delete plus the map/filter the driver uses. */
function makeItems(initial = []) {
  const m = new Map(initial.map(i => [i.id, i]));
  return {
    get: id => m.get(id),
    set: item => m.set(item.id, item),
    delete: id => m.delete(id),
    map: fn => [...m.values()].map(fn),
    filter: fn => [...m.values()].filter(fn),
    has: id => m.has(id),
    [Symbol.iterator]: () => m.values()
  };
}

/**
 * A manager stub whose class carries the static `flowsForLevel` the driver calls. Flows are
 * registered per item id; each carries `{ advancement, level, getAutomaticApplicationValue }`.
 */
function makeManager({ steps, clone, flowsByItem }) {
  class AdvancementManagerStub {
    static flowsForLevel(item, level) {
      return (flowsByItem.get(item.id) ?? []).filter(f => f.level === level);
    }
  }
  const manager = new AdvancementManagerStub();
  manager.actor = { system: { details: { level: 2 } }, items: makeItems() };
  manager.clone = clone;
  manager.steps = steps;
  return manager;
}

/** One forward class step at a class level, as the native manager shapes them. */
function classStep(level) {
  return { type: "forward", class: { item: { id: "clsArtificer0000" }, level }, level };
}

/** An automatic (grant) flow: its advancement's apply runs `effect` against the clone. */
function autoFlow(advType, level, item, effect = () => {}) {
  const advancement = {
    type: advType,
    item,
    configuration: {},
    applied: [],
    reversed: [],
    async apply(lvl, data, options) { this.applied.push({ lvl, data, options }); await effect(); },
    async reverse(lvl) { this.reversed.push(lvl); }
  };
  return { advancement, level, getAutomaticApplicationValue: async () => ({}) };
}

/** A choice flow (no automatic value): the driver must surface it as a decision. */
function choiceFlow(advType, level, item, title = "") {
  const advancement = {
    type: advType,
    title,
    item,
    configuration: { grants: [], choices: [{ count: 1, pool: ["tool:art:alchemist"] }] },
    value: { chosen: [] },
    reversed: [],
    async apply() {},
    async reverse(lvl) { this.reversed.push(lvl); }
  };
  return { advancement, level, getAutomaticApplicationValue: async () => false };
}

/**
 * Build the Artillerist-shaped world: a clone holding the class, a subclass whose level-3 grant
 * creates the three features, and the features' own flows (tool-choice Trait, spell grant).
 * Returns everything a test needs to drive and assert.
 */
function makeArtilleristWorld({ maxClassLevel = 3 } = {}) {
  const clone = { items: makeItems([{ id: "clsArtificer0000", type: "class" }]), reset: () => {} };

  const subclassItem = { id: "subArtillerist00", name: "Artillerist", hasAdvancement: true };
  const toolsFeature = { id: "featToolsTrade00", name: "Tools of the Trade", hasAdvancement: true };
  const spellsFeature = { id: "featArtiSpells00", name: "Artillerist Spells", hasAdvancement: true };
  const cannonFeature = { id: "featEldritchCan0", name: "Eldritch Cannon", hasAdvancement: false };

  const flowsByItem = new Map();

  // The subclass's level-3 "Subclass Features" grant creates the three feature items.
  const featuresGrant = autoFlow("ItemGrant", 3, subclassItem, () => {
    clone.items.set(toolsFeature);
    clone.items.set(spellsFeature);
    clone.items.set(cannonFeature);
  });
  flowsByItem.set(subclassItem.id, [featuresGrant]);

  // Tools of the Trade: an automatic Trait grant (ranged weapons) plus a Trait CHOICE (1 tool).
  const weaponsGrant = autoFlow("Trait", 3, toolsFeature);
  const toolChoice = choiceFlow("Trait", 3, toolsFeature, "Tool Proficiency");
  flowsByItem.set(toolsFeature.id, [weaponsGrant, toolChoice]);

  // Artillerist Spells: an automatic spell grant that puts Shield + Thunderwave on the clone.
  const spellsGrant = autoFlow("ItemGrant", 3, spellsFeature, () => {
    clone.items.set({ id: "splShield0000000", name: "Shield" });
    clone.items.set({ id: "splThunderwave00", name: "Thunderwave" });
  });
  flowsByItem.set(spellsFeature.id, [spellsGrant]);

  const steps = [];
  for ( let l = 3; l <= maxClassLevel; l++ ) steps.push(classStep(l));
  const driver = new LevelUpDriver(makeManager({ steps, clone, flowsByItem }));

  // The subclass decision as prepare() records it, with an advancement whose apply adds the item.
  const subclassAdv = {
    type: "Subclass",
    value: {},
    reversed: [],
    async apply(lvl, { uuid }) { this.value = { document: subclassItem, uuid }; clone.items.set(subclassItem); },
    async reverse(lvl) { this.reversed.push(lvl); this.value = {}; clone.items.delete(subclassItem.id); }
  };
  const record = { level: 3, screenLevel: 3, classLevel: 3, advancement: subclassAdv, item: null, featSynth: null };

  return { driver, clone, record, flowsByItem, subclassItem,
    featuresGrant, weaponsGrant, toolChoice, spellsGrant };
}

/* -------------------------------------------- */
/*  Recursive synthesis on subclass selection    */
/* -------------------------------------------- */

describe("resolveSubclass — nested feature advancements", () => {
  it("runs the advancements of features the subclass's grants created", async () => {
    const w = makeArtilleristWorld();
    await w.driver.resolveSubclass(w.record, "Compendium.efa.options.Item.artillerist");

    // The grant itself applied, and both nested automatic advancements applied too.
    expect(w.featuresGrant.advancement.applied).toHaveLength(1);
    expect(w.weaponsGrant.advancement.applied).toHaveLength(1);
    expect(w.spellsGrant.advancement.applied).toHaveLength(1);

    // The nested spell grant's spells actually landed on the clone.
    expect(w.clone.items.has("splShield0000000")).toBe(true);
    expect(w.clone.items.has("splThunderwave00")).toBe(true);
  });

  it("surfaces a granted feature's choice as a decision on the subclass's screen", async () => {
    const w = makeArtilleristWorld();
    await w.driver.resolveSubclass(w.record, "Compendium.efa.options.Item.artillerist");

    expect(w.driver.traitSteps).toHaveLength(1);
    const decision = w.driver.traitSteps[0];
    expect(decision.advancement).toBe(w.toolChoice.advancement);
    expect(decision.screenLevel).toBe(3);
  });

  it("records every synthesised flow so the pick can be reversed", async () => {
    const w = makeArtilleristWorld();
    await w.driver.resolveSubclass(w.record, "Compendium.efa.options.Item.artillerist");

    const flows = w.record.featSynth.flows;
    expect(flows).toContain(w.featuresGrant);
    expect(flows).toContain(w.weaponsGrant);
    expect(flows).toContain(w.toolChoice);
    expect(flows).toContain(w.spellsGrant);
    // Depth-first: the grant that created a feature precedes the feature's own flows, so the
    // reverse-order undo unwinds the feature's advancements before the grant removes it.
    expect(flows.indexOf(w.featuresGrant)).toBeLessThan(flows.indexOf(w.toolChoice));
  });

  it("clearSubclass reverses the nested advancements and drops their decisions", async () => {
    const w = makeArtilleristWorld();
    await w.driver.resolveSubclass(w.record, "Compendium.efa.options.Item.artillerist");
    await w.driver.clearSubclass(w.record);

    expect(w.toolChoice.advancement.reversed).toHaveLength(1);
    expect(w.spellsGrant.advancement.reversed).toHaveLength(1);
    expect(w.featuresGrant.advancement.reversed).toHaveLength(1);
    expect(w.record.advancement.reversed).toHaveLength(1);
    expect(w.driver.traitSteps).toHaveLength(0);
    expect(w.record.featSynth).toBeNull();
    expect(w.clone.items.has(w.subclassItem.id)).toBe(false);
  });
});

/* -------------------------------------------- */
/*  Multi-level jumps                            */
/* -------------------------------------------- */

/* -------------------------------------------- */
/*  Feature-choice picks (toggleChoice)          */
/* -------------------------------------------- */

/**
 * A Ranger's level-2 "Fighting Style" ItemChoice whose "Druidic Warrior" pick carries its own
 * ItemChoice ("Choose Cantrips") — the PHB shape that must surface as a further decision.
 */
function makeFightingStyleWorld() {
  const clone = { items: makeItems([{ id: "clsRanger0000000", type: "class" }]), reset: () => {} };
  const styleFeat = { id: "featDruidicWarr0", name: "Druidic Warrior", hasAdvancement: true };
  const flowsByItem = new Map();
  const cantripChoice = choiceFlow("ItemChoice", 0, styleFeat, "Choose Cantrips");
  flowsByItem.set(styleFeat.id, [cantripChoice]);

  const driver = new LevelUpDriver(makeManager({ steps: [classStep(2)], clone, flowsByItem }));

  const uuid = "Compendium.phb.feats.Item.druidicWarrior";
  const choiceAdv = {
    type: "ItemChoice",
    configuration: { choices: { 2: { count: 1, replacement: false } }, pool: [{ uuid }] },
    value: { added: {}, replaced: {} },
    getCounts(level) {
      const current = Object.keys(this.value.added[level] ?? {}).length;
      const max = this.configuration.choices[level]?.count ?? 0;
      return { current, max, full: current >= max };
    },
    async apply(level, { selected }) {
      for ( const u of selected ) {
        if ( u !== uuid ) continue;
        clone.items.set(styleFeat);
        (this.value.added[level] ??= {})[styleFeat.id] = u;
      }
    },
    async reverse(level, { uuid: u } = {}) {
      const added = this.value.added[level] ?? {};
      for ( const [id, su] of Object.entries(added) ) {
        if ( u && su !== u ) continue;
        clone.items.delete(id);
        delete added[id];
      }
    }
  };
  const record = { level: 2, screenLevel: 2, advancement: choiceAdv, item: null };
  driver.choiceSteps.push(record);
  return { driver, clone, record, uuid, styleFeat, cantripChoice };
}

describe("toggleChoice — picked item with its own advancements", () => {
  it("surfaces the pick's sub-choice as a decision on the pick's screen", async () => {
    const w = makeFightingStyleWorld();
    await w.driver.toggleChoice(w.record, w.uuid);

    expect(w.clone.items.has(w.styleFeat.id)).toBe(true);
    expect(w.driver.choiceSteps).toHaveLength(2);
    const nested = w.driver.choiceSteps[1];
    expect(nested.advancement).toBe(w.cantripChoice.advancement);
    // The sub-choice comes off a level-0 flow but belongs on the fighting style's screen.
    expect(nested.screenLevel).toBe(2);
  });

  it("unticking the pick reverses its sub-advancements and drops their decisions", async () => {
    const w = makeFightingStyleWorld();
    await w.driver.toggleChoice(w.record, w.uuid);
    await w.driver.toggleChoice(w.record, w.uuid);

    expect(w.cantripChoice.advancement.reversed).toHaveLength(1);
    expect(w.driver.choiceSteps).toHaveLength(1);
    expect(w.clone.items.has(w.styleFeat.id)).toBe(false);
    expect(w.record.pickSynth?.[w.uuid]).toBeUndefined();
  });
});

/* -------------------------------------------- */
/*  Half-feat ability increases                  */
/* -------------------------------------------- */

/**
 * An AbilityScoreImprovement flow as a feat carries it. PHB 2024 models a single-stat half-feat
 * (Actor's "+1 Cha") as 1 point with every other ability locked — not as a fixed bonus — so the
 * ingest must recognise a forced allocation and apply it rather than surfacing an empty "choice".
 */
function asiFlow(item, { points = 0, cap, locked = [], fixed = {}, allowFeat = false } = {}) {
  const advancement = {
    type: "AbilityScoreImprovement",
    item,
    allowFeat,
    configuration: { points, cap, locked: new Set(locked), fixed },
    value: {},
    applied: [],
    canImprove: () => true,
    // Mirrors AbilityScoreImprovementAdvancement#apply, including the `initial` branch the driver's
    // ingest seed relies on: the configuration's fixed part lands, and `value.type` settles to
    // "asi" unless the advancement also offers a feat (a feat's own increase never does).
    async apply(lvl, data, options = {}) {
      this.applied.push({ lvl, data, ...(options.initial ? { initial: true } : {}) });
      let type = data.type ?? this.value.type;
      if ( options.initial ) {
        if ( Object.values(this.configuration.fixed).some(v => v) ) data = { ...data, assignments: { ...fixed } };
        type = (data.assignments || !this.allowFeat) ? "asi" : null;
      }
      this.value.type = type;
      if ( data.assignments ) this.value.assignments = { ...(this.value.assignments ?? {}), ...data.assignments };
    },
    async reverse() {}
  };
  return { advancement, level: 0, getAutomaticApplicationValue: async () => false };
}

/** A feat granted through an ItemChoice pick, carrying one ASI flow of the given shape. */
function makeHalfFeatWorld(asiOpts) {
  const clone = {
    items: makeItems([{ id: "clsBard000000000", type: "class" }]),
    system: { abilities: {
      str: { value: 10 }, dex: { value: 10 }, con: { value: 10 },
      int: { value: 10 }, wis: { value: 10 }, cha: { value: 15 }
    } },
    reset: () => {}
  };
  const featItem = { id: "featActor0000000", name: "Actor", hasAdvancement: true };
  const flowsByItem = new Map();
  const asi = asiFlow(featItem, asiOpts);
  flowsByItem.set(featItem.id, [asi]);

  const driver = new LevelUpDriver(makeManager({ steps: [classStep(4)], clone, flowsByItem }));

  const uuid = "Compendium.phb.feats.Item.actor";
  const choiceAdv = {
    type: "ItemChoice",
    configuration: { choices: { 4: { count: 1, replacement: false } }, pool: [{ uuid }] },
    value: { added: {}, replaced: {} },
    getCounts(level) {
      const current = Object.keys(this.value.added[level] ?? {}).length;
      const max = this.configuration.choices[level]?.count ?? 0;
      return { current, max, full: current >= max };
    },
    async apply(level, { selected }) {
      for ( const u of selected ) {
        if ( u !== uuid ) continue;
        clone.items.set(featItem);
        (this.value.added[level] ??= {})[featItem.id] = u;
      }
    },
    async reverse() {}
  };
  const record = { level: 4, screenLevel: 4, advancement: choiceAdv, item: null };
  driver.choiceSteps.push(record);
  return { driver, record, uuid, asi };
}

describe("half-feat ability score improvement ingest", () => {
  it("auto-applies the points when only one ability is open (Actor's +1 Cha)", async () => {
    const w = makeHalfFeatWorld({ points: 1, cap: 1, locked: ["str", "dex", "con", "int", "wis"] });
    await w.driver.toggleChoice(w.record, w.uuid);

    // Two applies: the ingest seed the native manager also performs, then the forced allocation.
    expect(w.asi.advancement.applied).toHaveLength(2);
    expect(w.asi.advancement.applied[0]).toMatchObject({ data: {}, initial: true });
    expect(w.asi.advancement.applied[1].data).toEqual({ type: "asi", assignments: { cha: 1 } });
    // Forced allocation: nothing to decide, so no ASI decision surfaces.
    expect(w.driver.asiSteps).toHaveLength(0);
  });

  it("still surfaces a decision when more than one ability is open (Resilient)", async () => {
    const w = makeHalfFeatWorld({ points: 1, cap: 1, locked: [] });
    await w.driver.toggleChoice(w.record, w.uuid);

    expect(w.driver.asiSteps).toHaveLength(1);
    // The seed alone settles `value.type`, so nothing is applied on top of it.
    expect(w.asi.advancement.applied).toHaveLength(1);
    expect(w.asi.advancement.applied[0]).toMatchObject({ data: {}, initial: true });
    expect(w.asi.advancement.value.type).toBe("asi");
  });

  it("featAbilityRows shows the applied bonus and locks every other ability", async () => {
    const w = makeHalfFeatWorld({ points: 1, cap: 1, locked: ["str", "dex", "con", "int", "wis"] });
    await w.driver.toggleChoice(w.record, w.uuid);

    const featRecord = { featSynth: { flows: [w.asi] } };
    const rows = w.driver.featAbilityRows(featRecord);
    expect(rows).toHaveLength(6);
    const cha = rows.find(r => r.key === "cha");
    expect(cha).toMatchObject({ bonusLabel: "+1", locked: false, canInc: false, canDec: false });
    for ( const row of rows.filter(r => r.key !== "cha") ) {
      expect(row).toMatchObject({ bonusLabel: "", locked: true });
    }
  });

  it("featAbilityRows locks everything for a feat with no ability increase", () => {
    const w = makeHalfFeatWorld({});
    const rows = w.driver.featAbilityRows({ featSynth: { flows: [] } });
    expect(rows).toHaveLength(6);
    for ( const row of rows ) expect(row).toMatchObject({ bonusLabel: "", locked: true });
  });
});

describe("resolveSubclass — multi-level jump", () => {
  it("ingests subclass flows up to the level-up's final class level", async () => {
    const w = makeArtilleristWorld({ maxClassLevel: 5 });
    // Arcane Firearm: the Artillerist's level-5 grant, beyond the level the subclass is picked at.
    const firearmGrant = autoFlow("ItemGrant", 5, w.subclassItem, () => {
      w.clone.items.set({ id: "featArcaneFire00", name: "Arcane Firearm", hasAdvancement: false });
    });
    w.flowsByItem.get(w.subclassItem.id).push(firearmGrant);

    await w.driver.resolveSubclass(w.record, "Compendium.efa.options.Item.artillerist");
    expect(firearmGrant.advancement.applied).toHaveLength(1);
    expect(w.clone.items.has("featArcaneFire00")).toBe(true);
  });

  it("keeps a later level's decision on its own screen but never below the subclass screen", async () => {
    const w = makeArtilleristWorld({ maxClassLevel: 5 });
    const lateChoice = choiceFlow("Trait", 5, w.subclassItem, "Level 5 Pick");
    const earlyChoice = choiceFlow("Trait", 2, w.subclassItem, "Level 2 Pick");
    w.flowsByItem.get(w.subclassItem.id).push(lateChoice, earlyChoice);

    await w.driver.resolveSubclass(w.record, "Compendium.efa.options.Item.artillerist");
    const screens = w.driver.traitSteps.map(r => [r.advancement.title, r.screenLevel]);
    // The level-2 pick has no screen of its own (the jump starts at 3) — it folds onto the
    // subclass's screen; the level-5 pick stays on the level-5 screen.
    expect(screens).toContainEqual(["Level 2 Pick", 3]);
    expect(screens).toContainEqual(["Level 5 Pick", 5]);
  });
});

/* -------------------------------------------- */
/*  Feat with a declinable grant (Cold Caster)  */
/* -------------------------------------------- */

/**
 * A feat whose granted item the pack marks `optional` — Cold Caster, whose Ray of Frost is the one
 * item of the five spell-granting feats flagged that way, because its text lets a character who
 * already knows the cantrip learn a different one.
 */
function optionalGrantFlow(item, level = 0) {
  const uuid = "Compendium.phb.spells.Item.rayOfFrost";
  const advancement = {
    _id: "advColdCasterGrant",
    type: "ItemGrant",
    item,
    configuration: {
      items: [{ uuid, optional: true }],
      spell: { ability: ["int", "wis", "cha"], method: "spell", prepared: 2 }
    },
    value: { added: {} },
    reversed: [],
    async apply() {},
    async reverse(lvl) { this.reversed.push(lvl); }
  };
  // No automatic value: an optional item is a decision, which is what routes it to the driver's
  // optional-grant branch rather than being applied outright.
  return { advancement, level, getAutomaticApplicationValue: async () => false };
}

/** A world whose level-4 feature choice grants a feat carrying that declinable spell grant. */
function makeOptionalGrantWorld() {
  const clone = { items: makeItems([{ id: "clsFighter000000", type: "class" }]), reset: () => {} };
  const featItem = { id: "featColdCaster00", name: "Cold Caster", hasAdvancement: true };
  const grant = optionalGrantFlow(featItem, 0);
  const flowsByItem = new Map([[featItem.id, [grant]]]);

  const driver = new LevelUpDriver(makeManager({ steps: [classStep(4)], clone, flowsByItem }));
  const uuid = "Compendium.hof.options.Item.coldCaster";
  const choiceAdv = {
    type: "ItemChoice",
    configuration: { choices: { 4: { count: 1, replacement: false } }, pool: [{ uuid }] },
    value: { added: {}, replaced: {} },
    getCounts(level) {
      const current = Object.keys(this.value.added[level] ?? {}).length;
      return { current, max: this.configuration.choices[level]?.count ?? 0, full: current >= 1 };
    },
    async apply(level, { selected }) {
      for ( const u of selected ) {
        if ( u !== uuid ) continue;
        clone.items.set(featItem);
        (this.value.added[level] ??= {})[featItem.id] = u;
      }
    },
    async reverse() {}
  };
  const record = { level: 4, screenLevel: 4, advancement: choiceAdv, item: null };
  driver.choiceSteps.push(record);
  return { driver, record, uuid, grant };
}

describe("a feat whose grant the player may decline", () => {
  it("puts the decision on the granting screen, not on a phantom level-0 one", async () => {
    // The bug this pins: a feat's advancements all come off level-0 flows, and the synth's
    // re-pointing pass covered choices, ASIs, traits and grants but not *optional* grants. The
    // record kept `screenLevel: 0`, and `gainedLevels()` reads that array like any other — so a
    // Fighter taking Cold Caster grew a "Level 0" screen in the rail.
    const w = makeOptionalGrantWorld();
    await w.driver.toggleChoice(w.record, w.uuid);

    expect(w.driver.optionalGrantSteps).toHaveLength(1);
    expect(w.driver.optionalGrantSteps[0].screenLevel).toBe(4);
  });

  it("tracks the decision on the synth, so undoing the pick takes it away too", async () => {
    // Left untracked it also leaked: swapping the feat for another kept offering the old feat's
    // spell, on a screen for a feat the character no longer had.
    const w = makeOptionalGrantWorld();
    await w.driver.toggleChoice(w.record, w.uuid);
    expect(w.record.pickSynth[w.uuid].optionalGrants).toHaveLength(1);

    await w.driver.toggleChoice(w.record, w.uuid);
    expect(w.driver.optionalGrantSteps).toHaveLength(0);
  });
});

/* -------------------------------------------- */
/*  Retained data on a synthesised flow          */
/* -------------------------------------------- */

/**
 * A granted feature the walk has *seen before*. When a manager retains an advancement's data —
 * an item swapped out and back, a level taken down and re-taken — the flow it hands back through
 * `findExisting` carries `retainedData`, and the choices in it must be restored rather than asked
 * for a second time. The steps we synthesise are spliced into the manager's own array (we adopt it
 * wholesale in the constructor), so a retained flow reaches this path exactly as it reaches the
 * system's. dnd5e 6.0.0 fixed the same omission in `AdvancementManager##synthesizeSteps`; this is
 * the driver-side mirror of that fix.
 */
function makeRetainedWorld({ retainedData } = {}) {
  const classItem = { id: "clsArtificer0000", type: "class" };
  const clone = { items: makeItems([classItem]), reset: () => {} };
  const feature = { id: "featRetained0000", name: "Tools of the Trade", hasAdvancement: true, system: {} };

  const restored = [];
  const applied = [];
  const featureAdv = {
    type: "Trait",
    item: feature,
    configuration: { grants: [], choices: [{ count: 1, pool: ["tool:art:alchemist"] }] },
    value: { chosen: [] },
    async apply(level, data, options) { applied.push({ level, data, options }); },
    async restore(level, data) { restored.push({ level, data }); }
  };
  const featureFlow = { advancement: featureAdv, level: 3, getAutomaticApplicationValue: async () => false };
  if ( retainedData ) featureFlow.retainedData = retainedData;

  const flowsByItem = new Map([[feature.id, [featureFlow]]]);

  // The class's own level-3 grant is what puts the feature on the clone mid-walk.
  const grant = autoFlow("ItemGrant", 3, classItem, () => clone.items.set(feature));
  const steps = [{ type: "forward", class: { item: classItem, level: 3 }, level: 3, flow: grant }];

  const driver = new LevelUpDriver(makeManager({ steps, clone, flowsByItem }));
  return { driver, restored, applied, featureFlow };
}

describe("synthesised steps for a flow that kept its data", () => {
  it("restores the retained choices instead of asking for them again", async () => {
    const retainedData = { chosen: ["tool:art:alchemist"] };
    const w = makeRetainedWorld({ retainedData });
    await w.driver.prepare();

    expect(w.driver.steps[1]).toMatchObject({ type: "restore", automatic: true, synthetic: true });
    expect(w.restored).toEqual([{ level: 3, data: retainedData }]);
    expect(w.applied).toHaveLength(0);
    expect(w.driver.traitSteps).toHaveLength(0);
  });

  it("still surfaces a first-time choice as a decision", async () => {
    const w = makeRetainedWorld();
    await w.driver.prepare();

    expect(w.driver.steps[1]).toMatchObject({ type: "forward", synthetic: true });
    expect(w.restored).toHaveLength(0);
    expect(w.driver.traitSteps).toHaveLength(1);
  });
});
