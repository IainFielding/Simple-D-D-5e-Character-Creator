import { beforeEach, describe, expect, it } from "vitest";
import { buildSpellFromEntry, spellFilterOptions } from "../scripts/data/spell-source.mjs";
import { compareRows, COMPARE_CATEGORIES } from "../scripts/app/compare.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * The spell browser's two halves: what a *card* knows about a spell (built from a compendium index
 * entry, because a class list is hundreds of them and loading hundreds of documents is not on), and
 * what a *comparison column* knows (built from a real document, because at most four are ever
 * pinned and the system has already computed every label we want).
 *
 * That split is the whole design, so both sides are covered here rather than in separate files.
 */

/** A spell index entry, shaped as dnd5e's Compendium Browser returns one for SPELL_INDEX_FIELDS. */
function entry({ name = "Fireball", level = 3, school = "evo", properties = ["vocal", "somatic", "material"],
  activation = { type: "action", value: null }, range = { units: "ft", value: 150 } } = {}) {
  return {
    _id: name.toLowerCase(), uuid: `Compendium.x.spells.Item.${name.toLowerCase()}`, name, img: "i.webp",
    system: { level, school, identifier: name.toLowerCase(), properties, activation, range }
  };
}

beforeEach(() => installFoundryShims());

/* -------------------------------------------- */

describe("buildSpellFromEntry", () => {
  it("formats a flat casting time from the activation type alone", () => {
    const card = buildSpellFromEntry(entry());
    expect(card.castingTimeKey).toBe("action");
    expect(card.castingTime).toBe("Action");
  });

  it("counts a scalar casting time, which is what separates a 1-minute ritual from a 10-minute one", () => {
    const card = buildSpellFromEntry(entry({ activation: { type: "minute", value: 10 } }));
    expect(card.castingTimeKey).toBe("minute");
    expect(card.castingTime).toBe("10 Minutes");
  });

  it("formats a measured range, and keeps the unit as the filter key", () => {
    const card = buildSpellFromEntry(entry());
    expect(card.rangeKey).toBe("ft");
    expect(card.range).toBe("150 ft");
  });

  it("reads an absent range as Self, the way dnd5e's own RangeField does", () => {
    const card = buildSpellFromEntry(entry({ range: {} }));
    expect(card.rangeKey).toBe("self");
    expect(card.range).toBe("Self");
  });

  it("labels a non-measured range from its unit rather than a distance", () => {
    const card = buildSpellFromEntry(entry({ range: { units: "touch" } }));
    expect(card.rangeKey).toBe("touch");
    expect(card.range).toBe("Touch");
  });

  it("carries the raw property keys for the filter to match, alongside the display components", () => {
    const card = buildSpellFromEntry(entry({ properties: ["vocal", "somatic", "ritual"] }));
    expect(card.propertyKeys).toBe("vocal somatic ritual");
    expect(card.components).toBe("V, S");
    expect(card.isRitual).toBe(true);
  });

  it("degrades to empty strings for an entry with no activation or range indexed at all", () => {
    const bare = { _id: "x", uuid: "u", name: "Mystery", system: { level: 1 } };
    const card = buildSpellFromEntry(bare);
    expect(card.castingTimeKey).toBe("");
    expect(card.castingTime).toBe("");
    expect(card.propertyKeys).toBe("");
  });
});

/* -------------------------------------------- */

describe("spellFilterOptions", () => {
  /** Stands in for the module's `t()`: echoes the key, with the interpolated property prefixed. */
  const t = (key, data) => (data?.property ? `${data.property}|${key}` : key);

  const cards = () => [
    buildSpellFromEntry(entry()),
    buildSpellFromEntry(entry({
      name: "Detect Magic", level: 1, school: "div",
      properties: ["vocal", "somatic", "concentration", "ritual"],
      activation: { type: "action" }, range: { units: "self" }
    })),
    buildSpellFromEntry(entry({
      name: "Alarm", level: 1, school: "abj", properties: ["vocal", "somatic", "material", "ritual"],
      activation: { type: "minute", value: 1 }, range: { units: "ft", value: 30 }
    }))
  ];

  it("offers each spell level once, in order, and skips cantrips", () => {
    const list = [...cards(), buildSpellFromEntry(entry({ name: "Light", level: 0 }))];
    expect(spellFilterOptions(list, t).levelOptions.map(o => o.value)).toEqual([1, 3]);
  });

  it("labels a casting-time option from its key, not from the first spell that carried it", () => {
    // Both "1 Minute" and "10 Minutes" filter as `minute`; the option has to say what the key means.
    const options = spellFilterOptions(cards(), t).castingOptions;
    expect(options).toEqual([{ value: "action", label: "Action" }, { value: "minute", label: "Minutes" }]);
  });

  it("labels range options by unit, so one option covers every distance in it", () => {
    const options = spellFilterOptions(cards(), t).rangeOptions;
    expect(options).toEqual([{ value: "ft", label: "Feet" }, { value: "self", label: "Self" }]);
  });

  it("offers every property twice - once as 'only', once as 'without'", () => {
    const groups = spellFilterOptions(cards(), t).propertyGroups;
    expect(groups.map(g => g.label)).toEqual([
      "levelup.step.spells.filterPropGroupOnly", "levelup.step.spells.filterPropGroupWithout"
    ]);
    expect(groups[0].options.map(o => o.value))
      .toEqual(expect.arrayContaining(["concentration:yes", "ritual:yes", "vocal:yes"]));
    expect(groups[1].options.map(o => o.value)).toContain("ritual:no");
  });

  it("leaves out a property nothing in the list carries - it would filter to all or nothing", () => {
    const noRituals = [buildSpellFromEntry(entry({ properties: ["vocal"] }))];
    const values = spellFilterOptions(noRituals, t).propertyGroups.flatMap(g => g.options.map(o => o.value));
    expect(values).toEqual(["vocal:yes", "vocal:no"]);
  });

  it("renders no property control at all for a list with no properties on it", () => {
    const bare = [buildSpellFromEntry(entry({ properties: [] }))];
    expect(spellFilterOptions(bare, t).propertyGroups).toEqual([]);
  });
});

