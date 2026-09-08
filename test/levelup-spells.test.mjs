import { describe, expect, it } from "vitest";
import { computeSpellPlan, lvlSpellsStep, spellChanges } from "../scripts/levelup/steps/lvl-spells-step.mjs";
import { fighter, wizard } from "./fixtures/dnd5e-5.3.3.mjs";

/**
 * The level-up spell math: {@link computeSpellPlan} decides whether a spell step exists and how
 * many cantrips/prepared spells the player may add (reading the class's real ScaleValue tables
 * and the derived preparation/slot data), and {@link spellChanges} resolves the staged picks and
 * the 2024 swap rule into concrete creates/deletes. These numbers directly decide what gets
 * created — and deleted — on a player's sheet, so they get the densest coverage.
 */

/** A spell item stub as computeSpellPlan reads it (type/level/sourceItem only). */
function spell(level, sourceItem) {
  return { type: "spell", system: { level, sourceItem, prepared: 1 } };
}

/**
 * An actor-like holding a levelled wizard. `preparation.max/value` are derived fields on a live
 * actor; the tests set them to the values the real formula (`@scale.wizard.max-prepared`) and
 * the system's prepared-spell counter would produce for the modelled state.
 */
function makeWizardActor({ classLevel, preparedMax, preparedValue, slots = {}, items = [] } = {}) {
  const cls = structuredClone(wizard);
  cls.id = cls._id;
  cls.system.levels = classLevel;
  cls.system.spellcasting.preparation = { max: preparedMax, value: preparedValue };
  const spells = Object.fromEntries(Object.entries(slots).map(([key, max]) => [key, { max }]));
  return {
    cls,
    actor: { items: [cls, ...items], system: { details: { level: classLevel }, spells } }
  };
}

/* -------------------------------------------- */
/*  computeSpellPlan                             */
/* -------------------------------------------- */

