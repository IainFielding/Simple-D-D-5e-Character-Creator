import { describe, expect, it, beforeEach } from "vitest";
import { registeredClassLists, spellListFor, spellListNotice } from "../scripts/data/spell-source.mjs";
import { spellsStep } from "../scripts/steps/spells-step.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * Which spell list a caster draws from. Most casters use the list registered under their own
 * identifier, but the third-caster subclasses have none: the PHB registers `class:wizard` and a
 * `subclass:` list for every domain/Circle/Oath, yet nothing for the Eldritch Knight or the Arcane
 * Trickster — their Spellcasting feature only says "the Wizard spell list" in prose. Resolving
 * those to `subclass:eldritch-knight` yields an empty pool, which is what left the level-up spell
 * page blank after picking Eldritch Knight at Fighter 3.
 */
describe("spellListFor", () => {
  /** Stand in for dnd5e's registry, holding exactly the lists the PHB module registers. */
  function registerLists(keys) {
    globalThis.dnd5e.registry = {
      spellLists: {
        // `name` is the registry's own display label, which the provenance line shows.
        forType(type, identifier) {
          return keys.includes(`${type}:${identifier}`)
            ? { uuids: new Set(["Compendium.x.spells.Item.a"]), name: titleCase(identifier) }
            : null;
        },
        get options() {
          return keys.map(key => ({ value: key, label: titleCase(key.split(":")[1]), type: key.split(":")[0] }));
        }
      }
    };
  }
  const titleCase = id => id.split(/[-_]/).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

  const PHB = ["class:wizard", "class:cleric", "class:druid", "subclass:moon", "subclass:trickery"];
  const subclass = (identifier, classIdentifier) => ({ system: { identifier, classIdentifier } });

  beforeEach(() => {
    installFoundryShims();
    registerLists(PHB);
  });

  it("borrows the Wizard list for an Eldritch Knight, which registers none of its own", () => {
    expect(spellListFor(subclass("eldritch-knight", "fighter"), "eldritch-knight", "subclass"))
      .toEqual({ id: "wizard", type: "class" });
  });

  it("borrows the Wizard list for the Arcane Trickster under either identifier", () => {
    // The PHB subclass item calls itself "trickster"; other data spells it out.
    expect(spellListFor(subclass("trickster", "rogue"), "trickster", "subclass"))
      .toEqual({ id: "wizard", type: "class" });
    expect(spellListFor(subclass("arcane-trickster", "rogue"), "arcane-trickster", "subclass"))
      .toEqual({ id: "wizard", type: "class" });
  });

  it("keeps a subclass that has its own registered list", () => {
    expect(spellListFor(subclass("moon", "druid"), "moon", "subclass"))
      .toEqual({ id: "moon", type: "subclass" });
  });

  it("falls back to the parent class's list for an unmapped subclass caster", () => {
    // A homebrew casting subclass of a casting class: the class list is the right pool.
    expect(spellListFor(subclass("stargazer", "druid"), "stargazer", "subclass"))
      .toEqual({ id: "druid", type: "class" });
  });

  it("leaves a class caster alone", () => {
    expect(spellListFor({ system: { identifier: "wizard" } }, "wizard", "class"))
      .toEqual({ id: "wizard", type: "class" });
  });

  it("keeps the subclass's own key when nothing is registered, so the pack scans still run", () => {
    registerLists([]);
    expect(spellListFor(subclass("eldritch-knight", "fighter"), "eldritch-knight", "subclass"))
      .toEqual({ id: "eldritch-knight", type: "subclass" });
  });

  it("survives a registry that isn't loaded yet", () => {
    globalThis.dnd5e.registry = undefined;
    expect(spellListFor(subclass("eldritch-knight", "fighter"), "eldritch-knight", "subclass"))
      .toEqual({ id: "eldritch-knight", type: "subclass" });
  });

  /*
   * The player's own answer, for the casters no lookup can place. dnd5e's subclass schema carries
   * no field naming the list a caster borrows, so a third-party third-caster has nothing to find
   * and no amount of extending SUBCLASS_SPELL_LISTS reaches the next one.
   */
  describe("with a chosen override", () => {
    const homebrew = subclass("spellblade", "fighter");

    it("wins over every other lookup, and says the player chose it", () => {
      expect(spellListFor(homebrew, "spellblade", "subclass", "wizard"))
        .toEqual({ id: "wizard", type: "class", chosen: true });
    });

    it("overrides even a caster that resolves perfectly well on its own", () => {
      expect(spellListFor(subclass("moon", "druid"), "moon", "subclass", "wizard"))
        .toEqual({ id: "wizard", type: "class", chosen: true });
    });

    it("is ignored once it names a list the world no longer has", () => {
      // Content disabled since the pick was made falls back to ordinary resolution, not to nothing.
      expect(spellListFor(subclass("stargazer", "druid"), "stargazer", "subclass", "artificer"))
        .toEqual({ id: "druid", type: "class" });
    });
  });
});

