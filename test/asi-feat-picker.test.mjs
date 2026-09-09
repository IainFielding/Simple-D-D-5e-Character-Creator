import { describe, it, expect, beforeEach, vi } from "vitest";
import { LevelUpDriver } from "../scripts/levelup/manager-driver.mjs";
import { resetRestrictedCache } from "../scripts/data/choice-resolver.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import { asiStep } from "../scripts/levelup/steps/asi-step.mjs";

/**
 * The inline ASI-or-feat picker replaced a popup onto dnd5e's own CompendiumBrowser
 * (`chooseAsiFeat`) with a grid rendered inside the wizard itself. These tests cover the wiring:
 * the state flips that open/close/peek the grid, and that `asiFeatOptions` actually drives
 * {@link module:data/choice-resolver.findAsiFeats} end to end through a fake compendium pack.
 */

/**
 * A minimal `CompendiumCollection`-shaped fake pack, indexable the way `findAsiFeats` reads it.
 * `packageName`/`packageType` matter to the duplicate tie-break — see the cross-pack test below.
 */
function fakePack(entries, { packageName = "test", packageType = "module" } = {}) {
  return {
    visible: true,
    collection: `${packageName}.feats`,
    metadata: { type: "Item", system: "dnd5e", packageName, packageType },
    documentName: "Item",
    async getIndex() { return entries; }
  };
}

/**
 * A driver built through the real constructor (not the `Object.create(prototype)` shortcut other
 * driver tests use) — `asiFeatOptions` reaches a true private method (`#takenFeatNames`), and a
 * private method's brand check only recognises an object the constructor actually ran on.
 */
function makeDriver({ level = 4 } = {}) {
  return new LevelUpDriver({ actor: {}, clone: { system: { details: { level } } }, steps: [] });
}

const asiRecord = (owned = [], items = []) => ({
  level: 4,
  advancement: { actor: { identifiedItems: new Map(owned.map(id => [id, true])), items } }
});

/** A minimal `Item5e`-shaped fake feat already granted to the clone. */
const fakeFeatItem = (name, { repeatable = false } = {}) => ({
  type: "feat", name, system: { prerequisites: { repeatable } }
});

