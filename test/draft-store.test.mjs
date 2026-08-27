import { beforeEach, describe, expect, it } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import {
  applyDraft, cancelDraftSave, clearDraft, draftSnapshot, hasDraft, pruneMissingOrigins, readDraft,
  saveDraft
} from "../scripts/state/draft-store.mjs";
import { CreatorState } from "../scripts/state/creator-state.mjs";

/**
 * The contract this file holds the code to: **a draft is a set of answers, and restoring one must
 * never produce a character the player didn't design.**
 *
 * Three ways that promise could be broken quietly, one group of tests each:
 *
 *  1. **Something gets persisted that shouldn't be, or isn't that should.** The allowlist is the
 *     whole mechanism, so it is asserted directly: transient UI must not survive a round trip, and
 *     the answers must.
 *  2. **A stored payload from another version, or a hand-edited one, is half-applied.** Every
 *     guard is exercised with the malformed shape it exists for. A draft that can't be trusted has
 *     to be dropped whole, not partly believed.
 *  3. **A pick outlives the content that defined it.** A disabled module leaves a uuid pointing at
 *     nothing; the prune has to clear it *and* everything chosen because of it.
 *
 * The debounce is deliberately not tested through its timer — {@link saveDraft} and the cancel are
 * the parts with behaviour, and a test that sleeps to observe a 1.5s delay buys nothing.
 */

/** A `game.user` with working flag storage, which the shims' bare `{}` user doesn't have. */
function installFakeUser() {
  const flags = {};
  game.user = {
    flags,
    setFlag(_scope, key, value) {
      flags[key] = value;
      return Promise.resolve(value);
    },
    getFlag(_scope, key) { return flags[key]; },
    unsetFlag(_scope, key) {
      delete flags[key];
      return Promise.resolve();
    }
  };
  return flags;
}

/** A state carrying a recognisable answer in every kind of field the allowlist covers. */
function filledState() {
  const state = new CreatorState(null);
  state.classUuid = "Compendium.dnd5e.classes.Item.wizard";
  state.speciesUuid = "Compendium.dnd5e.races.Item.elf";
  state.backgroundUuid = "Compendium.dnd5e.backgrounds.Item.sage";
  state.targetLevel = 5;
  state.details.name = "Tordek";
  state.details.eyes = "grey";
  state.abilityMethod = "manual";
  state.manualScores.str = 14;
  state.rolledPool = [15, 14, 13, 12, 10, 8];
  state.selectedCantrips = [{ uuid: "Compendium.dnd5e.spells.Item.firebolt", name: "Fire Bolt" }];
  state.advChoices.class = { "skills-0": ["arcana", "history"] };
  state.store.purchases = { "Compendium.dnd5e.items.Item.rope": { qty: 1, cp: 100 } };
  state.exportPdf = true;
  return state;
}

beforeEach(() => {
  installFoundryShims();
  installFakeUser();
  cancelDraftSave();
});

describe("what a draft carries", () => {
  it("keeps every answer the player gave", () => {
    const snap = draftSnapshot(filledState());
    expect(snap.classUuid).toBe("Compendium.dnd5e.classes.Item.wizard");
    expect(snap.targetLevel).toBe(5);
    expect(snap.details.name).toBe("Tordek");
    expect(snap.abilityMethod).toBe("manual");
    expect(snap.manualScores.str).toBe(14);
    expect(snap.rolledPool).toEqual([15, 14, 13, 12, 10, 8]);
    expect(snap.advChoices.class["skills-0"]).toEqual(["arcana", "history"]);
    expect(snap.store.purchases).toHaveProperty("Compendium.dnd5e.items.Item.rope");
    expect(snap.exportPdf).toBe(true);
  });

  it("leaves out the draft actor, transient UI and the rebuildable caches", () => {
    const state = filledState();
    state.pickerFor = "class";
    state.spellSearch = "fire";
    state.focusedSpellUuid = "Compendium.x.Item.y";
    state.choiceCache = { hasAny: true };
    state.spellInfo = { isSpellcaster: true };
    const snap = draftSnapshot(state);
    for ( const field of ["actor", "pickerFor", "spellSearch", "focusedSpellUuid", "choiceCache",
      "spellInfo", "featSpellCache", "originAsi", "storeBudgetCp"] ) {
      expect(snap, field).not.toHaveProperty(field);
    }
  });

  it("snapshots by value, so a state that keeps changing doesn't rewrite what was captured", () => {
    const state = filledState();
    const snap = draftSnapshot(state);
    state.details.name = "Someone Else";
    state.selectedCantrips.push({ uuid: "x", name: "Light" });
    expect(snap.details.name).toBe("Tordek");
    expect(snap.selectedCantrips).toHaveLength(1);
  });

  it("round-trips a full build back onto a fresh state", async () => {
    await saveDraft(filledState());
    const restored = applyDraft(new CreatorState(null), readDraft().data);
    expect(restored.classUuid).toBe("Compendium.dnd5e.classes.Item.wizard");
    expect(restored.details.name).toBe("Tordek");
    expect(restored.details.eyes).toBe("grey");
    expect(restored.manualScores.str).toBe(14);
    expect(restored.advChoices.class["skills-0"]).toEqual(["arcana", "history"]);
    expect(restored.exportPdf).toBe(true);
  });

  it("leaves fields the draft never carried at their defaults", async () => {
    const state = new CreatorState(null);
    state.classUuid = "Compendium.dnd5e.classes.Item.wizard";
    await saveDraft(state);
    const restored = applyDraft(new CreatorState(null), readDraft().data);
    // Untouched by the draft, so still the class default rather than undefined.
    expect(restored.abilityMethod).toBe("point-buy");
    expect(restored.pointBuy.str).toBe(8);
    expect(restored.exportPdf).toBe(false);
  });
});

