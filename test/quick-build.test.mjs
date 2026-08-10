import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import { QUICK_BUILD, MI_SPELL_SUGGESTIONS, FEATURE_PREFERENCES } from "../scripts/data/quick-build-data.mjs";
import {
  applyQuickBuild, assignStandardArray, allocateOriginAsi, pickBackground, choosePicks, pickSpells
} from "../scripts/data/quick-build.mjs";
import { ABILITIES, DEFAULT_CANTRIPS, DEFAULT_LEVEL1_SPELLS } from "../scripts/config.mjs";
import { CreatorState } from "../scripts/state/creator-state.mjs";
import { abilitiesComplete } from "../scripts/steps/abilities-step.mjs";
import { choicesComplete } from "../scripts/data/choice-resolver.mjs";
import { featSpellsStep } from "../scripts/steps/feat-spells-step.mjs";
import { UUID, makeFromUuid } from "./fixtures/dnd5e-5.3.3.mjs";

/** The 18 dnd5e skill codes — the only values a profile's skill lists may use. */
const SKILL_CODES = new Set([
  "acr", "ani", "arc", "ath", "dec", "his", "ins", "itm", "inv",
  "med", "nat", "prc", "per", "prf", "rel", "slt", "ste", "sur"
]);

/* -------------------------------------------- */
/*  Suggestion-table integrity                  */
/* -------------------------------------------- */
//
// The table is hand-authored data; these checks catch the typos a live world would only
// surface as a silently-incomplete quick build (a skill code that matches nothing, an
// ability list missing a key, a caster with fewer suggestions than picks).

describe("QUICK_BUILD table integrity", () => {
  const CLASSES = [
    "artificer", "barbarian", "bard", "cleric", "druid", "fighter",
    "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"
  ];

  it("covers all 13 supported classes", () => {
    expect(Object.keys(QUICK_BUILD).sort()).toEqual([...CLASSES].sort());
  });

  it("gives every class a full permutation of the six abilities", () => {
    for ( const [id, profile] of Object.entries(QUICK_BUILD) ) {
      expect([...profile.abilities].sort(), id).toEqual([...ABILITIES].sort());
    }
  });

  it("uses only valid skill codes in skills and expertise", () => {
    for ( const [id, profile] of Object.entries(QUICK_BUILD) ) {
      for ( const code of [...profile.skills, ...(profile.expertise ?? [])] ) {
        expect(SKILL_CODES.has(code), `${id}: ${code}`).toBe(true);
      }
    }
  });

  it("suggests at least one background per class", () => {
    for ( const [id, profile] of Object.entries(QUICK_BUILD) ) {
      expect(profile.backgrounds.length, id).toBeGreaterThan(0);
    }
  });

  it("suggests at least as many spells as the level-1 known counts", () => {
    for ( const [id, profile] of Object.entries(QUICK_BUILD) ) {
      const cantrips = DEFAULT_CANTRIPS[id] ?? 0;
      const spells = DEFAULT_LEVEL1_SPELLS[id] ?? 0;
      if ( cantrips ) expect(profile.cantrips?.length ?? 0, `${id} cantrips`).toBeGreaterThanOrEqual(cantrips);
      if ( spells ) expect(profile.spells?.length ?? 0, `${id} spells`).toBeGreaterThanOrEqual(spells);
    }
  });

  it("only points miList at the three Magic Initiate lists", () => {
    for ( const [id, profile] of Object.entries(QUICK_BUILD) ) {
      if ( profile.miList ) expect(["cleric", "druid", "wizard"], id).toContain(profile.miList);
    }
  });

  it("keeps the MI suggestions within the lists' shape", () => {
    for ( const [list, sugg] of Object.entries(MI_SPELL_SUGGESTIONS) ) {
      expect(["cleric", "druid", "wizard"]).toContain(list);
      expect(sugg.cantrips.length).toBeGreaterThanOrEqual(2);
      expect(sugg.spells.length).toBeGreaterThanOrEqual(1);
    }
  });
});

/* -------------------------------------------- */
/*  Ability placement                           */
/* -------------------------------------------- */

describe("assignStandardArray", () => {
  it("lays the array onto the priorities highest-first", () => {
    const state = new CreatorState(null);
    assignStandardArray(state, QUICK_BUILD.barbarian.abilities);
    expect(state.abilityMethod).toBe("standard-array");
    const scores = state.resolvedScores();
    expect(scores.str).toBe(15);
    expect(scores.con).toBe(14);
    expect(scores.int).toBe(8);
    expect(abilitiesComplete(state)).toBe(true);
  });

  it("ignores junk keys without breaking the rest", () => {
    const state = new CreatorState(null);
    assignStandardArray(state, ["nope", ...QUICK_BUILD.rogue.abilities]);
    expect(state.resolvedScores().dex).toBe(14); // shifted one slot by the junk entry
    expect(state.assignment.nope).toBeUndefined();
  });
});