describe("computeSpellPlan", () => {
  it("marks a non-caster (Fighter) as having no spell step", () => {
    const cls = structuredClone(fighter);
    cls.id = cls._id;
    cls.system.levels = 4;
    const actor = { items: [cls], system: { details: { level: 4 }, spells: {} } };
    const plan = computeSpellPlan(actor, cls);
    expect(plan.isSpellcaster).toBe(false);
    expect(plan.hasDelta).toBe(false);
    expect(plan.addCantrips).toBe(0);
    expect(plan.addSpells).toBe(0);
  });

  it("reads the wizard's capacity off its real scales at level 4", () => {
    // Level 4: Cantrips Known 4 (scale bumps at 4), Max Prepared 7. The character knows 3
    // cantrips and has 5 spells prepared, with slots up to 2nd level.
    const { actor, cls } = makeWizardActor({
      classLevel: 4, preparedMax: 7, preparedValue: 5,
      slots: { spell1: 4, spell2: 3 },
      items: [
        spell(0, "class:wizard"), spell(0, "class:wizard"), spell(0, "class:wizard"),
        spell(1, "class:wizard")
      ]
    });
    const plan = computeSpellPlan(actor, cls);
    expect(plan.isSpellcaster).toBe(true);
    expect(plan.listType).toBe("class");
    expect(plan.sourceTag).toBe("class:wizard");
    expect(plan.classLevel).toBe(4);
    expect(plan.cantripTarget).toBe(4);
    expect(plan.cantripHave).toBe(3);
    expect(plan.addCantrips).toBe(1);
    expect(plan.spellTarget).toBe(7);
    expect(plan.spellHave).toBe(5);
    expect(plan.addSpells).toBe(2);
    expect(plan.maxSpellLevel).toBe(2);
    expect(plan.hasDelta).toBe(true);
  });

  it("reads a sparse scale by falling back to the last increase at or below the level", () => {
    // The cantrip scale only has entries at 1/4/10 — level 3 must read the level-1 value (3),
    // not zero from the missing key.
    const { actor, cls } = makeWizardActor({ classLevel: 3, preparedMax: 6, preparedValue: 6, slots: { spell1: 4, spell2: 2 } });
    const plan = computeSpellPlan(actor, cls);
    expect(plan.cantripTarget).toBe(3);
    expect(plan.addSpells).toBe(0);   // prepared is already at target
  });

  it("never offers leveled spells when the actor has no slots, even below target", () => {
    const { actor, cls } = makeWizardActor({ classLevel: 1, preparedMax: 4, preparedValue: 0, slots: {} });
    const plan = computeSpellPlan(actor, cls);
    expect(plan.maxSpellLevel).toBe(0);
    expect(plan.addSpells).toBe(0);
    // Cantrips need no slots, so the delta can still exist.
    expect(plan.addCantrips).toBe(3);
    expect(plan.hasDelta).toBe(true);
  });

  it("bounds the pool by pact-magic slots when those outrank leveled ones", () => {
    const { actor, cls } = makeWizardActor({ classLevel: 5, preparedMax: 9, preparedValue: 6, slots: { spell1: 4 } });
    actor.system.spells.pact = { max: 2, level: 3 };
    const plan = computeSpellPlan(actor, cls);
    expect(plan.maxSpellLevel).toBe(3);
  });

  it("only counts cantrips carrying this caster's own sourceItem tag", () => {
    // A Magic Initiate cantrip must not eat the wizard's cantrip capacity.
    const { actor, cls } = makeWizardActor({
      classLevel: 1, preparedMax: 4, preparedValue: 0, slots: { spell1: 2 },
      items: [spell(0, "class:wizard"), spell(0, "feat:magic-initiate"), spell(0, "")]
    });
    const plan = computeSpellPlan(actor, cls);
    expect(plan.cantripHave).toBe(1);
    expect(plan.addCantrips).toBe(2);
  });

  /**
   * A feature granting a spell the character already chose at an earlier level is about to be
   * collapsed into one always-prepared document ({@link module:build/spell-reconcile}). The copy
   * that disappears is the one still counted in `preparation.value`, so without compensating here
   * the freed selection would only surface at the *next* level-up, as an unexplained extra pick.
   */
  it("hands back the selection a pending granted-spell merge will free", () => {
    const identified = (level, sourceItem, { origin = null, prepared = 1 } = {}) => ({
      id: origin ? "granted" : "chosen",
      type: "spell",
      _stats: { compendiumSource: "Compendium.dnd5e.spells24.Item.phbsplDivineSmit" },
      flags: origin ? { dnd5e: { advancementOrigin: origin } } : {},
      getFlag: (scope, key) => (origin ? { dnd5e: { advancementOrigin: origin } } : {})[scope]?.[key],
      system: { level, sourceItem, prepared, method: "spell" }
    });
    const { actor, cls } = makeWizardActor({
      classLevel: 4, preparedMax: 7, preparedValue: 5,
      slots: { spell1: 4, spell2: 3 },
      items: [
        identified(1, "class:wizard"),                                    // chosen earlier
        identified(1, "class:wizard", { origin: "subX.advY", prepared: 2 })  // now granted
      ]
    });
    const plan = computeSpellPlan(actor, cls);
    expect(plan.releasedSpells).toBe(1);
    // 7 max − 5 prepared = 2 by capacity, plus the one the merge is about to give back.
    expect(plan.addSpells).toBe(3);
  });

  it("frees nothing when a granted spell has no chosen twin", () => {
    const { actor, cls } = makeWizardActor({
      classLevel: 4, preparedMax: 7, preparedValue: 5, slots: { spell1: 4, spell2: 3 }
    });
    const plan = computeSpellPlan(actor, cls);
    expect(plan.releasedSpells).toBe(0);
    expect(plan.releasedCantrips).toBe(0);
    expect(plan.addSpells).toBe(2);
  });

  it("finds the caster on a spellcasting subclass when the class itself has none", () => {
    // Modelled on the PHB Eldritch Knight: the fighter has progression "none"; the subclass
    // carries progression "third" and its own Cantrips Known scale keyed by *class* level.
    const cls = structuredClone(fighter);
    cls.id = cls._id;
    cls.system.levels = 7;
    const ek = {
      id: "subEldritchKnigh", type: "subclass",
      system: {
        identifier: "eldritch-knight",
        classIdentifier: "fighter",
        spellcasting: { progression: "third", ability: "int", preparation: { max: 5, value: 4 } },
        advancement: [{
          _id: "ekCantripScale00", type: "ScaleValue", title: "Cantrips Known",
          configuration: { identifier: "", type: "number", scale: { 3: { value: 2 }, 10: { value: 3 } } },
          value: {}
        }]
      }
    };
    const actor = {
      items: [cls, ek, spell(0, "subclass:eldritch-knight")],
      system: { details: { level: 7 }, spells: { spell1: { max: 4 }, spell2: { max: 2 } } }
    };
    const plan = computeSpellPlan(actor, cls);
    expect(plan.isSpellcaster).toBe(true);
    expect(plan.listType).toBe("subclass");
    expect(plan.listId).toBe("eldritch-knight");
    expect(plan.sourceTag).toBe("subclass:eldritch-knight");
    expect(plan.classLevel).toBe(7);      // scales key off the base class's level
    expect(plan.cantripTarget).toBe(2);
    expect(plan.cantripHave).toBe(1);
    expect(plan.addCantrips).toBe(1);
    expect(plan.addSpells).toBe(1);
  });

  it("reports no delta when every capacity is already filled", () => {
    const { actor, cls } = makeWizardActor({
      classLevel: 2, preparedMax: 5, preparedValue: 5, slots: { spell1: 3 },
      items: [spell(0, "class:wizard"), spell(0, "class:wizard"), spell(0, "class:wizard")]
    });
    const plan = computeSpellPlan(actor, cls);
    expect(plan.addCantrips).toBe(0);
    expect(plan.addSpells).toBe(0);
    expect(plan.hasDelta).toBe(false);
  });
});

