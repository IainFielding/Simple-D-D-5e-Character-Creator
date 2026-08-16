import { describe, expect, it } from "vitest";
import { planSpellReconciliation, reconcileGrantedSpells } from "../scripts/build/spell-reconcile.mjs";
import { ownedSpellKeys, spellKey, isGrantedSpell } from "../scripts/data/spell-identity.mjs";
import { MODULE_ID } from "../scripts/config.mjs";

/**
 * Granted/chosen spell reconciliation.
 *
 * The bug being pinned: a class or subclass `ItemGrant` declaring `spell.prepared = 2` hands out an
 * always-prepared spell that is *also* on the same class's ordinary list, so the player could pick it
 * again and end up with two Items. Only the plain copy counts toward `preparation.value`
 * (dnd5e `SpellData#countsPrepared`), so the duplicate permanently ate one of the character's
 * prepared slots — for a spell they already always have.
 *
 * Every case below is drawn from real 5.3.3 pack data: Divine Smite is granted by the Paladin class
 * at level 2 (`classes24/paladin/paladin.yml`) and sits on the Paladin spell list; Life Domain grants
 * its domain spells with `sourceItem: subclass:life` while the Cleric picks off `class:cleric`.
 *
 * The refusals matter more than the merges — a missed merge is a visible duplicate the player can
 * delete, a wrong merge silently destroys an entitlement.
 */

const DIVINE_SMITE = "Compendium.dnd5e.spells24.Item.phbsplDivineSmit";
const CURE_WOUNDS = "Compendium.dnd5e.spells24.Item.phbsplCureWounds";

/** A spell item stub in the shape the reconciler reads. */
function spell({
  id, uuid = DIVINE_SMITE, level = 1, prepared = 1, method = "spell", ability = "",
  sourceItem = "class:paladin", origin = null, name = "Divine Smite"
} = {}) {
  const flags = origin ? { dnd5e: { advancementOrigin: origin } } : {};
  return {
    id, name, type: "spell", img: "icons/svg/daze.svg", flags,
    _stats: { compendiumSource: uuid },
    system: { level, prepared, method, ability, sourceItem },
    getFlag: (scope, key) => flags[scope]?.[key]
  };
}

/** A non-spell item, so the owner of a grant can be resolved by name. */
function feature(id, name) {
  return { id, name, type: "feat", system: {}, getFlag: () => undefined };
}

/** An actor-alike that records the writes the reconciler makes. */
function makeActor(items) {
  const map = new Map(items.map(i => [i.id, i]));
  const seen = { deleted: [], updated: [] };
  return {
    seen,
    items: {
      get: id => map.get(id),
      [Symbol.iterator]: () => map.values()
    },
    async deleteEmbeddedDocuments(_type, ids) {
      seen.deleted.push(...ids);
      for ( const id of ids ) map.delete(id);
    },
    async updateEmbeddedDocuments(_type, updates) {
      seen.updated.push(...updates);
    },
    /** What is left on the actor afterwards. */
    remaining: () => [...map.values()]
  };
}

/* -------------------------------------------- */
/*  Identity                                    */
/* -------------------------------------------- */

describe("spellKey", () => {
  it("matches two copies of the same spell despite different ids, tags and prepared state", () => {
    const granted = spell({ id: "a", prepared: 2, sourceItem: "subclass:life", origin: "featX." });
    const chosen = spell({ id: "b", prepared: 1, sourceItem: "class:cleric" });
    expect(spellKey(granted)).toBe(spellKey(chosen));
  });

  it("separates the same compendium id at a different spell level", () => {
    expect(spellKey(spell({ id: "a", level: 1 }))).not.toBe(spellKey(spell({ id: "b", level: 2 })));
  });

  it("falls back to the identifier for world homebrew with no compendium source", () => {
    const homebrew = { type: "spell", _stats: {}, system: { identifier: "mending-touch", level: 1 } };
    expect(spellKey(homebrew)).toBe("id:mending-touch|1");
  });

  it("reports nothing rather than guessing when there is no identity at all", () => {
    expect(spellKey({ type: "spell", _stats: {}, system: {} })).toBe(null);
    expect(spellKey(null)).toBe(null);
  });

  it("reads a pool entry's shape as well as a live item's", () => {
    // The spell steps hold `{ uuid, level }` rows, which must key the same as the created item.
    expect(spellKey({ uuid: DIVINE_SMITE, level: 1 })).toBe(spellKey(spell({ id: "a", level: 1 })));
  });
});