describe("allocateOriginAsi", () => {
  const sageAsi = () => ({ id: "x", points: 3, canAllocate: true, cap: 2, fixed: {}, locked: ["str", "dex", "cha"] });

  it("spends +2/+1 down the unlocked priorities", () => {
    const state = new CreatorState(null);
    state.originAsi.background = sageAsi();
    allocateOriginAsi(state, "background", QUICK_BUILD.wizard.abilities);
    expect(state.originAbilities.background).toEqual({ str: 0, dex: 0, con: 1, int: 2, wis: 0, cha: 0 });
    const spent = ABILITIES.reduce((sum, k) => sum + state.originAbilities.background[k], 0);
    expect(spent).toBe(3); // the background step's pointsRemaining === 0
  });

  it("is a no-op for an origin with no increase", () => {
    const state = new CreatorState(null);
    state.originAsi.background = null;
    state.originAbilities.background.str = 2; // stale allocation from a previous background
    allocateOriginAsi(state, "background", QUICK_BUILD.fighter.abilities);
    expect(state.originAbilities.background).toEqual({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 });
  });

  // The 2014 Half-Elf: fixed +2 CHA plus 2 free points at cap 1. The fixed bump counts against the
  // cap, so Charisma has no headroom left and the points go to the next two priorities.
  it("spends a 2014 species' budget without over-filling its fixed ability", () => {
    const state = new CreatorState(null);
    state.originAsi.species = {
      id: "he", points: 2, canAllocate: true, cap: 1, fixed: { cha: 2 }, locked: []
    };
    allocateOriginAsi(state, "species", QUICK_BUILD.bard.abilities); // cha, dex, con, …
    expect(state.originAbilities.species).toEqual({ str: 0, dex: 1, con: 1, int: 0, wis: 0, cha: 0 });
    expect(state.originDeltas("species")).toEqual({ dex: 1, con: 1, cha: 2 });
  });

  // Hill Dwarf: +2 CON / +1 WIS outright, no budget. Nothing to allocate; the increase still
  // reaches the actor through the advancement itself.
  it("leaves a purely fixed species increase alone", () => {
    const state = new CreatorState(null);
    state.originAsi.species = {
      id: "hd", points: 0, canAllocate: false, cap: 2, fixed: { con: 2, wis: 1 }, locked: []
    };
    allocateOriginAsi(state, "species", QUICK_BUILD.fighter.abilities);
    expect(state.originAbilities.species).toEqual({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 });
    expect(state.originDeltas("species")).toEqual({ con: 2, wis: 1 });
  });
});

/* -------------------------------------------- */
/*  Choice picking                              */
/* -------------------------------------------- */

