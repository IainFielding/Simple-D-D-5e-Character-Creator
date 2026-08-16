import { describe, expect, it } from "vitest";
import { LevelUpDriver } from "../scripts/levelup/manager-driver.mjs";

/**
 * The driver's handling of a `Size` advancement, pinned at the point the decision is actually
 * made — {@link LevelUpDriver#prepare}'s ingest — rather than only at the claim gate.
 *
 * dnd5e 5.3.3 cannot be trusted to say whether a size is a choice. `SizeAdvancement#automaticApplicationValue`
 * (documents/advancement/size.mjs) reads:
 *
 *     if ( this.configuration.sizes > 1 ) return false;
 *     return this.configuration.sizes.first() ?? "med";
 *
 * `sizes` is a `Set` (SetField), so `Set > 1` coerces to `NaN`, `NaN > 1` is always false, and the
 * guard never fires: a species offering **Small or Medium** reports its *first* size as automatic.
 * The native UI escapes this because the interactive path leaves `automaticApplication` at its
 * default of false and never calls the method — but our creation walk sets it true, so the driver
 * is exposed. Trusting that value silently forced every Small-or-Medium species (Human, Halfling,
 * Gnome…) to Small and swallowed the player's pick.
 *
 * The driver therefore tests `configuration.sizes.size` itself before consulting the system. These
 * tests model the broken return value deliberately, so that removing the guard — "simplifying" the
 * branch back onto `getAutomaticApplicationValue()` — fails here rather than in a real world. The
 * original defect was caught by the e2e equivalence harness, not by a unit test; this is that
 * safety net.
 *
 * @see test/levelup-gate.test.mjs for the same distinction at `isStepSupported`.
 */

/** An items store with the handful of Collection methods the walk touches. */
function makeItems(initial = []) {
  const m = new Map(initial.map(i => [i.id, i]));
  return {
    get: id => m.get(id), set: item => m.set(item.id, item), delete: id => m.delete(id),
    map: fn => [...m.values()].map(fn), filter: fn => [...m.values()].filter(fn),
    has: id => m.has(id), [Symbol.iterator]: () => m.values()
  };
}

/**
 * Walk one species `Size` flow and report what the driver did with it.
 *
 * `getAutomaticApplicationValue` returns what dnd5e 5.3.3 actually returns for this configuration —
 * the first configured size, whether or not there is a real choice — so the stub is only a faithful
 * stand-in if the driver never trusts it blindly.
 *
 * @param {string[]} sizes   The sizes the species offers.
 * @returns {Promise<{driver: LevelUpDriver, applied: object[], seeded: number}>}
 */
async function walkSize(sizes) {
  const speciesItem = { id: "raceHuman000000", type: "race", updateSource() {} };
  const applied = [];
  let seeded = 0;
  const advancement = {
    type: "Size",
    item: speciesItem,
    configuration: { sizes: new Set(sizes) },
    async apply(level, data, options = {}) {
      // The seed the driver leaves on an open choice is `apply(level, {}, { initial: true })`;
      // an automatic application is `apply(level, value, { automatic: true })`. Keep them apart.
      if ( options.initial ) seeded++;
      else applied.push({ level, data, options });
    }
  };
  const flow = {
    advancement,
    level: 0,
    getAutomaticApplicationValue: async () => sizes[0]
  };
  const manager = {
    constructor: { flowsForLevel: () => [] },
    actor: { system: { details: { level: 0 } }, items: makeItems() },
    clone: { items: makeItems([speciesItem]), reset() {} },
    steps: [{ type: "forward", level: 0, flow }]
  };
  const driver = new LevelUpDriver(manager);
  await driver.prepare();
  return { driver, applied, seeded };
}

/* -------------------------------------------- */

describe("the driver's walk over a Size flow", () => {
  it("applies a single fixed size automatically, with no decision to make", async () => {
    const { driver, applied } = await walkSize(["med"]);
    expect(driver.sizeSteps).toHaveLength(0);
    expect(applied).toEqual([{ level: 0, data: "med", options: { automatic: true } }]);
  });

  it("surfaces a real size choice instead of auto-applying the system's first size", async () => {
    const { driver, applied } = await walkSize(["sm", "med"]);
    expect(driver.sizeSteps).toHaveLength(1);
    // The decisive assertion: nothing was applied automatically. Trusting
    // `getAutomaticApplicationValue()` here would have silently locked in "sm".
    expect(applied).toHaveLength(0);
  });

  it("seeds the open choice so the clone is never sizeless while it waits", async () => {
    const { seeded } = await walkSize(["sm", "med"]);
    expect(seeded).toBe(1);
  });

  it("carries the advancement and its item on the recorded decision", async () => {
    const { driver } = await walkSize(["sm", "med"]);
    const [record] = driver.sizeSteps;
    expect(record.advancement.type).toBe("Size");
    expect(record.item.id).toBe("raceHuman000000");
    expect(record.level).toBe(0);
    expect(record.screenLevel).toBe(0);
  });
});
