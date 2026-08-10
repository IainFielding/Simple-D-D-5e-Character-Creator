import { describe, it, expect } from "vitest";
import { CreationChoiceProvider } from "../scripts/build/creation-advancement.mjs";

/**
 * `CreationChoiceProvider` answers the driver's decisions from the creator's recorded state. Each
 * decision record only carries its advancement (`{ id, configuration }`); the provider joins that id
 * back to the resolver requirements to find the source/selKey under which the player's picks live.
 */
describe("CreationChoiceProvider", () => {
  const resolved = {
    sources: [
      { key: "class", requirements: [
        // One Trait advancement, two choice groups (advId#0 / advId#1).
        { type: "Trait", advId: "T1", selKey: "T1#0", source: "class" },
        { type: "Trait", advId: "T1", selKey: "T1#1", source: "class" },
        { type: "ItemChoice", advId: "IC1", selKey: "IC1", source: "class" },
        { type: "SpellAbility", advId: "SA1", selKey: "SA1", source: "class" },
        // A 2014-rules class (Cleric, Sorcerer, Warlock) unlocks its subclass at level 1, so the
        // pick is a creation decision rather than a level-up one.
        { type: "Subclass", advId: "SC1", selKey: "SC1", source: "class" }
      ] },
      { key: "species", requirements: [
        { type: "Size", advId: "SZ1", selKey: "SZ1", source: "species" }
      ] }
    ]
  };
  const state = {
    advChoices: {
      class: {
        "T1#0": ["skills:arc"],
        "T1#1": ["skills:his"],
        IC1: ["uuid-A", { uuid: "uuid-B" }],   // picks may be bare strings or {uuid} objects
        SA1: ["int"],
        SC1: ["Compendium.dnd5e.subclasses.Item.lifeDomain00000"]
      },
      species: { SZ1: ["sm"] },
      background: {}
    },
    // Whichever origin carries the increase is an edition question — 2024 puts it on the
    // background, 2014 on the species — so the provider matches both by advancement id.
    originAsi: { background: { id: "ASI-BG" }, species: { id: "ASI-SP" } },
    originDeltas: src => (src === "background" ? { int: 2, con: 1 } : { cha: 2, dex: 1 })
  };
  const provider = new CreationChoiceProvider(resolved, state);
  const rec = (id, configuration = {}) => ({ advancement: { id, configuration } });

  it("takes max hit points at level 1", () => {
    expect(provider.hp()).toBe("max");
  });

  // The advancement's own `configuration.grants` are deliberately absent: the driver seeds them at
  // ingest the way the native manager does, so the provider only answers the player's picks.
  it("collects trait picks across every choice group, without re-adding the grants", () => {
    const keys = provider.traitKeys(rec("T1", { grants: ["skills:per"] }));
    expect(keys).toEqual(["skills:arc", "skills:his"]);
  });

  it("normalises ItemChoice picks (string or {uuid}) to uuid strings", () => {
    expect(provider.choiceUuids(rec("IC1"))).toEqual(["uuid-A", "uuid-B"]);
  });

  it("returns the chosen size and spell-ability", () => {
    expect(provider.size(rec("SZ1"))).toBe("sm");
    expect(provider.grantAbility(rec("SA1"))).toBe("int");
  });

  it("defers only spell-type ItemChoices", () => {
    expect(provider.defer(rec("X", { type: "spell" }))).toBe(true);
    expect(provider.defer(rec("X", { type: "feature" }))).toBe(false);
    expect(provider.defer(rec("X"))).toBe(false);
  });

  it("applies each origin's ability increase only to that origin's ASI advancement", () => {
    expect(provider.asi(rec("ASI-BG"))).toEqual({ int: 2, con: 1 });
    // A 2014 species (Half-Elf: fixed +2 CHA plus a free point) goes through the same seam.
    expect(provider.asi(rec("ASI-SP"))).toEqual({ cha: 2, dex: 1 });
    expect(provider.asi(rec("some-other-asi"))).toBeNull();
  });

  // Under the 2024 rules every class takes its subclass at level 3, so this always returned null and
  // creation never handled it. The 2014 Cleric, Sorcerer and Warlock choose at level 1, and that
  // assumption built them with no subclass at all — and none of the domain spells, armour
  // proficiency or cantrips it carries.
  it("returns the chosen subclass for a class that unlocks one at level 1", () => {
    expect(provider.subclass(rec("SC1"))).toBe("Compendium.dnd5e.subclasses.Item.lifeDomain00000");
  });

  it("returns null when the class raises no subclass decision at level 1", () => {
    expect(provider.subclass(rec("no-subclass-advancement"))).toBeNull();
  });

  it("returns empty for an advancement with no recorded requirement", () => {
    expect(provider.traitKeys(rec("unknown"))).toEqual([]);
    expect(provider.choiceUuids(rec("unknown"))).toEqual([]);
    expect(provider.size(rec("unknown"))).toBeNull();
    expect(provider.grantAbility(rec("unknown"))).toBeNull();
  });
});
