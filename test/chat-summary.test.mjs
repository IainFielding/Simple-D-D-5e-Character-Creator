import { beforeEach, describe, expect, it } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import { SETTINGS } from "../scripts/config.mjs";
import {
  postCreationSummary, captureLevelUpSummary, postLevelUpSummary
} from "../scripts/build/chat-summary.mjs";

/**
 * The chat summary cards.
 *
 * The load-bearing behaviour here is the capture/post split on the level-up side: the summary is a
 * diff of the driver's clone against the real actor, and that diff only exists *before* the commit.
 * These tests hold the shell to that contract — capture reads the clone, posting reads nothing but
 * the snapshot — plus the three settings modes and the "never break the caller" guarantee.
 */

/** A Foundry-Collection-ish item store (same shape the other level-up tests use). */
function makeItems(initial = []) {
  const m = new Map(initial.map(i => [i.id, i]));
  return {
    get: id => m.get(id),
    filter: fn => [...m.values()].filter(fn),
    find: fn => [...m.values()].find(fn),
    map: fn => [...m.values()].map(fn),
    [Symbol.iterator]: () => m.values()
  };
}

function makeActor(items, { level = 1, hpMax = 10, prof = 2, ac = 15, name = "Vex" } = {}) {
  return {
    id: "actor0000000000",
    name,
    img: "portrait.webp",
    items: makeItems(items),
    system: {
      details: { level },
      attributes: { hp: { max: hpMax }, prof, ac: { value: ac } },
      abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"]
        .map((k, i) => [k, { value: 10 + i }])),
      spells: {}
    }
  };
}

/** The context the card template was handed, from the message the code under test posted. */
function postedContext(index = 0) {
  return JSON.parse(ChatMessage.created[index].content).context;
}

/** The template path the message rendered — "creation" or "levelup". */
function postedKind(index = 0) {
  return JSON.parse(ChatMessage.created[index].content).path;
}

/** A level-up state stub: a driver holding the clone, plus a spell plan the capture can read. */
function makeState(actor, clone, { spellcaster = false, cantrips = [], spells = [] } = {}) {
  return {
    actor,
    driver: { clone },
    selectedCantrips: cantrips,
    selectedSpells: spells,
    spellPlan: () => ({ isSpellcaster: spellcaster })
  };
}

beforeEach(() => {
  installFoundryShims();
  ChatMessage.created = [];
});

/* -------------------------------------------- */

