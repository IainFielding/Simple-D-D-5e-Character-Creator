import { describe, it, expect, beforeEach } from "vitest";
import { compareRows, pinContext, PinSet, MAX_PINS } from "../scripts/app/compare.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * The comparison grid is a *transpose* of what the detail pane already shows: `advancementGroups()`
 * flattens an item's traits and granted items once, and this turns that ninety degrees. So the
 * tests here feed it the block shape that method produces rather than raw compendium documents —
 * that seam has its own tests (source-invalidation, advancement-shapes), and duplicating them here
 * would test dnd5e rather than the grid.
 *
 * What is worth pinning down is the judgement: which rows survive, how a trait the columns word
 * differently is reconciled into one row, and that a row nobody has anything to say about is
 * dropped rather than rendered as a line of em-dashes.
 */

beforeEach(() => installFoundryShims());

/** A resolved compare entry, in the shape `buildCompare` assembles before transposing. */
function entry({ name = "Thing", source = "PHB 2024", tags = [], features = [], spells = [], system = {}, asi = null } = {}) {
  const groups = [];
  if ( tags.length ) groups.push({ key: "traits", tags });
  if ( features.length ) groups.push({ key: "features", items: features });
  if ( spells.length ) groups.push({ key: "spells", items: spells });
  return { uuid: `Compendium.x.y.Item.${name}`, doc: { name, system }, detail: { name, source }, groups, asi };
}

const row = (rows, key) => rows.find(r => r.key === key);
const texts = r => r.cells.map(c => c.text);

/* -------------------------------------------- */
/*  The pin store                               */
/* -------------------------------------------- */

describe("PinSet", () => {
  it("keeps pins in the order they were made, because that is column order", () => {
    const pins = new PinSet();
    pins.toggle("subclass", "b");
    pins.toggle("subclass", "a");
    expect(pins.list("subclass")).toEqual(["b", "a"]);
  });

  it("toggles a pin off and reports which way it went", () => {
    const pins = new PinSet();
    expect(pins.toggle("class", "a")).toBe("added");
    expect(pins.toggle("class", "a")).toBe("removed");
    expect(pins.count("class")).toBe(0);
  });

  it("refuses a pin past the cap rather than silently dropping the click", () => {
    const pins = new PinSet();
    for ( let i = 0; i < MAX_PINS; i++ ) expect(pins.toggle("class", `c${i}`)).toBe("added");
    expect(pins.toggle("class", "one-too-many")).toBe("full");
    expect(pins.count("class")).toBe(MAX_PINS);
    // The refusal must not have cost the player a pin they already had.
    expect(pins.has("class", "c0")).toBe(true);
  });

  it("keeps categories apart", () => {
    const pins = new PinSet();
    pins.toggle("class", "a");
    expect(pins.has("species", "a")).toBe(false);
    expect(pins.count("species")).toBe(0);
  });

  it("rejects a category that has no picker", () => {
    const pins = new PinSet();
    expect(pins.toggle("spell", "a")).toBe("invalid");
    expect(pins.count("spell")).toBe(0);
  });

  it("needs two pins before comparing means anything", () => {
    const pins = new PinSet();
    pins.toggle("class", "a");
    expect(pins.canCompare("class")).toBe(false);
    pins.toggle("class", "b");
    expect(pins.canCompare("class")).toBe(true);
  });
});

/* -------------------------------------------- */
/*  Opting a picker in                          */
/* -------------------------------------------- */

describe("pinContext", () => {
  const cards = [{ uuid: "a", name: "A" }, { uuid: "b", name: "B" }];

  it("marks the pinned cards and offers the control", () => {
    const pins = new PinSet();
    pins.toggle("class", "b");
    const ctx = pinContext(pins, "class", cards);
    expect(ctx.cards.map(c => c.pinned)).toEqual([false, true]);
    expect(ctx.compareCategory).toBe("class");
    expect(ctx.compare.canCompare).toBe(false);
  });

  it("is inert without a shell, so a step still renders in a test", () => {
    const ctx = pinContext(undefined, "class", cards);
    expect(ctx.cards).toBe(cards);
    expect(ctx.compareCategory).toBeNull();
    expect(ctx.compare).toBeNull();
  });
});