describe("ownedSpellKeys", () => {
  it("counts every spell whatever its preparation state or origin", () => {
    const actor = makeActor([
      spell({ id: "a", prepared: 2, origin: "featX." }),
      spell({ id: "b", uuid: CURE_WOUNDS, prepared: 0, name: "Cure Wounds" }),
      feature("f1", "Divine Smite")
    ]);
    // The old owned-spell filter required `prepared === 1`, which is exactly how granted copies
    // stayed invisible to the pool and got offered a second time.
    expect(ownedSpellKeys(actor).size).toBe(2);
  });
});

describe("isGrantedSpell", () => {
  it("recognises an advancement's handiwork and nothing else", () => {
    expect(isGrantedSpell(spell({ id: "a", origin: "featX.advY" }))).toBe(true);
    expect(isGrantedSpell(spell({ id: "b" }))).toBe(false);
  });
});

/* -------------------------------------------- */
/*  Merging                                     */
/* -------------------------------------------- */

describe("reconcileGrantedSpells", () => {
  it("collapses the Paladin 2 Divine Smite pair, keeping the granted copy", async () => {
    const granted = spell({ id: "granted", prepared: 2, origin: "clsPaladin.advSmite" });
    const chosen = spell({ id: "chosen", prepared: 1 });
    const actor = makeActor([granted, chosen]);

    const result = await reconcileGrantedSpells(actor);

    expect(actor.seen.deleted).toEqual(["chosen"]);
    expect(actor.remaining().map(i => i.id)).toEqual(["granted"]);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].removedId).toBe("chosen");
  });

  it("keeps the granted copy specifically, so the advancement's own record stays valid", async () => {
    // dnd5e records the id it created in the advancement's `value.added`. Deleting that document
    // would leave the record dangling — the reason the survivor is never the chosen copy.
    const actor = makeActor([
      spell({ id: "granted", prepared: 2, origin: "clsPaladin.advSmite" }),
      spell({ id: "chosen", prepared: 1 })
    ]);
    await reconcileGrantedSpells(actor);
    expect(actor.remaining()[0].system.prepared).toBe(2);
  });

  it("hands back the prepared slot the duplicate was occupying", async () => {
    const actor = makeActor([
      spell({ id: "granted", prepared: 2, origin: "clsPaladin.advSmite" }),
      spell({ id: "chosen", prepared: 1 })
    ]);
    const result = await reconcileGrantedSpells(actor);
    expect(result.releasedSpells).toBe(1);
    expect(result.releasedCantrips).toBe(0);
  });

  it("counts a duplicate cantrip against the cantrip budget instead", async () => {
    const actor = makeActor([
      spell({ id: "granted", level: 0, prepared: 1, origin: "featBlessed.adv", name: "Sacred Flame" }),
      spell({ id: "chosen", level: 0, prepared: 1, name: "Sacred Flame" })
    ]);
    const result = await reconcileGrantedSpells(actor);
    expect(result.releasedCantrips).toBe(1);
    expect(result.releasedSpells).toBe(0);
  });

  it("merges across a subclass grant and a class pick — the Life Domain case", async () => {
    const actor = makeActor([
      spell({ id: "granted", uuid: CURE_WOUNDS, name: "Cure Wounds", prepared: 2,
        sourceItem: "subclass:life", origin: "subLife.advDomain" }),
      spell({ id: "chosen", uuid: CURE_WOUNDS, name: "Cure Wounds", prepared: 1,
        sourceItem: "class:cleric" })
    ]);
    const result = await reconcileGrantedSpells(actor);
    expect(actor.seen.deleted).toEqual(["chosen"]);
    expect(result.merged).toHaveLength(1);
  });

  it("attributes the survivor to the feature that granted it", async () => {
    const actor = makeActor([
      feature("subLife", "Life Domain"),
      spell({ id: "granted", prepared: 2, origin: "subLife.advDomain" }),
      spell({ id: "chosen", prepared: 1 })
    ]);
    const result = await reconcileGrantedSpells(actor);
    expect(result.merged[0].grantedBy).toBe("Life Domain");
  });

  it("flags the survivor so the Review can say why it is always prepared", async () => {
    const actor = makeActor([
      spell({ id: "granted", prepared: 2, origin: "clsPaladin.advSmite" }),
      spell({ id: "chosen", prepared: 1 })
    ]);
    await reconcileGrantedSpells(actor);
    expect(actor.seen.updated).toEqual([
      { _id: "granted", [`flags.${MODULE_ID}.alsoChosen`]: true }
    ]);
  });

  /* ---- refusals ---- */

  it("leaves a Magic Initiate spell alone — the feat is its own entitlement", async () => {
    // The feat grants one free casting per long rest; a Cleric may *also* prepare it normally.
    // Collapsing them would take one of those away.
    const actor = makeActor([
      spell({ id: "granted", uuid: CURE_WOUNDS, name: "Cure Wounds", prepared: 2,
        sourceItem: "feat:magic-initiate", origin: "featMI.adv" }),
      spell({ id: "chosen", uuid: CURE_WOUNDS, name: "Cure Wounds", prepared: 1,
        sourceItem: "class:cleric" })
    ]);
    const result = await reconcileGrantedSpells(actor);
    expect(actor.seen.deleted).toEqual([]);
    expect(result.merged).toEqual([]);
  });

  it("leaves a pact-magic copy and a spell-slot copy separate", async () => {
    const actor = makeActor([
      spell({ id: "granted", prepared: 2, method: "pact", origin: "clsWarlock.adv" }),
      spell({ id: "chosen", prepared: 1, method: "spell" })
    ]);
    expect((await reconcileGrantedSpells(actor)).merged).toEqual([]);
    expect(actor.seen.deleted).toEqual([]);
  });

  it("leaves copies cast off different abilities separate", async () => {
    const actor = makeActor([
      spell({ id: "granted", prepared: 2, ability: "wis", origin: "subX.adv" }),
      spell({ id: "chosen", prepared: 1, ability: "cha" })
    ]);
    expect((await reconcileGrantedSpells(actor)).merged).toEqual([]);
  });

  it("does nothing when a spell was only granted, or only chosen", async () => {
    const grantedOnly = makeActor([spell({ id: "g", prepared: 2, origin: "x.y" })]);
    expect((await reconcileGrantedSpells(grantedOnly)).merged).toEqual([]);

    const chosenOnly = makeActor([spell({ id: "c", prepared: 1 })]);
    expect((await reconcileGrantedSpells(chosenOnly)).merged).toEqual([]);
  });

  it("leaves two different spells alone", async () => {
    const actor = makeActor([
      spell({ id: "granted", prepared: 2, origin: "x.y" }),
      spell({ id: "chosen", uuid: CURE_WOUNDS, name: "Cure Wounds", prepared: 1 })
    ]);
    expect((await reconcileGrantedSpells(actor)).merged).toEqual([]);
  });

  it("is a no-op the second time — nothing is left to match", async () => {
    const actor = makeActor([
      spell({ id: "granted", prepared: 2, origin: "clsPaladin.advSmite" }),
      spell({ id: "chosen", prepared: 1 })
    ]);
    await reconcileGrantedSpells(actor);
    const again = await reconcileGrantedSpells(actor);
    expect(again.merged).toEqual([]);
    expect(again.releasedSpells).toBe(0);
    expect(actor.seen.deleted).toEqual(["chosen"]);
  });

  it("survives an actor-alike with nothing to work with", async () => {
    const empty = { merged: [], deleteIds: [], updates: [], releasedSpells: 0, releasedCantrips: 0 };
    await expect(reconcileGrantedSpells(null)).resolves.toEqual(empty);
    await expect(reconcileGrantedSpells({ items: [] })).resolves.toEqual(empty);
  });
});