describe("choosePicks", () => {
  const skillReq = (over = {}) => ({
    type: "Trait", count: 2, isExpertise: false,
    options: ["acr", "ath", "his", "prc", "ste"].map(c => ({ key: `skills:${c}`, label: c })),
    ...over
  });

  it("takes the profile's skills in preference order", () => {
    const picks = choosePicks(skillReq(), QUICK_BUILD.fighter);
    expect(picks).toEqual(["skills:ath", "skills:prc"]);
  });

  it("skips disabled preferences and backfills to the count", () => {
    const req = skillReq();
    req.options.find(o => o.key === "skills:ath").disabled = true;
    const picks = choosePicks(req, QUICK_BUILD.fighter);
    expect(picks).toHaveLength(2);
    expect(picks).toContain("skills:prc");
    expect(picks).not.toContain("skills:ath");
  });

  it("never double-spends a skill two sources both offer in one pass", () => {
    const taken = new Set();
    const first = choosePicks(skillReq({ count: 1 }), QUICK_BUILD.fighter, taken);
    const second = choosePicks(skillReq({ count: 1 }), QUICK_BUILD.fighter, taken);
    expect(first).toEqual(["skills:ath"]);
    expect(second).toEqual(["skills:prc"]);
  });

  it("lets expertise re-pick a proficient skill despite the taken set", () => {
    const taken = new Set(["skills:ste"]);
    const req = {
      type: "Trait", count: 1, isExpertise: true,
      options: [{ key: "skills:ste", label: "Stealth" }]
    };
    expect(choosePicks(req, QUICK_BUILD.rogue, taken)).toEqual(["skills:ste"]);
  });

  it("matches weapon masteries by key suffix", () => {
    const req = {
      type: "Trait", count: 2, isExpertise: false,
      options: [
        { key: "weapon:sim:dagger", label: "Dagger" },
        { key: "weapon:mar:greataxe", label: "Greataxe" },
        { key: "weapon:sim:handaxe", label: "Handaxe" }
      ]
    };
    expect(choosePicks(req, QUICK_BUILD.barbarian)).toEqual(["weapon:mar:greataxe", "weapon:sim:handaxe"]);
  });

  it("prefers the recommended spellcasting ability", () => {
    const req = {
      type: "SpellAbility", count: 1,
      options: [{ key: "int", label: "Intelligence" }, { key: "wis", label: "Wisdom", recommended: true }]
    };
    expect(choosePicks(req, {})).toEqual(["wis"]);
  });

  it("picks Medium for a size choice", () => {
    const req = {
      type: "Size", count: 1,
      options: [{ key: "sm", label: "Small" }, { key: "med", label: "Medium" }]
    };
    expect(choosePicks(req, {})).toEqual(["med"]);
  });

  it("matches ItemChoice features by label, profile first then the global order", () => {
    const options = [
      { key: "u1", label: "Alert" }, { key: "u2", label: "Defense" }, { key: "u3", label: "Skilled" }
    ];
    expect(choosePicks({ type: "ItemChoice", count: 1, options }, QUICK_BUILD.fighter)).toEqual(["u2"]);
    expect(choosePicks({ type: "ItemChoice", count: 1, options }, QUICK_BUILD.rogue))
      .toEqual([options.find(o => o.label === FEATURE_PREFERENCES[0]).key]);
  });

  it("returns nothing when every option is disabled", () => {
    const req = skillReq();
    for ( const o of req.options ) o.disabled = true;
    expect(choosePicks(req, QUICK_BUILD.fighter)).toEqual([]);
  });
});

/* -------------------------------------------- */
/*  Spell picking                               */
/* -------------------------------------------- */

describe("pickSpells", () => {
  const pool = ["Bless", "Cure Wounds", "Guiding Bolt", "Shield of Faith"].map((name, i) => ({
    uuid: `u${i}`, id: `i${i}`, name, img: "x.webp", level: 1
  }));

  it("takes named preferences first, then backfills from the top", () => {
    const picks = pickSpells(pool, ["guiding bolt"], 2);
    expect(picks.map(s => s.name)).toEqual(["Guiding Bolt", "Bless"]);
    expect(picks[0]).toEqual({ uuid: "u2", id: "i2", name: "Guiding Bolt", img: "x.webp", level: 1 });
  });

  it("caps at max and never duplicates", () => {
    const picks = pickSpells(pool, ["Bless", "Bless", "Cure Wounds"], 2);
    expect(picks.map(s => s.name)).toEqual(["Bless", "Cure Wounds"]);
  });

  it("returns empty for a non-caster (max 0)", () => {
    expect(pickSpells(pool, ["Bless"], 0)).toEqual([]);
  });
});

/* -------------------------------------------- */
/*  Background pick                             */
/* -------------------------------------------- */

describe("pickBackground", () => {
  const card = (identifier, name, uuid) => ({ identifier, name, uuid });
  const sourceWith = (cards, asiByUuid = {}) => ({
    backgrounds: () => cards,
    abilityScoreIncrease: async uuid => asiByUuid[uuid] ?? null
  });

  it("returns the first installed suggestion by identifier", async () => {
    const cards = [card("criminal", "Criminal", "c1"), card("soldier", "Soldier", "s1")];
    const hit = await pickBackground(sourceWith(cards), QUICK_BUILD.fighter);
    expect(hit.identifier).toBe("soldier");
  });

  it("falls back to a slugified name when identifiers are missing", async () => {
    const cards = [card("", "Soldier", "s1")];
    const hit = await pickBackground(sourceWith(cards), QUICK_BUILD.fighter);
    expect(hit.uuid).toBe("s1");
  });

  it("scores by alignment with the top priorities when no suggestion matches", async () => {
    const cards = [card("sage", "Sage", "sg"), card("guard", "Guard", "gd")];
    const asi = {
      sg: { points: 3, cap: 2, fixed: {}, locked: ["str", "dex", "cha"] },   // con/int/wis open
      gd: { points: 3, cap: 2, fixed: {}, locked: ["dex", "con", "cha"] }    // str/int/wis open
    };
    // Fighter wants str, con, dex: Guard scores 3 (str), Sage scores 2 (con).
    const hit = await pickBackground(sourceWith(cards, asi), QUICK_BUILD.fighter);
    expect(hit.identifier).toBe("guard");
  });

  it("is deterministic (alphabetical) when nothing scores", async () => {
    const cards = [card("zeta", "Zeta", "z"), card("alpha", "Alpha", "a")];
    const hit = await pickBackground(sourceWith(cards), QUICK_BUILD.fighter);
    expect(hit.identifier).toBe("alpha");
  });

  it("returns null when no backgrounds are installed", async () => {
    expect(await pickBackground(sourceWith([]), QUICK_BUILD.fighter)).toBeNull();
  });
});