/* -------------------------------------------- */

describe("registeredClassLists", () => {
  function registry(options, withSpells = () => true) {
    globalThis.dnd5e.registry = {
      spellLists: {
        options,
        forType: (type, id) => (withSpells(`${type}:${id}`) ? { uuids: new Set(["u"]) } : null)
      }
    };
  }

  beforeEach(() => installFoundryShims());

  it("offers the class lists and leaves the subclass ones out", () => {
    registry([
      { value: "class:wizard", label: "Wizard" },
      { value: "subclass:moon", label: "Circle of the Moon" },
      { value: "class:druid", label: "Druid" }
    ]);
    expect(registeredClassLists()).toEqual([{ id: "wizard", label: "Wizard" }, { id: "druid", label: "Druid" }]);
  });

  it("drops a registered list that holds no spells - picking it would change nothing", () => {
    registry([{ value: "class:wizard", label: "Wizard" }, { value: "class:hollow", label: "Hollow" }],
      key => key !== "class:hollow");
    expect(registeredClassLists().map(o => o.id)).toEqual(["wizard"]);
  });

  it("returns nothing rather than throwing when the registry isn't loaded", () => {
    globalThis.dnd5e.registry = undefined;
    expect(registeredClassLists()).toEqual([]);
  });
});

/* -------------------------------------------- */

/**
 * The view-model both spell steps hand to parts/spell-list-notice.hbs. Its whole job is to be
 * silent in the ordinary case and loud in exactly one: a caster whose list resolves to nothing.
 */
describe("spellListNotice", () => {
  beforeEach(() => {
    installFoundryShims();
    globalThis.dnd5e.registry = {
      spellLists: {
        options: [{ value: "class:wizard", label: "Wizard" }, { value: "class:druid", label: "Druid" }],
        forType: () => ({ uuids: new Set(["u"]) })
      }
    };
  });

  it("says nothing for a caster drawing from its own list", () => {
    const notice = spellListNotice({ listBorrowed: false, listMissing: false }, "", "Wizard");
    expect(notice.listBorrowed).toBe(false);
    expect(notice.listMissing).toBe(false);
    expect(notice.listOptions).toEqual([]);
  });

  it("names a borrowed list without offering to change it", () => {
    const notice = spellListNotice(
      { listBorrowed: true, listMissing: false, listLabel: "Wizard" }, "", "Eldritch Knight");
    expect(notice.listBorrowed).toBe(true);
    expect(notice.listLabel).toBe("Wizard");
    expect(notice.listOptions).toEqual([]);
  });

  it("offers every class list, marking the one already chosen, when nothing resolved", () => {
    const notice = spellListNotice({ listMissing: true }, "druid", "Spellblade");
    expect(notice.className).toBe("Spellblade");
    expect(notice.listOptions).toEqual([
      { id: "wizard", label: "Wizard", selected: false },
      { id: "druid", label: "Druid", selected: true }
    ]);
  });

  it("reads the registry only when it is about to show the picker", () => {
    let reads = 0;
    Object.defineProperty(globalThis.dnd5e.registry.spellLists, "options", {
      get() { reads++; return []; }
    });
    spellListNotice({ listBorrowed: true, listMissing: false }, "", "Eldritch Knight");
    expect(reads).toBe(0);
    spellListNotice({ listMissing: true }, "", "Spellblade");
    expect(reads).toBe(1);
  });
});

/* -------------------------------------------- */

/**
 * What a missing list means for the build gate.
 *
 * A caster with a quota and no pool is the one state that could trap a player: the Spells step
 * demands three cantrips, the list offers none, and Next stays shut forever. The step stands aside
 * instead and lets the panel explain, which is the whole reason the pool reports `listMissing`
 * rather than just coming back empty.
 */
describe("the Spells step's gate with no resolvable list", () => {
  const state = info => ({ spellInfo: info, selectedCantrips: [], selectedSpells: [] });

  it("blocks a caster that simply hasn't chosen yet", () => {
    expect(spellsStep.isComplete(state({ isSpellcaster: true, maxCantrips: 3, maxSpells: 2 }))).toBe(false);
  });

  it("stands aside when the quota cannot be filled from an empty list", () => {
    const stuck = state({ isSpellcaster: true, maxCantrips: 3, maxSpells: 2, listMissing: true });
    expect(spellsStep.isComplete(stuck)).toBe(true);
    // And says nothing about picks that cannot be made, so the rail hint stays honest.
    expect(spellsStep.incompleteHint(stuck)).toBeNull();
  });
});