describe("a stored draft that can't be trusted", () => {
  it("offers nothing when the player has never saved one", () => {
    expect(readDraft()).toBeNull();
    expect(hasDraft()).toBe(false);
  });

  it("forgets a draft written to a different shape rather than half-applying it", async () => {
    const flags = installFakeUser();
    await saveDraft(filledState());
    flags.creatorDraft.version = 999;
    expect(readDraft()).toBeNull();
    // Forgotten, not merely skipped — otherwise it sits there being refused forever.
    expect(flags.creatorDraft).toBeUndefined();
  });

  it("forgets a payload that isn't parseable", async () => {
    const flags = installFakeUser();
    await saveDraft(filledState());
    flags.creatorDraft.json = "{not json";
    expect(readDraft()).toBeNull();
    expect(flags.creatorDraft).toBeUndefined();
  });

  it("skips a field whose stored shape doesn't fit, keeping the rest", () => {
    const restored = applyDraft(new CreatorState(null), {
      classUuid: "Compendium.dnd5e.classes.Item.wizard",
      details: "not an object",
      rolledPool: { nope: true },
      targetLevel: 4
    });
    expect(restored.classUuid).toBe("Compendium.dnd5e.classes.Item.wizard");
    expect(restored.targetLevel).toBe(4);
    // Both malformed fields kept their defaults instead of poisoning a later render.
    expect(restored.details.name).toBe("");
    expect(restored.rolledPool).toEqual([]);
  });

  it("survives being handed nothing at all", () => {
    const state = new CreatorState(null);
    expect(applyDraft(state, null)).toBe(state);
    expect(applyDraft(state, "nonsense")).toBe(state);
  });

  it("clears on request", async () => {
    await saveDraft(filledState());
    expect(hasDraft()).toBe(true);
    await clearDraft();
    expect(hasDraft()).toBe(false);
  });
});

describe("picks that outlived their content", () => {
  /** A source index that knows about everything except what the test names as missing. */
  const sourceWithout = (...missing) => ({
    card: uuid => (missing.includes(uuid) ? null : { uuid, name: uuid })
  });

  it("keeps every origin the world can still resolve", () => {
    const state = filledState();
    expect(pruneMissingOrigins(state, sourceWithout())).toEqual([]);
    expect(state.classUuid).toBe("Compendium.dnd5e.classes.Item.wizard");
  });

  it("drops a class that has gone, and everything chosen because of it", () => {
    const state = filledState();
    const dropped = pruneMissingOrigins(state, sourceWithout("Compendium.dnd5e.classes.Item.wizard"));
    expect(dropped).toEqual(["class"]);
    expect(state.classUuid).toBeNull();
    // The class's spells and advancement picks meant something only for that class.
    expect(state.selectedCantrips).toEqual([]);
    expect(state.advChoices.class).toEqual({});
    // Its neighbours are untouched: one missing module must not cost the whole build.
    expect(state.speciesUuid).toBe("Compendium.dnd5e.races.Item.elf");
    expect(state.details.name).toBe("Tordek");
  });

  it("reports each missing origin so the player can be told what went", () => {
    const state = filledState();
    const dropped = pruneMissingOrigins(state, sourceWithout(
      "Compendium.dnd5e.races.Item.elf", "Compendium.dnd5e.backgrounds.Item.sage"
    ));
    expect(dropped).toEqual(["species", "background"]);
    expect(state.speciesUuid).toBeNull();
    expect(state.backgroundUuid).toBeNull();
    expect(state.classUuid).toBe("Compendium.dnd5e.classes.Item.wizard");
  });
});
