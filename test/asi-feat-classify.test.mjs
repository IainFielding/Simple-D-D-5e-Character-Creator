import { describe, expect, it } from "vitest";
import { classifyAsiFeats } from "../scripts/data/choice-resolver.mjs";

/**
 * `classifyAsiFeats` is the pure half of the ASI-or-feat picker: {@link findAsiFeats} scans the
 * enabled compendiums (needs a live Foundry, so it's exercised by hand like `findRestrictedItems`),
 * and this takes that flat pool and splits it into what one specific build can pick right now versus
 * what's locked and why — the level gate and the item-prerequisite gate the old native-browser popup
 * couldn't express at all.
 */

const entry = (overrides = {}) => ({
  uuid: "Compendium.dnd5e.feats.abc", name: "Alert", img: "icons/alert.svg",
  prereqLevel: 0, prereqItems: [], ...overrides
});

describe("classifyAsiFeats", () => {

  it("puts an unrestricted feat in the pickable options, not recommended", () => {
    const { options, lockedOptions, groups } = classifyAsiFeats([entry()], 4, new Set());
    expect(options).toEqual([{
      uuid: entry().uuid, name: "Alert", img: "icons/alert.svg", abilities: [], recommended: false
    }]);
    expect(lockedOptions).toEqual([]);
    expect(groups).toBeNull();
  });

  it("carries each feat's ability increases onto both lists, for the picker's filter", () => {
    // The "increases X" dropdown reads this off the classified options, so a half-feat has to keep
    // its abilities whether it ends up pickable or shelved — a Strength filter should still find a
    // Strength half-feat sitting in "coming later".
    const { options, lockedOptions } = classifyAsiFeats([
      entry({ uuid: "u1", name: "Slasher", abilities: ["str", "dex"] }),
      entry({ uuid: "u2", name: "Spellfire Adept", abilities: ["cha"], prereqItems: ["spellfire-spark"] })
    ], 4, new Set());

    expect(options.map(o => o.abilities)).toEqual([["str", "dex"]]);
    expect(lockedOptions.map(o => o.abilities)).toEqual([["cha"]]);
  });

  it("locks a feat above the character's level, and never hides it outright", () => {
    const { options, lockedOptions } = classifyAsiFeats([entry({ prereqLevel: 8 })], 4, new Set());
    expect(options).toEqual([]);
    expect(lockedOptions).toHaveLength(1);
    expect(lockedOptions[0].lockReason).toContain("lockedLevel");
    expect(lockedOptions[0].lockReason).toContain("\"level\":8");
  });

  it("locks a feat whose item prerequisite the build doesn't satisfy", () => {
    const { options, lockedOptions } = classifyAsiFeats(
      [entry({ prereqItems: ["thirsting-blade"] })], 4, new Set()
    );
    expect(options).toEqual([]);
    expect(lockedOptions).toHaveLength(1);
    expect(lockedOptions[0].lockReason).toContain("lockedPrereq");
  });

  it("unlocks a feat once the build owns its item prerequisite, and recommends it", () => {
    const owned = new Set(["pact-of-the-blade"]);
    const entries = [
      entry({ uuid: "u1", name: "Improved Pact Weapon", prereqItems: ["pact-of-the-blade"] }),
      entry({ uuid: "u2", name: "Alert" })
    ];
    const { options, groups, lockedOptions } = classifyAsiFeats(entries, 4, owned);
    expect(lockedOptions).toEqual([]);
    expect(options.find(o => o.uuid === "u1").recommended).toBe(true);
    expect(options.find(o => o.uuid === "u2").recommended).toBe(false);
    expect(groups).not.toBeNull();
    expect(groups[0].options.map(o => o.uuid)).toEqual(["u1"]);
    expect(groups[1].options.map(o => o.uuid)).toEqual(["u2"]);
  });

  it("clears the recommended flag when every pickable option shares the prerequisite", () => {
    // Mirrors the fighting-style case documented on groupRecommended: a prerequisite every option
    // shares isn't a comparative signal, so nothing should be flagged and the grid stays ungrouped.
    const owned = new Set(["fighting-style"]);
    const entries = [
      entry({ uuid: "u1", name: "Fell Handed", prereqItems: ["fighting-style"] }),
      entry({ uuid: "u2", name: "Piercer", prereqItems: ["fighting-style"] })
    ];
    const { options, groups } = classifyAsiFeats(entries, 4, owned);
    expect(options.every(o => o.recommended === false)).toBe(true);
    expect(groups).toBeNull();
  });

  it("drops a feat the build already holds instead of recommending or offering it again", () => {
    // The build already has "Alert" from an earlier ASI; a second copy is never a legal pick
    // (dnd5e's own validatePrerequisites would reject it), so it must not appear at all — not as a
    // plain option, not as a locked one, and never flagged Recommended.
    const owned = new Set(["alert"]);
    const entries = [
      entry({ uuid: "u1", name: "Alert", prereqItems: ["alert"] }),
      entry({ uuid: "u2", name: "Tough" })
    ];
    const taken = new Set(["alert"]);
    const { options, lockedOptions, groups } = classifyAsiFeats(entries, 4, owned, taken);
    expect(options.map(o => o.uuid)).toEqual(["u2"]);
    expect(lockedOptions).toEqual([]);
    expect(groups).toBeNull();
  });

  it("leaves a repeatable feat's already-taken copies out of the drop set", () => {
    // classifyAsiFeats itself doesn't know "repeatable" — that filtering happens before taken
    // names ever reach it (see LevelUpDriver#takenFeatNames), so an empty taken set is the no-op
    // baseline a repeatable feat like "Skilled" would produce.
    const entries = [entry({ uuid: "u1", name: "Skilled" })];
    const { options } = classifyAsiFeats(entries, 4, new Set(), new Set());
    expect(options.map(o => o.uuid)).toEqual(["u1"]);
  });

  it("sorts both the pickable and locked lists alphabetically", () => {
    const entries = [
      entry({ uuid: "u1", name: "Ziplining" }),
      entry({ uuid: "u2", name: "Alert" }),
      entry({ uuid: "u3", name: "Zealous", prereqLevel: 8 }),
      entry({ uuid: "u4", name: "Bountiful", prereqLevel: 8 })
    ];
    const { options, lockedOptions } = classifyAsiFeats(entries, 4, new Set());
    expect(options.map(o => o.name)).toEqual(["Alert", "Ziplining"]);
    expect(lockedOptions.map(o => o.name)).toEqual(["Bountiful", "Zealous"]);
  });
});