describe("creation summary", () => {
  const items = [
    { id: "c1", type: "class", name: "Wizard", system: { identifier: "wizard", levels: 3 } },
    { id: "s1", type: "subclass", name: "Evocation", system: { classIdentifier: "wizard" } },
    { id: "r1", type: "race", name: "Wood Elf", system: {} },
    { id: "b1", type: "background", name: "Sage", system: {} }
  ];

  it("posts a card carrying the character's identity, scores and headline numbers", async () => {
    await postCreationSummary(makeActor(items, { level: 3, hpMax: 20, ac: 12 }));

    expect(ChatMessage.created).toHaveLength(1);
    expect(postedKind()).toContain("chat/creation.hbs");

    const ctx = postedContext();
    expect(ctx.name).toBe("Vex");
    // The subtitle interpolates level + every class the character holds.
    expect(ctx.subtitle).toContain("\"classes\":\"Wizard 3\"");
    expect(ctx.subtitle).toContain("\"level\":3");
    expect(ctx.abilities).toHaveLength(6);
    expect(ctx.abilities[0]).toMatchObject({ key: "str", value: 10, modifier: "+0" });
    expect(ctx.abilities[2]).toMatchObject({ key: "con", value: 12, modifier: "+1" });

    const values = ctx.rows.map(r => r.value);
    expect(values).toContain("Wood Elf");
    expect(values).toContain("Sage");
    expect(values).toContain("Evocation");
    expect(values).toContain("20");   // hit points
    expect(values).toContain("12");   // armour class
  });

  it("joins a multiclass character's classes into one line", async () => {
    await postCreationSummary(makeActor([
      { id: "c1", type: "class", name: "Fighter", system: { identifier: "fighter", levels: 2 } },
      { id: "c2", type: "class", name: "Rogue", system: { identifier: "rogue", levels: 1 } }
    ], { level: 3 }));

    expect(postedContext().subtitle).toContain("Fighter 2 · Rogue 1");
  });

  it("whispers to the GM in gm mode, and posts to everyone in public mode", async () => {
    game.settings.set(null, SETTINGS.creationSummary, "gm");
    await postCreationSummary(makeActor(items));
    expect(ChatMessage.created[0].whisper).toEqual(["gm-user"]);

    game.settings.set(null, SETTINGS.creationSummary, "public");
    await postCreationSummary(makeActor(items));
    expect(ChatMessage.created[1].whisper).toEqual([]);
  });

  it("posts nothing when the setting is off, or when there is no actor", async () => {
    game.settings.set(null, SETTINGS.creationSummary, "off");
    await postCreationSummary(makeActor(items));
    expect(ChatMessage.created).toHaveLength(0);

    game.settings.set(null, SETTINGS.creationSummary, "public");
    await postCreationSummary(null);
    expect(ChatMessage.created).toHaveLength(0);
  });

  it("swallows a posting failure rather than breaking the build that called it", async () => {
    ChatMessage.create = async () => { throw new Error("no chat log"); };
    await expect(postCreationSummary(makeActor(items))).resolves.toBeUndefined();
  });
});

/* -------------------------------------------- */

describe("level-up summary capture", () => {
  const CLS = "cls0000000000000";

  /** actor at Wizard 4, clone at Wizard 5 having gained a feature and a spell. */
  function pair() {
    const actorItems = [
      { id: CLS, type: "class", name: "Wizard", system: { identifier: "wizard", levels: 4 } },
      { id: "old1", type: "feat", name: "Arcane Recovery", system: {} }
    ];
    const cloneItems = [
      { id: CLS, type: "class", name: "Wizard", system: { identifier: "wizard", levels: 5 } },
      { id: "old1", type: "feat", name: "Arcane Recovery", system: {} },
      { id: "new1", type: "feat", name: "Potent Cantrip", system: {} },
      { id: "new2", type: "spell", name: "Fireball", system: {} }
    ];
    const actor = makeActor(actorItems, { level: 4, hpMax: 22, prof: 2 });
    const clone = makeActor(cloneItems, { level: 5, hpMax: 26, prof: 3 });
    clone.system.spells = { spell3: { max: 2 } };
    actor.system.spells = { spell3: { max: 0 } };
    return { actor, clone };
  }

  it("reads the gains off the clone before the commit", () => {
    const { actor, clone } = pair();
    const snap = captureLevelUpSummary(makeState(actor, clone));

    expect(snap.fromLevel).toBe(4);
    expect(snap.toLevel).toBe(5);
    expect(snap.classes).toEqual([{ name: "Wizard", from: 4, to: 5, isNew: false }]);
    expect(snap.hpGain).toBe(4);
    expect(snap.hpMax).toBe(26);
    expect(snap.profWas).toBe(2);
    expect(snap.profNow).toBe(3);
    // Only the items the actor lacks — the pre-existing feat must not be reported as new.
    expect(snap.features).toEqual(["Potent Cantrip"]);
    expect(snap.spells).toEqual(["Fireball"]);
    expect(snap.slots).toHaveLength(1);
  });

  it("folds in the spells staged on the state, which are not on the clone yet", () => {
    const { actor, clone } = pair();
    const snap = captureLevelUpSummary(makeState(actor, clone, {
      spellcaster: true,
      cantrips: [{ name: "Mind Sliver" }],
      spells: [{ name: "Counterspell" }]
    }));

    expect(snap.spells).toEqual(["Counterspell", "Fireball", "Mind Sliver"]);
  });

  it("reports a multiclass level as a new class rather than a 0 → 1 jump", () => {
    const actor = makeActor([
      { id: CLS, type: "class", name: "Wizard", system: { identifier: "wizard", levels: 4 } }
    ], { level: 4 });
    const clone = makeActor([
      { id: CLS, type: "class", name: "Wizard", system: { identifier: "wizard", levels: 4 } },
      { id: "cls2", type: "class", name: "Fighter", system: { identifier: "fighter", levels: 1 } },
      { id: "sub2", type: "subclass", name: "Champion", system: { classIdentifier: "fighter" } }
    ], { level: 5 });

    const snap = captureLevelUpSummary(makeState(actor, clone));
    expect(snap.classes).toEqual([{ name: "Fighter", from: 0, to: 1, isNew: true }]);
    // A gained subclass is its own field, not a "feature".
    expect(snap.subclass).toBe("Champion");
    expect(snap.features).toEqual([]);
  });

  it("returns null rather than throwing when the state has no driver yet", () => {
    expect(captureLevelUpSummary({ actor: makeActor([]) })).toBeNull();
    expect(captureLevelUpSummary(null)).toBeNull();
  });

  it("keeps the rest of the card when the spell plan throws", () => {
    const { actor, clone } = pair();
    const state = makeState(actor, clone);
    state.spellPlan = () => { throw new Error("no spell step"); };

    const snap = captureLevelUpSummary(state);
    expect(snap.features).toEqual(["Potent Cantrip"]);
    expect(snap.hpGain).toBe(4);
  });
});

