import { beforeEach, describe, expect, it } from "vitest";
import { featSpellGrants, featSubstituteData, spellChanges } from "../scripts/levelup/steps/lvl-spells-step.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * Spells a feat hands out — Cold Caster's Ray of Frost and its four cousins in the reference
 * content.
 *
 * Two behaviours are worth pinning here because both were wrong before and neither is obvious.
 * A feat whose granted item the pack marks `optional` is **not** applied by dnd5e's seed, so the
 * spell the feat's own text says you learn never arrived at all; and the substitution the rules
 * grant ("*If you already know it*, you learn a different Wizard cantrip") is conditional on
 * already knowing it, so the control must not appear for a character who doesn't.
 */

/** A feat item carrying one spell-granting ItemGrant, shaped as the packs actually store it. */
function featItem(id, { uuid, optional = false, identifier = "cold-caster" } = {}) {
  return {
    id, name: "Cold Caster", img: "feat.webp", type: "feat",
    system: {
      identifier,
      advancement: [{
        _id: "adv1", type: "ItemGrant", level: 0,
        configuration: {
          items: [{ uuid, optional }],
          spell: { ability: ["int", "wis", "cha"], method: "spell", prepared: 2 }
        },
        value: {}
      }]
    }
  };
}

/** A clone holding the feat, plus whatever spells the character already has. */
function stateWith(feat, ownedSpells = [], swaps = {}) {
  const items = [feat, ...ownedSpells];
  items.get = id => items.find(i => i.id === id);
  return {
    featSpellSwaps: swaps,
    asiSteps: [{ id: "rec" }],
    driver: {
      clone: { items },
      asiState: () => ({ type: "feat", feat: { id: feat.id, name: feat.name, img: feat.img } })
    }
  };
}

const RAY = "Compendium.phb.spells.Item.rayOfFrost";
const FIREBOLT = "Compendium.phb.spells.Item.fireBolt";

/** A spell item as it sits on an actor, and the compendium doc `fromUuid` returns. */
const ownedSpell = (id, identifier, level = 0) =>
  ({ id, name: identifier, type: "spell", system: { identifier, level } });

beforeEach(() => {
  installFoundryShims();
  globalThis.fromUuid = async uuid => ({
    uuid,
    name: uuid === RAY ? "Ray of Frost" : "Fire Bolt",
    img: "spell.webp",
    system: { level: 0, identifier: uuid === RAY ? "ray-of-frost" : "fire-bolt" },
    toObject() { return { name: this.name, system: { ...this.system }, _stats: {} }; }
  });
});

describe("featSpellGrants", () => {
  it("finds the spell a feat grants, and reports it replaceable when the pack says so", async () => {
    const state = stateWith(featItem("f1", { uuid: RAY, optional: true }));
    const [grant] = await featSpellGrants(state);

    expect(grant.name).toBe("Ray of Frost");
    expect(grant.featName).toBe("Cold Caster");
    expect(grant.replaceable).toBe(true);
    expect(grant.level).toBe(0);
  });

  it("reports a grant the pack does not mark optional as fixed", async () => {
    const state = stateWith(featItem("f1", { uuid: RAY, optional: false }));
    const [grant] = await featSpellGrants(state);
    expect(grant.replaceable).toBe(false);
  });

  it("only calls it already known when the character actually has that spell", async () => {
    const without = await featSpellGrants(stateWith(featItem("f1", { uuid: RAY, optional: true })));
    expect(without[0].alreadyKnown).toBe(false);

    const withIt = await featSpellGrants(
      stateWith(featItem("f1", { uuid: RAY, optional: true }), [ownedSpell("s1", "ray-of-frost")]));
    expect(withIt[0].alreadyKnown).toBe(true);
  });

  it("does not count the grant's own spell as one the character already knew", async () => {
    // The advancement records what it granted in `value.added`. Without excluding those, applying
    // the grant would make the very next render report the spell as already known and offer a
    // substitution the rules don't give.
    const feat = featItem("f1", { uuid: RAY, optional: true });
    feat.system.advancement[0].value = { added: { s1: RAY } };
    const state = stateWith(feat, [ownedSpell("s1", "ray-of-frost")]);
    expect((await featSpellGrants(state))[0].alreadyKnown).toBe(false);
  });

  it("ignores an ItemGrant that grants no spell, and a feat that grants nothing", async () => {
    const feat = featItem("f1", { uuid: RAY });
    delete feat.system.advancement[0].configuration.spell;
    expect(await featSpellGrants(stateWith(feat))).toEqual([]);
  });
});

describe("featSubstituteData", () => {
  it("builds the substitute with the grant's own casting configuration and a feat source tag", async () => {
    const state = stateWith(
      featItem("f1", { uuid: RAY, optional: true }),
      [ownedSpell("s1", "ray-of-frost")]
    );
    state.featSpells = await featSpellGrants(state);
    state.featSpellSwaps = { [state.featSpells[0].key]: FIREBOLT };

    const [data] = await featSubstituteData(state);
    expect(data.name).toBe("Fire Bolt");
    // Always prepared, the caster method and ability the feat's grant declares — the same shape
    // the advancement would have applied to the spell it replaces.
    expect(data.system.prepared).toBe(2);
    expect(data.system.method).toBe("spell");
    expect(data.system.ability).toBe("int");
    expect(data.system.sourceItem).toBe("feat:cold-caster");
  });

  it("builds nothing when no substitution was made", async () => {
    const state = stateWith(featItem("f1", { uuid: RAY, optional: true }));
    state.featSpells = await featSpellGrants(state);
    expect(await featSubstituteData(state)).toEqual([]);
  });
});

describe("spellChanges", () => {
  it("leaves feat grants alone — the advancement grants those, not the spell picks", async () => {
    // Creating the granted spell here as well as on the clone is the duplicate the reconciliation
    // pass exists to undo; the substitute goes through featSubstituteData instead.
    const state = stateWith(featItem("f1", { uuid: RAY, optional: true }));
    state.featSpells = await featSpellGrants(state);
    state.featSpellSwaps = { [state.featSpells[0].key]: FIREBOLT };
    state.selectedCantrips = [];
    state.selectedSpells = [];
    state.spellPlan = () => ({ sourceTag: "class:wizard", method: "spell", addCantrips: 0, addSpells: 0 });

    expect(spellChanges(state).create).toEqual([]);
  });
});

describe("the spell page's gate", () => {
  it("opens the spell page for a non-caster whose feat granted a spell", async () => {
    // The point of the whole feature: Cold Caster exists so a Fighter can learn a cantrip, and a
    // Fighter has no spellcasting capacity to bring them to this page by the usual route.
    const { LevelUpState } = await import("../scripts/levelup/levelup-state.mjs");
    const state = Object.create(LevelUpState.prototype);
    state.spellPlan = () => ({ hasDelta: false });

    state.featSpells = [];
    expect(state.hasSpellStep()).toBe(false);

    state.featSpells = [{ key: "f1:x", name: "Ray of Frost" }];
    expect(state.hasSpellStep()).toBe(true);
  });
});