/* -------------------------------------------- */

/**
 * Spell comparison columns. Unlike every other compare category these read the *document's* own
 * prepared labels rather than anything the SourceIndex flattened, so the entries below carry the
 * `labels` and `system.activities` shapes dnd5e produces.
 */
describe("compareRows for spells", () => {
  function doc({ name = "Fireball", labels = {}, activities = [], source = { label: "PHB pg. 241" } } = {}) {
    return {
      uuid: `u:${name}`,
      doc: {
        name,
        system: {
          level: 3, school: "evo", properties: new Set(["vocal", "somatic", "material"]), source, activities
        },
        labels: {
          level: "3rd Level", school: "Evocation", activation: "Action", range: "150 ft",
          duration: "Instantaneous", components: { full: "V, S, M (a tiny ball of bat guano)", tags: [] },
          ...labels
        }
      }
    };
  }
  const rowFor = (rows, key) => rows.find(r => r.key === key);

  it("is a comparable category", () => {
    expect(COMPARE_CATEGORIES.has("spell")).toBe(true);
  });

  it("reads level, casting time and range off the document's own labels", () => {
    const rows = compareRows("spell", [doc(), doc({ name: "Ice Knife", labels: { range: "60 ft" } })]);
    expect(rowFor(rows, "spellLevel").cells.map(c => c.text)).toEqual(["3rd Level", "3rd Level"]);
    expect(rowFor(rows, "castingTime").cells.map(c => c.text)).toEqual(["Action", "Action"]);
    expect(rowFor(rows, "spellRange").cells.map(c => c.text)).toEqual(["150 ft", "60 ft"]);
  });

  it("prefers the concentration-aware duration label when the system computed one", () => {
    const rows = compareRows("spell", [
      doc({ labels: { concentrationDuration: "Concentration, up to 1 minute" } }),
      doc({ name: "Ice Knife" })
    ]);
    expect(rowFor(rows, "duration").cells.map(c => c.text))
      .toEqual(["Concentration, up to 1 minute", "Instantaneous"]);
  });

  it("names the book each spell came from, the row that tells two editions apart", () => {
    const rows = compareRows("spell", [doc(), doc({ name: "Fireball ", source: { label: "SRD 5.1" } })]);
    expect(rowFor(rows, "source").cells.map(c => c.text)).toEqual(["PHB pg. 241", "SRD 5.1"]);
  });

  it("joins every damage an activity rolls rather than reporting only the first", () => {
    const rows = compareRows("spell", [
      doc({ activities: [{ labels: { damages: [{ label: "8d6 Fire" }] } }] }),
      doc({ name: "Ice Knife", activities: [
        { labels: { damages: [{ label: "1d10 Piercing" }] } },
        { labels: { damages: [{ label: "2d6 Cold" }] } }
      ] })
    ]);
    expect(rowFor(rows, "damage").cells.map(c => c.text)).toEqual(["8d6 Fire", "1d10 Piercing + 2d6 Cold"]);
  });

  it("reports the saving throw from the save activities, and an em-dash where there is none", () => {
    const rows = compareRows("spell", [
      doc({ activities: [{ save: { ability: ["dex"] } }] }),
      doc({ name: "Magic Missile" })
    ]);
    expect(rowFor(rows, "save").cells.map(c => c.text)).toEqual(["Dexterity", "—"]);
  });

  it("drops the properties row when the only properties are the components row's own", () => {
    const rows = compareRows("spell", [
      doc({ labels: { components: { full: "V, S", tags: [] } } }),
      doc({ name: "Detect Magic", labels: { components: { full: "V, S", tags: [] } } })
    ]);
    expect(rowFor(rows, "properties")).toBeUndefined();
  });

  it("shows a spell's tags when the system did prepare them", () => {
    const rows = compareRows("spell", [
      doc({ labels: { components: { full: "V, S", tags: ["Concentration", "Ritual"] } } }),
      doc({ name: "Fireball" })
    ]);
    expect(rowFor(rows, "properties").cells[0].text).toBe("Concentration, Ritual");
  });

  it("omits the granted-features and granted-spells rows a spell can never fill", () => {
    const rows = compareRows("spell", [doc(), doc({ name: "Ice Knife" })]);
    expect(rowFor(rows, "features")).toBeUndefined();
    expect(rowFor(rows, "spells")).toBeUndefined();
  });
});