/* -------------------------------------------- */

describe("level-up summary posting", () => {
  const snapshot = {
    fromLevel: 4, toLevel: 5,
    classes: [{ name: "Wizard", from: 4, to: 5, isNew: false }],
    subclass: null,
    hpGain: 4, hpMax: 26,
    profWas: 2, profNow: 3,
    slots: [{ label: "3rd", change: "0 → 2" }],
    features: ["Potent Cantrip"],
    spells: ["Fireball"]
  };

  it("posts a card listing what changed", async () => {
    await postLevelUpSummary(makeActor([]), snapshot);

    expect(ChatMessage.created).toHaveLength(1);
    expect(postedKind()).toContain("chat/levelup.hbs");

    const ctx = postedContext();
    expect(ctx.features).toEqual(["Potent Cantrip"]);
    expect(ctx.spells).toEqual(["Fireball"]);
    // The shim's i18n echoes the key back, module namespace and all (see foundry-shims).
    const labels = ctx.rows.map(r => r.label);
    expect(labels).toContain("sogrom-dnd5e-character-creator.chat.levelup.hitPoints");
    expect(labels).toContain("sogrom-dnd5e-character-creator.chat.levelup.profBonus");
    expect(labels).toContain("sogrom-dnd5e-character-creator.chat.levelup.spellSlots");
  });

  it("posts nothing for a null snapshot, or when the setting is off", async () => {
    await postLevelUpSummary(makeActor([]), null);
    expect(ChatMessage.created).toHaveLength(0);

    game.settings.set(null, SETTINGS.levelUpSummary, "off");
    await postLevelUpSummary(makeActor([]), snapshot);
    expect(ChatMessage.created).toHaveLength(0);
  });

  it("posts nothing when a level-up changed nothing worth reporting", async () => {
    await postLevelUpSummary(makeActor([]), {
      ...snapshot,
      classes: [], subclass: null, hpGain: 0, profWas: 2, profNow: 2,
      slots: [], features: [], spells: []
    });
    expect(ChatMessage.created).toHaveLength(0);
  });

  it("swallows a posting failure rather than losing the applied level", async () => {
    ChatMessage.create = async () => { throw new Error("no chat log"); };
    await expect(postLevelUpSummary(makeActor([]), snapshot)).resolves.toBeUndefined();
  });
});
