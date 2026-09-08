import { describe, it, expect, beforeEach, vi } from "vitest";
import { LevelUpDriver } from "../scripts/levelup/manager-driver.mjs";
import { resetRestrictedCache } from "../scripts/data/choice-resolver.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * The inline ASI-or-feat picker replaced a popup onto dnd5e's own CompendiumBrowser
 * (`chooseAsiFeat`) with a grid rendered inside the wizard itself. These tests cover the wiring:
 * the state flips that open/close/peek the grid, and that `asiFeatOptions` actually drives
 * {@link module:data/choice-resolver.findAsiFeats} end to end through a fake compendium pack.
 */

/** A minimal `CompendiumCollection`-shaped fake pack, indexable the way `findAsiFeats` reads it. */
function fakePack(entries) {
  return {
    visible: true,
    collection: "test.feats",
    metadata: { type: "Item", system: "dnd5e" },
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
      { type: "feat", name: "Alert", img: "i1", uuid: "u1", system: { type: {}, prerequisites: {} } },
      {
        type: "feat", name: "Improved Pact Weapon", img: "i2", uuid: "u2",
        system: { type: {}, prerequisites: { items: ["pact-of-the-blade"] } }
      },
      {
        type: "feat", name: "Skill Expert", img: "i3", uuid: "u3",
        system: { type: {}, prerequisites: { level: 8 } }
      },
      // Never offered to an ASI regardless of level — see findAsiFeats.
      { type: "feat", name: "Bountiful Luck", img: "i4", uuid: "u4", system: { type: { subtype: "origin" } } }
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
      { type: "feat", name: "Alert", img: "i1", uuid: "u1", system: { type: {}, prerequisites: {} } },
      { type: "feat", name: "Tough", img: "i2", uuid: "u2", system: { type: {}, prerequisites: {} } },
      // Repeatable feats are never excluded by a prior pick — see #takenFeatNames.
      {
        type: "feat", name: "Skilled", img: "i3", uuid: "u3",
        system: { type: {}, prerequisites: { repeatable: true } }
      }
    ])];

    const driver = makeDriver({ level: 4 });
    const record = asiRecord([], [fakeFeatItem("Alert"), fakeFeatItem("Skilled", { repeatable: true })]);
    const { options } = await driver.asiFeatOptions(record);

    expect(options.map(o => o.name).sort()).toEqual(["Skilled", "Tough"]);
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