describe("the inline ASI feat picker", () => {
  beforeEach(() => {
    installFoundryShims();
    game.packs = [];
    resetRestrictedCache();
  });

  it("opens the picker and resets the peek toggle", () => {
    const driver = makeDriver();
    const record = { pickingFeat: false, showFuture: true };
    driver.openAsiFeatPicker(record);
    expect(record.pickingFeat).toBe(true);
    expect(record.showFuture).toBe(false);
  });

  it("closes the picker without touching anything else", () => {
    const driver = makeDriver();
    const record = { pickingFeat: true, showFuture: true };
    driver.closeAsiFeatPicker(record);
    expect(record.pickingFeat).toBe(false);
    expect(record.showFuture).toBe(true);
  });

  it("toggles the coming-later peek", () => {
    const driver = makeDriver();
    const record = { showFuture: false };
    driver.toggleAsiFeatPeek(record);
    expect(record.showFuture).toBe(true);
    driver.toggleAsiFeatPeek(record);
    expect(record.showFuture).toBe(false);
  });

  it("scans the enabled packs and classifies against the build's owned identifiers", async () => {
    game.packs = [fakePack([
      { type: "feat", name: "Alert", img: "i1", uuid: "u1", system: { type: { value: "feat" }, prerequisites: {} } },
      {
        type: "feat", name: "Improved Pact Weapon", img: "i2", uuid: "u2",
        system: { type: { value: "feat" }, prerequisites: { items: ["pact-of-the-blade"] } }
      },
      {
        type: "feat", name: "Skill Expert", img: "i3", uuid: "u3",
        system: { type: { value: "feat" }, prerequisites: { level: 8 } }
      },
      // Never offered to an ASI regardless of level — see findAsiFeats.
      { type: "feat", name: "Bountiful Luck", img: "i4", uuid: "u4", system: { type: { value: "feat", subtype: "origin" } } }
    ])];

    const driver = makeDriver({ level: 4 });
    const record = asiRecord(["pact-of-the-blade"]);
    const { options, lockedOptions } = await driver.asiFeatOptions(record);

    expect(options.map(o => o.name).sort()).toEqual(["Alert", "Improved Pact Weapon"]);
    expect(lockedOptions.map(o => o.name)).toEqual(["Skill Expert"]);
    expect(options.every(o => o.uuid !== "u4")).toBe(true);
  });

  it("drops a feat the clone already holds, so an earlier ASI's pick is never re-offered", async () => {
    game.packs = [fakePack([
      { type: "feat", name: "Alert", img: "i1", uuid: "u1", system: { type: { value: "feat" }, prerequisites: {} } },
      { type: "feat", name: "Tough", img: "i2", uuid: "u2", system: { type: { value: "feat" }, prerequisites: {} } },
      // Repeatable feats are never excluded by a prior pick — see #takenFeatNames.
      {
        type: "feat", name: "Skilled", img: "i3", uuid: "u3",
        system: { type: { value: "feat" }, prerequisites: { repeatable: true } }
      }
    ])];

    const driver = makeDriver({ level: 4 });
    const record = asiRecord([], [fakeFeatItem("Alert"), fakeFeatItem("Skilled", { repeatable: true })]);
    const { options } = await driver.asiFeatOptions(record);

    expect(options.map(o => o.name).sort()).toEqual(["Skilled", "Tough"]);
  });

  it("offers only real feats, not every Item that happens to be of type \"feat\"", async () => {
    // `feat` is the document type of every *feature* in dnd5e, so a pack's feat Items are mostly
    // not feats. Only `system.type.value === "feat"` says otherwise. Before this filter existed a
    // single content module put 300-odd class features into the picker.
    game.packs = [fakePack([
      { type: "feat", name: "Alert", img: "i1", uuid: "u1", system: { type: { value: "feat" }, prerequisites: {} } },
      // A class feature: Tasha's "Additional Wizard Spells", the one that started this.
      { type: "feat", name: "Additional Wizard Spells", img: "i2", uuid: "u2", system: { type: { value: "class" } } },
      // Class features with a subtype of their own — invocations, infusions, maneuvers, runes.
      { type: "feat", name: "Agonizing Blast", img: "i3", uuid: "u3",
        system: { type: { value: "class", subtype: "eldritchInvocation" } } },
      // A species trait, and a lineage option that declares no category at all. A blank category is
      // a feature that never set one, not a permissive "any" — both must stay out.
      { type: "feat", name: "Darkvision", img: "i4", uuid: "u4", system: { type: { value: "race" } } },
      { type: "feat", name: "Elven Lineage", img: "i5", uuid: "u5", system: { type: {} } },
      { type: "feat", name: "Arcane Propulsion Armor", img: "i6", uuid: "u6",
        system: { type: { value: "enchantment", subtype: "artificerInfusion" } } }
    ])];

    const driver = makeDriver({ level: 4 });
    const { options, lockedOptions } = await driver.asiFeatOptions(asiRecord());

    expect(options.map(o => o.name)).toEqual(["Alert"]);
    expect(lockedOptions).toEqual([]);
  });

  it("keeps invocations, fighting styles, infusions and maneuvers out of both lists", async () => {
    // These are class/enchantment features, not feats — an ASI may never take one, so they belong
    // neither in the pickable grid nor in the "coming later" shelf, which promises \"you could have
    // this eventually\". Every shape here is copied from a real installed pack: note that fighting
    // styles exist in *both* categories (the 2024 feat-category ones and the class-feature ones),
    // so the category filter alone does not cover them — the subtype exclusion does the rest.
    game.packs = [fakePack([
      { type: "feat", name: "Agonizing Blast", img: "i", uuid: "u1",
        system: { type: { value: "class", subtype: "eldritchInvocation" } } },
      { type: "feat", name: "Ambush", img: "i", uuid: "u2",
        system: { type: { value: "class", subtype: "maneuver" } } },
      { type: "feat", name: "Arcane Propulsion Armor", img: "i", uuid: "u3",
        system: { type: { value: "enchantment", subtype: "artificerInfusion" } } },
      { type: "feat", name: "Blessed Warrior", img: "i", uuid: "u4",
        system: { type: { value: "class", subtype: "fightingStyle" } } },
      { type: "feat", name: "Archery", img: "i", uuid: "u5",
        system: { type: { value: "feat", subtype: "fightingStyle" }, prerequisites: { items: ["fighting-style"] } } },
      { type: "feat", name: "Alert", img: "i", uuid: "u6",
        system: { type: { value: "feat" }, prerequisites: { level: 4 } } }
    ])];

    const driver = makeDriver({ level: 4 });
    const { options, lockedOptions } = await driver.asiFeatOptions(asiRecord());

    expect(options.map(o => o.name)).toEqual(["Alert"]);
    expect(lockedOptions).toEqual([]);
  });

  it("recommends a feat whose item prerequisite the build satisfies, and shelves one it doesn't", async () => {
    game.packs = [fakePack([
      { type: "feat", name: "Spellfire Adept", img: "i1", uuid: "u1",
        system: { type: { value: "feat" }, prerequisites: { items: ["spellfire-spark"], level: 4 } } },
      { type: "feat", name: "Harper Teamwork", img: "i2", uuid: "u2",
        system: { type: { value: "feat" }, prerequisites: { items: ["harper-agent"], level: 4 } } },
      { type: "feat", name: "Alert", img: "i3", uuid: "u3", system: { type: { value: "feat" }, prerequisites: {} } }
    ])];

    const driver = makeDriver({ level: 4 });
    const { groups, options, lockedOptions } = await driver.asiFeatOptions(asiRecord(["spellfire-spark"]));

    // Held the prerequisite: pickable, flagged, and first in its own panel.
    expect(options.find(o => o.name === "Spellfire Adept")?.recommended).toBe(true);
    expect(groups[0].options.map(o => o.name)).toEqual(["Spellfire Adept"]);
    expect(groups[1].options.map(o => o.name)).toEqual(["Alert"]);
    // Didn't hold it: never offered as a pick.
    expect(options.some(o => o.name === "Harper Teamwork")).toBe(false);
    expect(lockedOptions.map(o => o.name)).toEqual(["Harper Teamwork"]);
  });

  it("keeps the better-ranked copy of a feat two packages both publish, prerequisites and all", async () => {
    // The same feat, republished. The system's SRD copy declares no prerequisite; the book's copy
    // carries the real one. Whichever is indexed first, the book's must win — otherwise the gate
    // and the "Recommended" flag come down to pack ordering. The SRD pack is listed first here
    // precisely so first-wins would fail this.
    const srd = { type: "feat", name: "Spellfire Adept", img: "i1", uuid: "Compendium.dnd5e.feats24.Item.a1",
      system: { type: { value: "feat" }, prerequisites: {} } };
    const book = { type: "feat", name: "Spellfire Adept", img: "i2",
      uuid: "Compendium.dnd-heroes-faerun.options.Item.b1",
      system: { type: { value: "feat" }, prerequisites: { items: ["spellfire-spark"], level: 4 } } };
    game.packs = [
      fakePack([srd], { packageName: "dnd5e", packageType: "system" }),
      fakePack([book], { packageName: "dnd-heroes-faerun", packageType: "module" })
    ];

    const driver = makeDriver({ level: 4 });
    // A build that does NOT hold the prerequisite: the surviving copy must still gate it.
    const { options, lockedOptions } = await driver.asiFeatOptions(asiRecord());

    expect(options).toEqual([]);
    expect(lockedOptions.map(o => o.uuid)).toEqual(["Compendium.dnd-heroes-faerun.options.Item.b1"]);
  });

  it("closes the picker on a successful pick, and leaves it open on a rejected one", async () => {
    const driver = makeDriver();
    driver.applyAsiFeat = vi.fn(async () => true);
    const record = { pickingFeat: true };
    await driver.pickAsiFeat(record, "u1");
    expect(driver.applyAsiFeat).toHaveBeenCalledWith(record, "u1");
    expect(record.pickingFeat).toBe(false);

    driver.applyAsiFeat = vi.fn(async () => false);
    record.pickingFeat = true;
    await driver.pickAsiFeat(record, "u2");
    expect(record.pickingFeat).toBe(true);
  });
});