/* -------------------------------------------- */
/*  Planning is read-only                       */
/* -------------------------------------------- */

/**
 * Planning has to be safe to run against a level-up driver's clone, so the spells step can learn
 * what a merge would free up while the player is still choosing. That clone is an unsaved copy which
 * **keeps the real actor's id**, so any embedded-document write on it goes straight through to the
 * character. Planning must therefore never write anything.
 */
describe("planSpellReconciliation", () => {
  it("reports the same merge without touching the actor", () => {
    const actor = makeActor([
      spell({ id: "granted", prepared: 2, origin: "clsPaladin.advSmite" }),
      spell({ id: "chosen", prepared: 1 })
    ]);
    const plan = planSpellReconciliation(actor);

    expect(plan.deleteIds).toEqual(["chosen"]);
    expect(plan.releasedSpells).toBe(1);
    // Nothing was written, and both documents are still there.
    expect(actor.seen.deleted).toEqual([]);
    expect(actor.seen.updated).toEqual([]);
    expect(actor.remaining()).toHaveLength(2);
  });

  it("plans nothing for a clone whose grant has no chosen twin", () => {
    const clone = { items: [spell({ id: "granted", prepared: 2, origin: "x.y" })] };
    expect(planSpellReconciliation(clone).deleteIds).toEqual([]);
  });
});