/* -------------------------------------------- */
/*  The rows                                    */
/* -------------------------------------------- */

describe("compareRows", () => {
  it("leads with the source book — the row that tells two same-named editions apart", () => {
    const rows = compareRows("class", [
      entry({ name: "Fighter", source: "Player's Handbook (2014)" }),
      entry({ name: "Fighter", source: "Player's Handbook (2024)" })
    ]);
    expect(rows[0].key).toBe("source");
    expect(texts(rows[0])).toEqual(["Player's Handbook (2014)", "Player's Handbook (2024)"]);
  });

  it("drops a row no column has anything to say about", () => {
    // Nothing here casts, so there must be no Spellcasting row at all — an all-em-dash row is
    // noise in a grid whose whole job is to show difference.
    const rows = compareRows("class", [entry({ name: "Fighter" }), entry({ name: "Barbarian" })]);
    expect(row(rows, "spellcasting")).toBeUndefined();
  });

  it("keeps a row where only one column is empty — that is the comparison", () => {
    const rows = compareRows("class", [
      entry({ name: "Wizard", system: { spellcasting: { progression: "full", ability: "int" } } }),
      entry({ name: "Fighter" })
    ]);
    expect(texts(row(rows, "spellcasting"))).toEqual(["full (Intelligence)", "—"]);
  });

  it("reconciles a trait the columns count differently into one row", () => {
    // `advancementGroups` puts a choice's count in the *label* ("Skills (2)"), which is right for a
    // detail pane and wrong for a grid: a Fighter and a Ranger would land on two separate rows for
    // the same trait. The count belongs in the value.
    const rows = compareRows("background", [
      entry({ name: "Soldier", tags: [{ label: "Skills (2)", value: "Athletics, Intimidation" }] }),
      entry({ name: "Sage", tags: [{ label: "Skills (3)", value: "Arcana, History, Nature" }] })
    ]);
    const skills = rows.filter(r => r.key.startsWith("trait:"));
    expect(skills).toHaveLength(1);
    expect(skills[0].label).toBe("Skills");
    expect(texts(skills[0])[0]).toContain("Athletics, Intimidation");
  });

  it("joins two advancements granting the same trait into one cell", () => {
    const rows = compareRows("class", [
      entry({ name: "Bard", tags: [{ label: "Skills", value: "Any three" }, { label: "Skills", value: "Performance" }] }),
      entry({ name: "Fighter", tags: [{ label: "Skills", value: "Athletics" }] })
    ]);
    const skills = rows.filter(r => r.key.startsWith("trait:"));
    expect(skills).toHaveLength(1);
    expect(texts(skills[0])[0]).toBe("Any three · Performance");
  });

  it("orders trait rows by first appearance, so the first thing pinned sets the reading order", () => {
    const rows = compareRows("class", [
      entry({ name: "Fighter", tags: [{ label: "Hit Die", value: "d10" }, { label: "Saves", value: "Str, Con" }] }),
      entry({ name: "Wizard", tags: [{ label: "Saves", value: "Int, Wis" }, { label: "Languages", value: "One" }] })
    ]);
    expect(rows.filter(r => r.key.startsWith("trait:")).map(r => r.label))
      .toEqual(["Hit Die", "Saves", "Languages"]);
  });

  it("leaves a column blank for a trait it does not grant", () => {
    const rows = compareRows("class", [
      entry({ name: "Fighter", tags: [{ label: "Armour", value: "All armour, shields" }] }),
      entry({ name: "Wizard", tags: [] })
    ]);
    expect(texts(row(rows, "trait:Armour"))).toEqual(["All armour, shields", "—"]);
  });

  it("reads the subclass and ASI levels off the advancements rather than assuming them", () => {
    // Both move between editions and between classes — 2014 Rogues take an archetype at 3 and get
    // extra ASIs, Fighters at 3 with more still — so nothing here may be hardcoded.
    const rogue = entry({
      name: "Rogue",
      system: {
        advancement: [
          { type: "Subclass", level: 3 },
          { type: "AbilityScoreImprovement", level: 4 },
          { type: "AbilityScoreImprovement", level: 8 },
          { type: "AbilityScoreImprovement", level: 10 }
        ]
      }
    });
    const cleric = entry({
      name: "Cleric",
      system: { advancement: [{ type: "Subclass", level: 1 }, { type: "AbilityScoreImprovement", level: 4 }] }
    });
    const rows = compareRows("class", [rogue, cleric]);
    expect(texts(row(rows, "subclassLevel"))).toEqual(["3", "1"]);
    expect(texts(row(rows, "asiLevels"))).toEqual(["4, 8, 10", "4"]);
  });

  it("reads a species' size off its Size advancement, where dnd5e actually keeps it", () => {
    const rows = compareRows("species", [
      entry({ name: "Human", system: { advancement: [{ type: "Size", configuration: { sizes: ["med"] } }] } }),
      // A species that lets the player choose lists both, which is itself worth seeing.
      entry({ name: "Fairy", system: { advancement: [{ type: "Size", configuration: { sizes: ["sm", "med"] } }] } })
    ]);
    expect(texts(row(rows, "size"))).toEqual(["Medium", "Small / Medium"]);
  });

  it("puts both ability-increase shapes side by side, since that is the point of comparing origins", () => {
    const rows = compareRows("species", [
      // 2014: a fixed grant, nothing to decide.
      entry({ name: "Hill Dwarf", asi: { points: 0, cap: 2, fixed: { con: 2, wis: 1 }, locked: [] } }),
      // 2014 Half-Elf: fixed and a budget at once.
      entry({ name: "Half-Elf", asi: { points: 2, cap: 1, fixed: { cha: 2 }, locked: [] } })
    ]);
    const cells = texts(row(rows, "originAsi"));
    expect(cells[0]).toBe("+2 Constitution, +1 Wisdom");
    expect(cells[1]).toContain("+2 Charisma");
    expect(cells[1]).toContain("·");
  });

  it("carries granted features and spells through as items, not as text", () => {
    const rows = compareRows("subclass", [
      entry({ name: "Champion", features: [{ uuid: "f1", name: "Improved Critical", img: "i.webp", level: 3 }] }),
      entry({ name: "Eldritch Knight", features: [{ uuid: "f2", name: "Weapon Bond", img: "i.webp", level: 3 }],
        spells: [{ uuid: "s1", name: "Shield", img: "i.webp", level: 3 }] })
    ]);
    expect(row(rows, "features").cells[0].items[0].name).toBe("Improved Critical");
    // The column with no spells still gets a cell, and it reads as an absence.
    expect(row(rows, "spells").cells[0].text).toBe("—");
    expect(row(rows, "spells").cells[1].items).toHaveLength(1);
  });

  it("gives a species its headline facts before its proficiencies", () => {
    const rows = compareRows("species", [
      entry({ name: "Elf", system: { typeLabel: "Humanoid", movementLabels: { walk: "Walk 30 ft" } },
        tags: [{ label: "Languages", value: "Common, Elvish" }] }),
      entry({ name: "Dwarf", system: { typeLabel: "Humanoid", movementLabels: { walk: "Walk 25 ft" } },
        tags: [{ label: "Languages", value: "Common, Dwarvish" }] })
    ]);
    const keys = rows.map(r => r.key);
    expect(keys.indexOf("speed")).toBeLessThan(keys.indexOf("trait:Languages"));
    expect(texts(row(rows, "speed"))).toEqual(["Walk 30 ft", "Walk 25 ft"]);
  });

  it("gives a class its trait tags before its progression facts", () => {
    // The reverse of the species case, and deliberate: a class's headline numbers (primary ability,
    // hit die) already arrive as its first two trait tags, so they lead and the rest follows.
    const rows = compareRows("class", [
      entry({ name: "Wizard", tags: [{ label: "Hit Die", value: "d6" }],
        system: { spellcasting: { progression: "full", ability: "int" } } }),
      entry({ name: "Cleric", tags: [{ label: "Hit Die", value: "d8" }],
        system: { spellcasting: { progression: "full", ability: "wis" } } })
    ]);
    const keys = rows.map(r => r.key);
    expect(keys.indexOf("trait:Hit Die")).toBeLessThan(keys.indexOf("spellcasting"));
  });
});