/**
 * The picker's card size. The ASI *block* declares `density: "form"` — right for the ability
 * steppers it usually holds — but while the feat grid is open that block is a chooser of every
 * feat in the world, which as full 72px hero cards is several screens of scrolling in a column
 * capped at 45vh. So the picker declares a density of its own, from its own option count, exactly
 * as the choices and trait steps do; `creator.css` keys its density tiers off the attribute rather
 * than off `.levelup-block` so the inner declaration wins.
 */
describe("the feat picker's card density", () => {
  beforeEach(() => { installFoundryShims(); game.packs = []; resetRestrictedCache(); });

  /** Drive `sectionsAt` with a stub driver, so only the density decision is under test. */
  async function pickerSection({ options = [], lockedOptions = [] }) {
    const record = { level: 4, pickingFeat: true, featSynth: null };
    const driver = {
      asiState: () => ({ type: "asi", allowFeat: true }),
      asiFeatOptions: async () => ({ groups: null, options, lockedOptions })
    };
    const state = { asiSteps: [record], driver };
    const { sections } = await asiStep.sectionsAt({ state, driver, source: null }, 4);
    return sections[0];
  }

  const feats = n => Array.from({ length: n }, (_, i) => ({ uuid: `u${i}`, name: `Feat ${i}`, img: "i" }));

  it("offers an increases-filter option only for abilities some feat on screen can raise", async () => {
    // Derived from the feats rendered, the way the spell toolbar derives its dropdowns from the rows
    // on screen: offering "Increases Charisma" in a world whose feats never touch it is a control
    // that can only empty the list. Both grids feed it — a Strength half-feat sitting in "coming
    // later" is still a Strength half-feat.
    const section = await pickerSection({
      options: [{ uuid: "u1", name: "Slasher", img: "i", abilities: ["str", "dex"] }],
      lockedOptions: [{ uuid: "u2", name: "Spellfire Adept", img: "i", abilities: ["cha"] }]
    });
    expect(section.abilityOptions.map(o => o.value)).toEqual(["str", "dex", "cha"]);
  });

  it("drops the increases-filter entirely when no feat raises anything", async () => {
    const section = await pickerSection({ options: [{ uuid: "u1", name: "Alert", img: "i", abilities: [] }] });
    expect(section.abilityOptions).toEqual([]);
  });

  it("flattens each feat's abilities to the string the card's data attribute carries", async () => {
    const options = [{ uuid: "u1", name: "Slasher", img: "i", abilities: ["str", "dex"] }];
    await pickerSection({ options });
    expect(options[0].abilityKeys).toBe("str dex");
  });

  it("drops to compact cards once the pool passes the nine-option threshold", async () => {
    expect((await pickerSection({ options: feats(30) })).pickerDensity).toBe("compact");
  });

  it("counts both grids, since one attribute governs the pickable and coming-later lists", async () => {
    const section = await pickerSection({ options: feats(4), lockedOptions: feats(6) });
    expect(section.pickerDensity).toBe("compact");
  });

  it("keeps the full-size cards for a pool small enough to show as them", async () => {
    expect((await pickerSection({ options: feats(3) })).pickerDensity).toBe("standard");
  });
});

