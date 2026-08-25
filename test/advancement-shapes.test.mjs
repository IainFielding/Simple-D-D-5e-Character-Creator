import { describe, it, expect } from "vitest";
import {
  entryCount, entryValues, addedEntries, appliesToClass, unresolvedAdvancements
} from "../scripts/data/advancement-util.mjs";

/**
 * dnd5e records what an advancement resolved to in more than one shape, and reading the wrong one
 * fails *quietly* — a `.length` on a Set reads `undefined` and counts as zero, and a level-keyed
 * map read flat yields level numbers where item ids were expected. Both report a genuinely-made
 * choice as unmade, so these readers exist to keep every caller honest about the shape.
 *
 * The shapes here are the real ones from dnd5e 5.3.3's own data models, not invented:
 *   - `Trait.value.chosen`      SetField          -> a Set when prepared, an Array in raw source
 *   - `ItemGrant.value.added`   flat              -> {itemId: uuid}
 *   - `ItemChoice.value.added`  Mapping(Mapping)  -> {level: {itemId: uuid}}, flagged `multiLevel`
 */
describe("entryCount / entryValues tolerate every shape dnd5e uses", () => {
  it("counts a Set, as a prepared Trait's chosen arrives", () => {
    expect(entryCount(new Set(["skills:acr", "skills:ath"]))).toBe(2);
  });

  it("counts an Array, as raw toObject() source data arrives", () => {
    expect(entryCount(["skills:acr", "skills:ath"])).toBe(2);
  });

  it("counts a plain object, as a MappingField arrives", () => {
    expect(entryCount({ a: "x", b: "y" })).toBe(2);
  });

  it("counts a Map", () => {
    expect(entryCount(new Map([["a", "x"]]))).toBe(1);
  });

  // The whole point: the naive `.length` that reads undefined here is what misreported a real pick.
  it("treats absent values as empty rather than throwing", () => {
    for ( const empty of [null, undefined, 0, ""] ) expect(entryCount(empty)).toBe(0);
  });

  it("returns values uniformly across the shapes", () => {
    expect(entryValues(new Set(["a"]))).toEqual(["a"]);
    expect(entryValues(["a"])).toEqual(["a"]);
    expect(entryValues({ k: "a" })).toEqual(["a"]);
    expect(entryValues(new Map([["k", "a"]]))).toEqual(["a"]);
    expect(entryValues(null)).toEqual([]);
  });
});

/**
 * `multiLevel` is dnd5e's own metadata flag for "this value is keyed by level", which is why it is
 * read here rather than a hardcoded list of type names.
 */
describe("addedEntries flattens both value.added shapes", () => {
  const grant = added => ({ constructor: { metadata: { multiLevel: false } }, value: { added } });
  const choice = added => ({ constructor: { metadata: { multiLevel: true } }, value: { added } });

  it("reads an ItemGrant's flat map straight through", () => {
    expect(addedEntries(grant({ itemA: "uuidA" }))).toEqual({ itemA: "uuidA" });
  });

  it("reads one level out of an ItemChoice's level-keyed map", () => {
    const adv = choice({ 2: { itemA: "uuidA" }, 10: { itemB: "uuidB" } });
    expect(addedEntries(adv, 2)).toEqual({ itemA: "uuidA" });
    expect(addedEntries(adv, 10)).toEqual({ itemB: "uuidB" });
  });

  it("merges every level when none is named", () => {
    const adv = choice({ 2: { itemA: "uuidA" }, 10: { itemB: "uuidB" } });
    expect(addedEntries(adv)).toEqual({ itemA: "uuidA", itemB: "uuidB" });
  });

  it("returns empty for an unresolved advancement, and never the caller's own object", () => {
    expect(addedEntries(grant(undefined))).toEqual({});
    const source = { itemA: "uuidA" };
    const copy = addedEntries(grant(source));
    copy.itemB = "uuidB";
    expect(source).toEqual({ itemA: "uuidA" });
  });

  // The bug this fixes: reading a level-keyed map flat yields "2"/"10", so every items.get() misses.
  it("never yields level numbers where item ids are expected", () => {
    const adv = choice({ 2: { itemA: "uuidA" } });
    expect(Object.keys(addedEntries(adv))).toEqual(["itemA"]);
  });
});

/**
 * A class carries two versions of the same grant — one for when it is the character's original
 * class, one for when it is a multiclass entry — which is how dnd5e models reduced multiclass
 * proficiencies. Its own AdvancementManager filters by this, so an inapplicable grant never gets a
 * step and its value stays empty forever.
 */