/* -------------------------------------------- */
/*  Full engine over the dnd5e 5.3.3 fixtures   */
/* -------------------------------------------- */

/** Minimal feat docs so the fixtures' ItemChoice pools resolve (no advancements of their own). */
const flatFeat = (uuid, name) => [uuid, {
  _id: uuid.split(".").pop(), name, type: "feat", img: "f.webp",
  system: { identifier: name.toLowerCase().replace(/\s+/g, "-"), advancement: [] }
}];
const EXTRA_DOCS = Object.fromEntries([
  flatFeat(UUID.alert, "Alert"),
  flatFeat(UUID.savageAttacker, "Savage Attacker"),
  flatFeat(UUID.skilled, "Skilled"),
  flatFeat(UUID.archery, "Archery"),
  flatFeat(UUID.defense, "Defense"),
  flatFeat(UUID.greatWeapon, "Great Weapon Fighting"),
  flatFeat(UUID.twoWeapon, "Two-Weapon Fighting")
]);

const fighterCard = { uuid: UUID.fighter, name: "Fighter", identifier: "fighter", img: "c.webp" };
const humanCard = { uuid: UUID.human, name: "Human", identifier: "human", img: "h.webp" };
const sageCard = { uuid: UUID.sage, name: "Sage", identifier: "sage", img: "s.webp" };
const SAGE_ASI = {
  id: "3O61L5uTy5jRCqJb", points: 3, canAllocate: true, cap: 2, fixed: {}, locked: ["str", "dex", "cha"]
};

function makeSource({ backgrounds = [sageCard], species = [humanCard] } = {}) {
  const all = [fighterCard, ...species, ...backgrounds];
  return {
    classes: () => [fighterCard],
    species: () => species,
    backgrounds: () => backgrounds,
    card: uuid => all.find(c => c.uuid === uuid) ?? null,
    // These fixtures declare no rules edition, which is the "offer everything" case — Quick Build
    // scopes its origin picks to the class's edition and must not narrow when there isn't one.
    rulesOf: () => null,
    abilityScoreIncrease: async uuid => (uuid === UUID.sage ? SAGE_ASI : null)
  };
}

const spellCard = (name, i, level) => ({ uuid: `sp-${level}-${i}`, id: `sp${level}${i}`, name, img: "sp.webp", level });
const makeSpells = () => ({
  forClass: async () => ({ isSpellcaster: false }),
  forSpellList: async () => ({
    cantrips: ["Guidance", "Light", "Sacred Flame", "Thaumaturgy"].map((n, i) => spellCard(n, i, 0)),
    level1: ["Bless", "Cure Wounds", "Healing Word"].map((n, i) => spellCard(n, i, 1))
  })
});
const makeEquipment = () => {
  const calls = [];
  return { calls, load: async (state, source) => { calls.push([state, source]); return {}; } };
};

function makeCtx(overrides = {}) {
  const state = new CreatorState(null);
  state.classUuid = UUID.fighter;
  return { state, source: makeSource(), spells: makeSpells(), equipment: makeEquipment(), ...overrides };
}