/* -------------------------------------------- */
/*  spellChanges (staged picks + the swap rule)  */
/* -------------------------------------------- */

/** A state-like with a fixed plan and staged picks, as spellChanges reads it. */
function makeState({ addCantrips = 1, addSpells = 2, cantrips = [], spells = [], swapCantrip = null, swapSpell = null } = {}) {
  return {
    spellPlan: () => ({ sourceTag: "class:wizard", addCantrips, addSpells }),
    selectedCantrips: cantrips,
    selectedSpells: spells,
    swapCantrip,
    swapSpell
  };
}

const pick = name => ({ uuid: `Compendium.x.Item.${name}`, name });

describe("spellChanges", () => {
  it("creates every staged pick and deletes nothing without a swap", () => {
    const state = makeState({ cantrips: [pick("light")], spells: [pick("shield"), pick("sleep")] });
    const { sourceTag, create, deleteIds } = spellChanges(state);
    expect(sourceTag).toBe("class:wizard");
    expect(create.map(c => c.name)).toEqual(["light", "shield", "sleep"]);
    expect(deleteIds).toEqual([]);
  });

  it("deletes a swapped-out spell only when its freed slot was actually used", () => {
    // Budget 2, three picks: the third pick used the swap's freed slot, so the swap fires.
    const used = makeState({
      addSpells: 2,
      spells: [pick("shield"), pick("sleep"), pick("thunderwave")],
      swapSpell: { id: "oldSpell00000000", name: "Jump" }
    });
    expect(spellChanges(used).deleteIds).toEqual(["oldSpell00000000"]);

    // Budget 2, two picks: the freed slot went unused — marking must be a harmless no-op.
    const unused = makeState({
      addSpells: 2,
      spells: [pick("shield"), pick("sleep")],
      swapSpell: { id: "oldSpell00000000", name: "Jump" }
    });
    expect(spellChanges(unused).deleteIds).toEqual([]);
  });

  it("tracks cantrip and leveled-spell swaps independently", () => {
    const state = makeState({
      addCantrips: 0, addSpells: 1,
      cantrips: [pick("light")],                  // uses the cantrip swap's freed slot
      spells: [pick("shield")],                   // within budget: leveled swap unused
      swapCantrip: { id: "oldCantrip000000", name: "Ray of Frost" },
      swapSpell: { id: "oldSpell00000000", name: "Jump" }
    });
    expect(spellChanges(state).deleteIds).toEqual(["oldCantrip000000"]);
  });
});