describe("appliesToClass resolves the primary/secondary restriction", () => {
  it("keeps an unrestricted advancement whatever the item", () => {
    expect(appliesToClass({}, { isOriginalClass: false })).toBe(true);
  });

  it("keeps a primary grant on the original class, drops it on a multiclass entry", () => {
    const adv = { classRestriction: "primary" };
    expect(appliesToClass(adv, { isOriginalClass: true })).toBe(true);
    expect(appliesToClass(adv, { isOriginalClass: false })).toBe(false);
  });

  it("drops a secondary grant on the original class, keeps it on a multiclass entry", () => {
    const adv = { classRestriction: "secondary" };
    expect(appliesToClass(adv, { isOriginalClass: true })).toBe(false);
    expect(appliesToClass(adv, { isOriginalClass: false })).toBe(true);
  });

  /**
   * The deliberate divergence from dnd5e's own getter. A compendium item is not embedded in an
   * actor, so `isOriginalClass` is `null` and dnd5e resolves that as matching *both* restrictions.
   * Creation reads it as "original class" instead — otherwise a Bard would be offered its 3-skill
   * original-class grant and its 1-skill multiclass grant at the same time.
   */
  it("treats an item with no original-class answer as the original class", () => {
    for ( const item of [{}, { isOriginalClass: null }, undefined] ) {
      expect(appliesToClass({ classRestriction: "primary" }, item)).toBe(true);
      expect(appliesToClass({ classRestriction: "secondary" }, item)).toBe(false);
    }
  });
});

/**
 * dnd5e never blocks its own Next button on an unmade Trait/ItemChoice/ASI/Subclass pick, so an
 * item can land on a character with a real choice silently empty. This is what tells us.
 */
describe("unresolvedAdvancements finds genuinely unanswered choices", () => {
  const item = (...advancement) => ({ system: { advancement } });
  const titles = (doc, level) => unresolvedAdvancements(doc, level).map(a => a.title);

  it("flags a Trait choice with fewer picks than required", () => {
    const skills = chosen => item({
      _id: "a", type: "Trait", level: 1, title: "Skill Proficiencies",
      configuration: { choices: [{ count: 2, pool: ["skills:acr", "skills:ath"] }] },
      value: { chosen }
    });
    expect(titles(skills(new Set()))).toEqual(["Skill Proficiencies"]);
    expect(titles(skills(new Set(["skills:acr"])))).toEqual(["Skill Proficiencies"]);
    expect(titles(skills(new Set(["skills:acr", "skills:ath"])))).toEqual([]);
  });

  it("ignores a Trait that only grants, never asks", () => {
    expect(titles(item({
      _id: "a", type: "Trait", level: 1, title: "Saving Throws",
      configuration: { grants: ["saves:str"], choices: [] }, value: { chosen: new Set() }
    }))).toEqual([]);
  });

  /**
   * The ASI trap: dnd5e sets `value.type` eagerly, before any real choice, so an untouched ASI is
   * already non-empty. Clicking straight through one left ability scores untouched yet looked
   * resolved to any check that only asked whether the value existed.
   */
  it("flags an ASI carrying only its eagerly-set type", () => {
    const asi = value => item({
      _id: "a", type: "AbilityScoreImprovement", level: 4, title: "Ability Score Improvement",
      configuration: { points: 2 }, value
    });
    expect(titles(asi({ type: "asi" }))).toEqual(["Ability Score Improvement"]);
    expect(titles(asi({ type: "asi", assignments: { str: 2 } }))).toEqual([]);
    expect(titles(asi({ type: "feat", feat: { someId: "Compendium.x.y.Item.z" } }))).toEqual([]);
  });

  // A background's +2/+1 with no spendable points is applied outright — there is nothing to answer.
  it("ignores an ASI with no points to spend", () => {
    expect(titles(item({
      _id: "a", type: "AbilityScoreImprovement", level: 1, title: "Ability Scores",
      configuration: { points: 0, fixed: { str: 2 } }, value: { type: "asi" }
    }))).toEqual([]);
  });

  it("flags an ItemChoice only for tiers the character has reached", () => {
    const metamagic = added => item({
      _id: "a", type: "ItemChoice", title: "Metamagic",
      constructor: { metadata: { multiLevel: true } },
      configuration: { choices: { 2: { count: 2 }, 10: { count: 1 } } },
      value: { added }
    });
    // At level 2 only the first tier is owed; the level-10 tier is not yet due.
    expect(titles(metamagic({ 2: { i1: "u1", i2: "u2" } }), 2)).toEqual([]);
    expect(titles(metamagic({ 2: { i1: "u1" } }), 2)).toEqual(["Metamagic"]);
    // At level 10 both tiers are owed, so two picks no longer satisfy three.
    expect(titles(metamagic({ 2: { i1: "u1", i2: "u2" } }), 10)).toEqual(["Metamagic"]);
  });

  it("flags an unchosen subclass", () => {
    const subclass = value => item({ _id: "a", type: "Subclass", level: 3, title: "Subclass", value });
    expect(titles(subclass({}), 3)).toEqual(["Subclass"]);
    expect(titles(subclass({ uuid: "Compendium.x.y.Item.z" }), 3)).toEqual([]);
  });

  it("ignores advancements above the character's level", () => {
    expect(titles(item({
      _id: "a", type: "Subclass", level: 3, title: "Subclass", value: {}
    }), 2)).toEqual([]);
  });

  // Without this filter an original-class Bard reports its never-shown multiclass grants forever.
  it("ignores a grant restricted to the class the character is not running", () => {
    const bard = {
      isOriginalClass: true,
      system: { advancement: [{
        _id: "a", type: "Trait", level: 1, title: "Skill Proficiencies (Multiclass)",
        classRestriction: "secondary",
        configuration: { choices: [{ count: 1, pool: ["skills:acr"] }] },
        value: { chosen: new Set() }
      }] }
    };
    expect(unresolvedAdvancements(bard, 1)).toEqual([]);
  });
});