/**
 * The sourcebook pill on the ASI block's header, once a feat is chosen.
 *
 * The feat panel shows the feat's own text and never says which book it came from, which with a
 * shelf of content modules enabled is the first thing a table asks. The subclass block already
 * answers it the same way, so this is the level screen's one convention rather than a new one.
 */
describe("the chosen feat's sourcebook pill", () => {
  beforeEach(() => installFoundryShims());

  /** Drive `sectionsAt` with feat records whose details carry the given books. */
  async function blockFor(books) {
    const records = books.map((book, i) => ({ level: 4, featSynth: null, book, uuid: `u${i}` }));
    const driver = {
      asiState: r => (r.book === null
        ? { type: "asi", allowFeat: true, total: 2, cap: 2, available: 0, abilities: [] }
        : { type: "feat", feat: { uuid: r.uuid } }),
      featAbilityRows: () => []
    };
    const source = { detail: async uuid => ({
      name: "Alert", img: "i", enriched: "", source: records.find(r => r.uuid === uuid).book
    }) };
    const state = { asiSteps: records, driver };
    return asiStep.sectionsAt({ state, driver, source }, 4);
  }

  it("names the book the chosen feat came from", async () => {
    expect((await blockFor(["Tasha's Cauldron of Everything"])).blockSource)
      .toBe("Tasha's Cauldron of Everything");
  });

  it("stays silent when the feat declares no book", async () => {
    expect((await blockFor([""])).blockSource).toBeNull();
  });

  it("stays silent rather than misattribute when a level holds two chosen feats", async () => {
    // One pill cannot honestly name two books, and naming the first would be a quiet lie about
    // the second.
    expect((await blockFor(["Player's Handbook", "Tasha's Cauldron of Everything"])).blockSource)
      .toBeNull();
  });

  it("names the one chosen feat's book even when a plain ability increase sits beside it", async () => {
    expect((await blockFor([null, "Player's Handbook"])).blockSource).toBe("Player's Handbook");
  });
});