/* -------------------------------------------- */
/*  Edition-gated swapping                       */
/* -------------------------------------------- */

/**
 * Which replacements a level-up may offer, by rules edition — see {@link module:data/spell-swap}.
 *
 * The rule this encodes: replacing a *cantrip* when you gain a level arrived with the 2024 PHB. No
 * 2014 class does it, so a 2014 Sorcerer used to be offered a swap the rules never grant. The
 * leveled-spell swap survives in both editions and only changes its wording, because in dnd5e a
 * prepared spell is an ordinary Item and trading one for another is how a prepared list changes.
 */
describe("computeSpellPlan swap allowance", () => {
  /** A 2014 or 2024 wizard actor — the fixture with its `source.rules` set (or cleared). */
  function editionWizard(rules, identifier = "wizard") {
    const { cls, actor } = makeWizardActor({
      classLevel: 4, preparedMax: 7, preparedValue: 5, slots: { spell1: 4, spell2: 3 }
    });
    cls.system.identifier = identifier;
    if ( rules === null ) delete cls.system.source;
    else cls.system.source = { ...(cls.system.source ?? {}), rules };
    return { cls, actor };
  }

  it("offers both swaps under the 2024 rules", () => {
    const { cls, actor } = editionWizard("2024");
    const plan = computeSpellPlan(actor, cls);
    expect(plan.canSwapCantrip).toBe(true);
    expect(plan.canSwapSpell).toBe(true);
  });

  it("withholds the cantrip swap under the 2014 rules", () => {
    const { cls, actor } = editionWizard("2014", "sorcerer");
    const plan = computeSpellPlan(actor, cls);
    expect(plan.canSwapCantrip).toBe(false);
    // A 2014 Sorcerer knows a fixed list and does trade one spell on level-up.
    expect(plan.canSwapSpell).toBe(true);
    expect(plan.swapLabelKey).toBe("levelup.step.spells.swapHint");
  });

  it("re-words the swap for a 2014 prepared caster rather than removing it", () => {
    const { cls, actor } = editionWizard("2014", "wizard");
    const plan = computeSpellPlan(actor, cls);
    expect(plan.canSwapSpell).toBe(true);
    expect(plan.swapLabelKey).toBe("levelup.step.spells.swapHintPrepared");
  });

  it("treats a class that names no edition as 2024, so homebrew keeps every option", () => {
    const { cls, actor } = editionWizard(null, "warmage");
    const plan = computeSpellPlan(actor, cls);
    expect(plan.canSwapCantrip).toBe(true);
    expect(plan.canSwapSpell).toBe(true);
  });
});

/* -------------------------------------------- */
/*  Owned rows say what they are                 */
/* -------------------------------------------- */

/**
 * A spell already on the sheet appears in a list headed "choose the spells you learn", which is a
 * contradiction until something explains it. The row carries a flag under the compare pin (the one
 * place on a 224px card that costs the name no width) with a tooltip behind it, and the detail pane
 * carries the long form. All of it follows the caster: a 2014 prepared class changes what it has
 * prepared rather than forgetting a spell it knows, and the same edition test that words the step's
 * hint words the flag, the tooltip and the note.
 */
