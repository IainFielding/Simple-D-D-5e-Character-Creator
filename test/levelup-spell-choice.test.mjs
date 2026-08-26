import { beforeEach, describe, expect, it } from "vitest";
import { choicesStep } from "../scripts/levelup/steps/choices-step.mjs";

/**
 * Spell-type `ItemChoice` decisions during level-up — a Paladin's **Blessed Warrior** fighting style
 * ("you learn two Cleric cantrips"), a Ranger's Druidic Warrior, a Magic Initiate variant.
 *
 * These carry an **empty** authored `pool`: the pickable spells are a named class spell *list*, given
 * as `restriction.list: ["class:cleric"]` with `restriction.level: "0"`. dnd5e's own flow renders no
 * inline options for that shape at all — it puts a "Browse" button on screen and hands the player to
 * the compendium browser. Reading only `configuration.pool` therefore produced a decision block with
 * a quota ("0 / 2 chosen") and nothing to click, so the block resolves the list itself.
 *
 * The fixture below is the real Blessed Warrior configuration, copied from the Player's Handbook
 * module's feats pack (`phbfstBlessedWar`).
 */

/** The cleric list the shared SpellSource stands in for, keyed the way `forSpellList` returns it. */
const CLERIC_LIST = {
  cantrips: [
    { uuid: "Compendium.dnd-players-handbook.spells.Item.sacredflame", name: "Sacred Flame", img: "s.webp" },
    { uuid: "Compendium.dnd-players-handbook.spells.Item.guidance", name: "Guidance", img: "g.webp" }
  ],
  level1: [
    { uuid: "Compendium.dnd-players-handbook.spells.Item.bless", name: "Bless", img: "b.webp" }
  ],
  level2: [
    { uuid: "Compendium.dnd-players-handbook.spells.Item.aid", name: "Aid", img: "a.webp" }
  ]
};

/**
 * Stands in for `SpellSource#forSpellList`, which indexes a list by spell level and *also* exposes
 * the first two buckets under their old names. Only levels the caller asked for are populated, so a
 * fetch capped at 1 cannot serve a 2nd-level restriction.
 */
const spellsStub = {
  calls: [],
  async forSpellList(classId, maxLevel) {
    this.calls.push([classId, maxLevel]);
    if ( classId !== "cleric" ) return { cantrips: [], level1: [], byLevel: {} };
    const byLevel = { 0: CLERIC_LIST.cantrips, 1: CLERIC_LIST.level1 };
    if ( maxLevel >= 2 ) byLevel[2] = CLERIC_LIST.level2;
    return { cantrips: CLERIC_LIST.cantrips, level1: CLERIC_LIST.level1, byLevel };
  }
};

/** The Blessed Warrior spell choice as a driver decision record, with its selection state. */
function blessedWarrior({ selected = [] } = {}) {
  const record = {
    level: 0, screenLevel: 2,
    advancement: {
      title: "Choose Cantrips",
      configuration: {
        allowDrops: true,
        choices: { 0: { count: 2, replacement: false } },
        pool: [],
        restriction: { list: ["class:cleric"], level: "0" },
        spell: { ability: ["cha"], method: "spell", prepared: 2 },
        type: "spell"
      }
    }
  };
  const st = {
    current: selected.length, max: 2, full: selected.length >= 2,
    selected: new Set(selected), replaceable: false, replacing: null, priorEntries: []
  };
  const state = { choiceSteps: [record], driver: { choiceState: () => st } };
  return { record, state, driver: state.driver };
}

beforeEach(() => {
  spellsStub.calls = [];
  // Nothing here should need a per-option document load: the list entries carry their own name/img.
  globalThis.fromUuid = async () => { throw new Error("unexpected fromUuid for a spell-list option"); };
});

describe("level-up spell choice (Blessed Warrior)", () => {
  it("offers the class list's cantrips even though the authored pool is empty", async () => {
    const { state, driver } = blessedWarrior();
    const data = await choicesStep.sectionsAt({ state, driver, spells: spellsStub }, 2);
    const names = data[0].sections[0].options.map(o => o.name);
    expect(names).toEqual(["Guidance", "Sacred Flame"]);     // sorted for scanability
  });

  it("draws from the level-≤1 memo the session warm-up already fills", async () => {
    const { state, driver } = blessedWarrior();
    await choicesStep.sectionsAt({ state, driver, spells: spellsStub }, 2);
    expect(spellsStub.calls).toEqual([["cleric", 1]]);
  });

  it("takes the cantrip bucket, not the level-1 spells", async () => {
    const { state, driver } = blessedWarrior();
    const data = await choicesStep.sectionsAt({ state, driver, spells: spellsStub }, 2);
    expect(data[0].sections[0].options.map(o => o.name)).not.toContain("Bless");
  });

  it("reports the block incomplete until both cantrips are picked", async () => {
    const { record, state, driver } = blessedWarrior();
    await choicesStep.sectionsAt({ state, driver, spells: spellsStub }, 2);
    // The pool has options left, so the exhausted escape hatch must not open the gate.
    expect(record.exhausted).toBe(false);
    expect(choicesStep.isCompleteAt(state, 2)).toBe(false);
  });

  it("completes once the quota is filled", async () => {
    const picked = CLERIC_LIST.cantrips.map(s => s.uuid);
    const { state, driver } = blessedWarrior({ selected: picked });
    const data = await choicesStep.sectionsAt({ state, driver, spells: spellsStub }, 2);
    expect(choicesStep.isCompleteAt(state, 2)).toBe(true);
    expect(data[0].sections[0].options.every(o => o.selected)).toBe(true);
  });

  it("marks nothing 'recommended' — every cantrip on the list is equally available", async () => {
    const { state, driver } = blessedWarrior();
    const data = await choicesStep.sectionsAt({ state, driver, spells: spellsStub }, 2);
    expect(data[0].sections[0].options.some(o => o.recommended)).toBe(false);
    expect(data[0].sections[0].groups).toBeNull();
  });

  it("draws a 2nd-level restriction from the same list, fetching deep enough to reach it", async () => {
    const { state, driver } = blessedWarrior();
    state.choiceSteps[0].advancement.configuration.restriction.level = "2";
    const data = await choicesStep.sectionsAt({ state, driver, spells: spellsStub }, 2);
    expect(data[0].sections[0].options.map(o => o.name)).toEqual(["Aid"]);
    expect(spellsStub.calls).toEqual([["cleric", 2]]);
  });

  it("yields no list options for a restriction level with no bucket to draw from", async () => {
    const { state, driver } = blessedWarrior();
    state.choiceSteps[0].advancement.configuration.restriction.level = "available";
    const data = await choicesStep.sectionsAt({ state, driver, spells: spellsStub }, 2);
    expect(data[0].sections[0].options).toEqual([]);
    expect(spellsStub.calls).toEqual([]);
  });

  it("survives a session with no spell source wired up", async () => {
    const { state, driver } = blessedWarrior();
    const data = await choicesStep.sectionsAt({ state, driver, spells: null }, 2);
    expect(data[0].sections[0].options).toEqual([]);
  });
});