describe("applyQuickBuild (fighter + sage + human fixtures)", () => {
  beforeEach(() => {
    installFoundryShims();
    globalThis.fromUuid = makeFromUuid(EXTRA_DOCS);
  });

  it("fills every step's completion gate in one call", async () => {
    const ctx = makeCtx();
    const result = await applyQuickBuild(ctx, { rng: () => 0 });
    const { state } = ctx;

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);

    // Class step: standard array in fighter priority order.
    expect(abilitiesComplete(state)).toBe(true);
    expect(state.resolvedScores()).toEqual({ str: 15, con: 14, dex: 13, wis: 12, cha: 10, int: 8 });

    // Background step: Sage (the only one installed) with its +2/+1 fully allocated.
    expect(state.backgroundUuid).toBe(UUID.sage);
    expect(state.originAbilities.background).toEqual({ str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 });

    // Species + details steps.
    expect(state.speciesUuid).toBe(UUID.human);
    expect(state.details.name.trim().length).toBeGreaterThan(0);

    // Choices step: every non-spell requirement filled.
    expect(choicesComplete(state.choiceCache)).toBe(true);
    expect(state.advChoices.class["UaSYMl2io5kbXNOY#0"]).toEqual(["skills:ath", "skills:prc"]);
    expect(state.advChoices.class.EmTANp6x6GfXFTmU).toEqual([UUID.defense]); // Fighting Style: Defense
    expect(state.advChoices.species.dLxv96vt2B2KOEe2).toEqual(["med"]);      // Size: Medium
    expect(state.advChoices.species.KB8IQLwyuL6SOFnv).toEqual([UUID.skilled]); // Versatile: Skilled

    // Spells step: fighter is no caster, so the gate closes with nothing picked.
    expect(state.spellInfo).toEqual({ isSpellcaster: false, maxCantrips: 0, maxSpells: 0 });
    expect(state.selectedCantrips).toEqual([]);

    // Feat-spells step: Sage's Magic Initiate auto-filled (cleric list, 2 cantrips + 1 spell).
    const bucket = state.featSpells[`background:${UUID.magicInitiate}`];
    expect(bucket.list).toBe("cleric");
    expect(bucket.ability).toBe("int"); // fighter has no casting ability; first offered wins
    expect(bucket.cantrips).toHaveLength(2);
    expect(bucket.spells).toHaveLength(1);
    expect(featSpellsStep.isComplete(ctx.state)).toBe(true);

    // Equipment step: default option, seeded via the same load the step uses.
    expect(state.equipmentVisited).toBe(true);
    expect(ctx.equipment.calls.length).toBeGreaterThan(0);
  });

  it("prefers the MI suggestions for the chosen list", async () => {
    const ctx = makeCtx();
    await applyQuickBuild(ctx, { rng: () => 0 });
    const bucket = ctx.state.featSpells[`background:${UUID.magicInitiate}`];
    // Suggestions: Guidance + Sacred Flame cantrips, Bless the level-1 pick.
    expect(bucket.cantrips).toEqual(["sp-0-0", "sp-0-2"]);
    expect(bucket.spells).toEqual(["sp-1-0"]);
  });

  it("is deterministic for a fixed rng (names aside)", async () => {
    const a = makeCtx();
    const b = makeCtx();
    await applyQuickBuild(a, { rng: () => 0 });
    await applyQuickBuild(b, { rng: () => 0 });
    expect(a.state.advChoices).toEqual(b.state.advChoices);
    expect(a.state.featSpells).toEqual(b.state.featSpells);
    expect(a.state.assignment).toEqual(b.state.assignment);
    expect(a.state.backgroundUuid).toBe(b.state.backgroundUuid);
    expect(a.state.speciesUuid).toBe(b.state.speciesUuid);
  });

  it("re-running never leaks picks from the previous fill", async () => {
    const ctx = makeCtx();
    await applyQuickBuild(ctx, { rng: () => 0 });
    ctx.state.advChoices.class["stale#0"] = ["skills:xyz"];
    ctx.state.featSpells["background:stale"] = { list: "wizard", ability: "int", cantrips: [], spells: [] };
    await applyQuickBuild(ctx, { rng: () => 0 });
    expect(ctx.state.advChoices.class["stale#0"]).toBeUndefined();
    expect(ctx.state.featSpells["background:stale"]).toBeUndefined();
  });

  it("degrades to warnings when content is missing, without throwing", async () => {
    const ctx = makeCtx({ source: { ...makeSource({ backgrounds: [], species: [] }) } });
    const result = await applyQuickBuild(ctx, { rng: () => 0 });
    expect(result.ok).toBe(false);
    expect(result.warnings).toContain("no-backgrounds");
    expect(result.warnings).toContain("no-species");
    // Everything else still filled.
    expect(abilitiesComplete(ctx.state)).toBe(true);
    expect(ctx.state.details.name.trim().length).toBeGreaterThan(0);
    expect(ctx.state.equipmentVisited).toBe(true);
  });

  it("refuses without a class", async () => {
    const ctx = makeCtx();
    ctx.state.classUuid = null;
    const result = await applyQuickBuild(ctx, { rng: () => 0 });
    expect(result.ok).toBe(false);
    expect(result.warnings).toContain("no-class");
  });
});