describe("owned spell rows", () => {
  /** The one spell the character already has, as ownedSpells() reads it off an actor. */
  const KNOWN = {
    type: "spell", id: "own1", name: "Magic Missile", img: "", uuid: "Actor.a.Item.own1",
    _stats: { compendiumSource: "Compendium.dnd5e.spells.Item.mm" },
    system: {
      level: 1, prepared: 1, sourceItem: "class:wizard", identifier: "magic-missile",
      school: "evo", properties: []
    }
  };
  /** One unknown spell in the pool, so the list isn't all swap candidates. */
  const POOL = {
    uuid: "Compendium.dnd5e.spells.Item.shield", name: "Shield", img: "", level: 1,
    identifier: "shield", school: "Abjuration", propertyKeys: ""
  };

  const spells = {
    forClassAtLevel: async () => ({ byLevel: { 0: [], 1: [POOL] } }),
    description: async () => "<p>A dart of force.</p>",
    sourceBook: async () => "PHB"
  };

  function stateFor({ prepared = false, swapSpell = null, focus = null } = {}) {
    return {
      actor: { items: [KNOWN] },
      spellSource: { items: [] },     // nothing owned *by identity*, so the pool row survives
      classItem: { name: "Wizard" },
      spellTab: "spells",
      focusedSpellUuid: focus,
      selectedCantrips: [], selectedSpells: [],
      swapCantrip: null, swapSpell,
      spellListOverride: "",
      spellPlan: () => ({
        isSpellcaster: true, sourceTag: "class:wizard", castUuid: "Compendium.x.Item.wiz",
        listType: "class", maxSpellLevel: 1, addCantrips: 0, addSpells: 1,
        canSwapCantrip: false, canSwapSpell: true,
        releasedCantrips: 0, releasedSpells: 0,
        swapLabelKey: prepared
          ? "levelup.step.spells.swapHintPrepared" : "levelup.step.spells.swapHint"
      })
    };
  }

  it("flags the known spell, above the pool, with the tooltip that explains it", async () => {
    const ctx = await lvlSpellsStep.context({ state: stateFor(), spells });
    expect(ctx.list[0].owned).toBe(true);
    expect(ctx.list[0].name).toBe("Magic Missile");
    expect(ctx.list[0].ownedTag).toBe("sogrom-dnd5e-character-creator.levelup.step.spells.ownedTag");
    expect(ctx.list[0].ownedTip).toBe("sogrom-dnd5e-character-creator.levelup.step.spells.ownedTip");
    // A pool spell is not a swap candidate and carries none of it.
    expect(ctx.list[1].owned).toBe(false);
    expect(ctx.list[1].ownedTag).toBeUndefined();
  });

  it("uses the prepared wording throughout for a 2014 prepared caster", async () => {
    const ctx = await lvlSpellsStep.context({ state: stateFor({ prepared: true }), spells });
    expect(ctx.list[0].ownedTag).toBe("sogrom-dnd5e-character-creator.levelup.step.spells.ownedTagPrepared");
    expect(ctx.list[0].ownedTip).toBe("sogrom-dnd5e-character-creator.levelup.step.spells.ownedTipPrepared");
    expect(ctx.swapHint).toBe("sogrom-dnd5e-character-creator.levelup.step.spells.swapHintPrepared");
  });

  it("names the marked spell and the extra pick it bought", async () => {
    const state = stateFor({ swapSpell: { id: "own1", name: "Magic Missile" } });
    const ctx = await lvlSpellsStep.context({ state, spells });
    expect(ctx.list.find(s => s.owned).swapMarked).toBe(true);
    expect(ctx.list.find(s => s.owned).swapTag).toBe("sogrom-dnd5e-character-creator.levelup.step.spells.swapTag");
    // The raised budget is named rather than left as an unexplained +1.
    expect(ctx.swapActiveHint).toContain("levelup.step.spells.swapActive");
    expect(ctx.swapActiveHint).toContain("Magic Missile");
    expect(ctx.addSpells).toBe(2);
  });

  it("gives the focused detail the long-form note, in both swap states", async () => {
    const plain = await lvlSpellsStep.context({ state: stateFor({ focus: KNOWN._stats.compendiumSource }), spells });
    expect(plain.focused.note).toBe("sogrom-dnd5e-character-creator.levelup.step.spells.ownedNote");

    const marked = await lvlSpellsStep.context({
      state: stateFor({ focus: KNOWN._stats.compendiumSource, swapSpell: { id: "own1", name: "Magic Missile" } }),
      spells
    });
    expect(marked.focused.note).toBe("sogrom-dnd5e-character-creator.levelup.step.spells.swapNote");
  });

  it("leaves an ordinary pool spell without a note", async () => {
    const ctx = await lvlSpellsStep.context({ state: stateFor({ focus: POOL.uuid }), spells });
    expect(ctx.focused.note).toBe("");
  });
});
