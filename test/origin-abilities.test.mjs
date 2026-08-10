import { describe, it, expect, beforeEach } from "vitest";
import {
  asiComplete, asiContext, asiHandle, asiHint, asiSummary, increasedAbilities
} from "../scripts/steps/origin-abilities-panel.mjs";
import { CreatorState } from "../scripts/state/creator-state.mjs";
import { originStep } from "../scripts/steps/origin-step.mjs";
import { SourceIndex } from "../scripts/data/source-index.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * The ability-increase panel is shared by the Species and Background steps because *which* origin
 * grants the increase is an edition question:
 *   - 2024 — the background grants 3 points at cap 2, nothing fixed. The species grants nothing.
 *   - 2014 — the species grants the increase; the background grants nothing.
 * and the 2014 species come in three shapes, all of which have to work: a purely fixed increase
 * (Hill Dwarf's +2 CON / +1 WIS, nothing to decide), a mixed one (Half-Elf's fixed +2 CHA plus
 * 2 free points at cap 1), and Tasha's "custom origin" (Witchlight's Fairy and Harengon: 3 free
 * points at cap 2 across *any* ability, nothing fixed or locked).
 */

beforeEach(() => installFoundryShims());

/* The three real configurations, as `SourceIndex#abilityScoreIncrease` flattens them. */
const SAGE = { id: "bg", points: 3, canAllocate: true, cap: 2, fixed: {}, locked: ["str", "dex", "cha"] };
const HILL_DWARF = { id: "hd", points: 0, canAllocate: false, cap: 2, fixed: { con: 2, wis: 1 }, locked: [] };
const HALF_ELF = { id: "he", points: 2, canAllocate: true, cap: 1, fixed: { cha: 2 }, locked: [] };
// Tasha's custom origin, as Witchlight's Fairy and Harengon ship it: dnd5e writes every ability
// into `fixed`, zeroed, so this is a pure 3-point budget across all six.
const FAIRY = {
  id: "fy", points: 3, canAllocate: true, cap: 2, locked: [],
  fixed: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }
};

/** A state with 8s across the board and one origin's increase in play. */
function stateWith(source, asi) {
  const state = new CreatorState(null);
  state.originAsi[source] = asi;
  return state;
}

const row = (ctx, key) => ctx.rows.find(r => r.key === key);
const inc = (state, source, key) => asiHandle("origin-ability-inc", { dataset: { ability: key } }, state, source);
const dec = (state, source, key) => asiHandle("origin-ability-dec", { dataset: { ability: key } }, state, source);

/* -------------------------------------------- */
/*  Reading the advancement                     */
/* -------------------------------------------- */

describe("SourceIndex#abilityScoreIncrease", () => {
  // The `system.advancement` array as the packs store it. Passing the doc in bypasses `fromUuid`.
  const doc = (...advancement) => ({ system: { advancement } });
  const asiAdv = (configuration, extra = {}) => ({
    _id: "adv-1", type: "AbilityScoreImprovement", level: 0, configuration, ...extra
  });
  const read = (d, uuid = `u-${Math.random()}`) => new SourceIndex().abilityScoreIncrease(uuid, d);

  it("keeps a purely fixed increase (2014 Hill Dwarf) as read-only", async () => {
    const asi = await read(doc(asiAdv({ points: 0, fixed: { con: 2, wis: 1 }, cap: 2, locked: [] })));
    expect(asi).toMatchObject({ id: "adv-1", points: 0, canAllocate: false, fixed: { con: 2, wis: 1 } });
  });

  it("keeps a mixed increase (2014 Half-Elf) allocatable", async () => {
    const asi = await read(doc(asiAdv({ points: 2, fixed: { cha: 2 }, cap: 1, locked: [] })));
    expect(asi).toMatchObject({ points: 2, canAllocate: true, cap: 1, fixed: { cha: 2 } });
  });

  it("keeps a pure point budget (2024 background) allocatable", async () => {
    const asi = await read(doc(asiAdv({ points: 3, fixed: {}, cap: 2, locked: ["str"] })));
    expect(asi).toMatchObject({ points: 3, canAllocate: true, cap: 2, locked: ["str"] });
  });

  it("returns null when the advancement raises nothing, or there is none at all", async () => {
    // dnd5e writes every ability into `fixed`, zeroed, so an all-zero map is "no increase".
    const zeroed = { points: 0, fixed: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, cap: 2, locked: [] };
    expect(await read(doc(asiAdv(zeroed)))).toBeNull();
    expect(await read(doc({ _id: "t", type: "Trait", level: 1, configuration: {} }))).toBeNull();
    expect(await read(doc())).toBeNull();
  });

  it("prefers the level-0 advancement over a later one", async () => {
    const later = asiAdv({ points: 2, fixed: {}, cap: 2, locked: [] }, { _id: "adv-4", level: 4 });
    const origin = asiAdv({ points: 0, fixed: { con: 2 }, cap: 2, locked: [] });
    expect(await read(doc(later, origin))).toMatchObject({ id: "adv-1", canAllocate: false });
  });
});

/* -------------------------------------------- */
/*  No increase at all                          */
/* -------------------------------------------- */

describe("an origin that grants no increase", () => {
  // A 2014 background and a 2024 species both land here. `null` means "resolved, grants nothing";
  // `undefined` means "not resolved yet" — neither may block Next, and neither renders an aside.
  it.each([["resolved as none", null], ["not yet resolved", undefined]])("%s: complete, no panel", (_label, asi) => {
    const state = stateWith("background", asi);
    expect(asiComplete(state, "background")).toBe(true);
    expect(asiHint(state, "background")).toBeNull();
    expect(asiSummary(state, "background")).toBe("");
    expect(asiContext(state, "background")).toBeNull();
    expect(state.originDeltas("background")).toEqual({});
  });
});

/* -------------------------------------------- */
/*  Fixed only (2014 Hill Dwarf)                */
/* -------------------------------------------- */

describe("a purely fixed species increase", () => {
  it("is complete on selection alone and renders read-only", () => {
    const state = stateWith("species", HILL_DWARF);
    expect(asiComplete(state, "species")).toBe(true);
    expect(asiHint(state, "species")).toBeNull();

    const ctx = asiContext(state, "species");
    expect(ctx.canAllocate).toBe(false);
    expect(ctx.rows.every(r => r.locked)).toBe(true);
    expect(ctx.rows.every(r => !r.canInc && !r.canDec)).toBe(true);
  });

  it("shows the fixed bumps on top of the base scores", () => {
    const state = stateWith("species", HILL_DWARF);
    expect(row(asiContext(state, "species"), "con")).toMatchObject({ bonus: 2, bonusLabel: "+2", total: 10 });
    expect(row(asiContext(state, "species"), "wis")).toMatchObject({ bonus: 1, bonusLabel: "+1", total: 9 });
    expect(row(asiContext(state, "species"), "str")).toMatchObject({ bonus: 0, bonusLabel: "", total: 8 });
    expect(asiSummary(state, "species")).toBe("+2 CON · +1 WIS");
  });

  it("still reaches the actor: the deltas carry the fixed part", () => {
    const state = stateWith("species", HILL_DWARF);
    expect(state.originDeltas("species")).toEqual({ con: 2, wis: 1 });
  });

  it("ignores stepper actions", () => {
    const state = stateWith("species", HILL_DWARF);
    inc(state, "species", "str");
    expect(state.originAbilities.species.str).toBe(0);
  });
});

/* -------------------------------------------- */
/*  Fixed + allocation (2014 Half-Elf)          */
/* -------------------------------------------- */

describe("a mixed species increase (Half-Elf)", () => {
  // dnd5e's own flow counts `configuration.fixed` inside `value.assignments` and gates on
  // `assignment < cap`, so the fixed +2 CHA already exceeds the cap of 1 and Charisma is closed.
  // Allowing a point there would offer the player something the system then refuses to apply.
  it("closes the fixed ability, whose bump already exceeds the cap", () => {
    const state = stateWith("species", HALF_ELF);
    const cha = row(asiContext(state, "species"), "cha");
    expect(cha).toMatchObject({ bonus: 2, canInc: false });

    inc(state, "species", "cha");
    expect(state.originAbilities.species.cha).toBe(0);
  });

  it("spends its two points one apiece and then blocks", () => {
    const state = stateWith("species", HALF_ELF);
    expect(asiComplete(state, "species")).toBe(false);
    expect(asiHint(state, "species")).toContain("step.species.hintPoints");

    inc(state, "species", "dex");
    expect(asiComplete(state, "species")).toBe(false);
    inc(state, "species", "con");
    expect(asiComplete(state, "species")).toBe(true);

    // Budget spent: nothing else can rise, and DEX is at its cap of 1 regardless.
    const ctx = asiContext(state, "species");
    expect(ctx.remaining).toBe(0);
    expect(ctx.rows.every(r => !r.canInc)).toBe(true);
    inc(state, "species", "int");
    expect(state.originAbilities.species.int).toBe(0);

    expect(state.originDeltas("species")).toEqual({ dex: 1, con: 1, cha: 2 });
    expect(asiSummary(state, "species")).toBe("+1 DEX · +1 CON · +2 CHA");
  });

  it("caps each allocated ability at 1 even with points left", () => {
    const state = stateWith("species", HALF_ELF);
    inc(state, "species", "dex");
    inc(state, "species", "dex");     // second point refused: dex is at cap
    expect(state.originAbilities.species.dex).toBe(1);
    expect(asiContext(state, "species").remaining).toBe(1);
  });

  it("gives points back on decrease, but never below zero", () => {
    const state = stateWith("species", HALF_ELF);
    inc(state, "species", "dex");
    dec(state, "species", "dex");
    dec(state, "species", "dex");
    expect(state.originAbilities.species.dex).toBe(0);
    expect(asiContext(state, "species").remaining).toBe(2);
  });

  it("resets the whole allocation, keeping the fixed part", () => {
    const state = stateWith("species", HALF_ELF);
    inc(state, "species", "dex");
    inc(state, "species", "con");
    asiHandle("origin-ability-reset", null, state, "species");
    expect(state.originAbilities.species).toEqual({ str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 });
    expect(state.originDeltas("species")).toEqual({ cha: 2 });
  });
});

/* -------------------------------------------- */
/*  Tasha's custom origin (Fairy / Harengon)    */
/* -------------------------------------------- */

describe("a custom-origin species increase", () => {
  it("opens all six abilities and spends +2/+1", () => {
    const state = stateWith("species", FAIRY);
    const ctx = asiContext(state, "species");
    expect(ctx.rows.every(r => !r.locked && r.canInc)).toBe(true);
    expect(ctx.remaining).toBe(3);
    expect(ctx.rows.every(r => r.bonus === 0)).toBe(true);   // an all-zero `fixed` shows no bonus

    inc(state, "species", "dex");
    inc(state, "species", "dex");
    inc(state, "species", "con");
    expect(asiComplete(state, "species")).toBe(true);
    expect(state.originDeltas("species")).toEqual({ dex: 2, con: 1 });
  });

  // Malformed content — a budget locked out of every ability — must not strand the player on a
  // step whose Next button can never be satisfied.
  it("does not block Next on a budget with nowhere to go", () => {
    const state = stateWith("species", { ...FAIRY, locked: ["str", "dex", "con", "int", "wis", "cha"] });
    expect(asiContext(state, "species").rows.every(r => r.locked)).toBe(true);
    expect(asiComplete(state, "species")).toBe(true);
    expect(asiHint(state, "species")).toBeNull();
  });

  it("holds each ability to the cap of 2", () => {
    const state = stateWith("species", FAIRY);
    inc(state, "species", "dex");
    inc(state, "species", "dex");
    inc(state, "species", "dex");     // third refused: dex is at cap
    expect(state.originAbilities.species.dex).toBe(2);
    expect(asiComplete(state, "species")).toBe(false);
  });
});

/* -------------------------------------------- */
/*  2024 background — unchanged behaviour       */
/* -------------------------------------------- */

describe("a 2024 background increase", () => {
  it("keeps the +2/+1 across three unlocked abilities", () => {
    const state = stateWith("background", SAGE);
    const ctx = asiContext(state, "background");
    expect(ctx.canAllocate).toBe(true);
    expect(ctx.remaining).toBe(3);
    // str/dex/cha are locked out by the Sage's configuration.
    expect(ctx.rows.filter(r => r.locked).map(r => r.key)).toEqual(["str", "dex", "cha"]);

    inc(state, "background", "int");
    inc(state, "background", "int");
    inc(state, "background", "con");
    expect(asiComplete(state, "background")).toBe(true);
    expect(state.originDeltas("background")).toEqual({ con: 1, int: 2 });

    // A locked ability never takes a point even with budget spare.
    asiHandle("origin-ability-reset", null, state, "background");
    inc(state, "background", "str");
    expect(state.originAbilities.background.str).toBe(0);
  });

  it("lists the abilities the increase can raise, for the grid filter", () => {
    expect(increasedAbilities(SAGE)).toEqual(["con", "int", "wis"]);
    expect(increasedAbilities(HALF_ELF)).toEqual(["str", "dex", "con", "int", "wis", "cha"]);
    expect(increasedAbilities(null)).toEqual([]);
  });
});

/* -------------------------------------------- */
/*  Merged view + reset                         */
/* -------------------------------------------- */

describe("state-level rollup", () => {
  it("merges both origins and attributes each bonus to its source", () => {
    const state = new CreatorState(null);
    state.originAsi.species = HALF_ELF;
    state.originAsi.background = SAGE;
    inc(state, "species", "con");
    inc(state, "background", "con");

    expect(state.abilityDeltas()).toEqual({
      cha: { total: 2, sources: [{ source: "species", bonus: 2 }] },
      con: { total: 2, sources: [{ source: "species", bonus: 1 }, { source: "background", bonus: 1 }] }
    });
  });

  // Every path that drops an origin goes through `resetSourceChoices` — including the class step's
  // `dropOffEditionOrigins`, which swaps a 2024 class for a 2014 one and used to leave the
  // discarded background's increase showing on Review.
  it("forgets an origin's increase when that selection is cleared", () => {
    const state = stateWith("species", HALF_ELF);
    inc(state, "species", "dex");
    state.resetSourceChoices("species");
    expect(state.originAsi.species).toBeUndefined();
    expect(state.originAbilities.species.dex).toBe(0);
    expect(state.abilityDeltas()).toEqual({});
  });

  it("leaves the other origin's allocation alone", () => {
    const state = new CreatorState(null);
    state.originAsi.background = SAGE;
    inc(state, "background", "int");
    state.resetSourceChoices("species");
    expect(state.originDeltas("background")).toEqual({ int: 1 });
  });
});

/* -------------------------------------------- */
/*  Wiring into the species step                */
/* -------------------------------------------- */

describe("the species step composes the panel", () => {
  const speciesStep = originStep({
    id: "species", icon: "i", labelKey: "step.species.label", field: "speciesUuid",
    hintKey: "step.species.hint", asiSource: "species",
    cards: () => [{ uuid: "sp-1", name: "Half-Elf" }]
  });
  const source = { card: uuid => (uuid === "sp-1" ? { uuid, name: "Half-Elf" } : null) };

  it("blocks Next while a species' points are unspent", () => {
    const state = new CreatorState(null);
    expect(speciesStep.isComplete(state)).toBe(false);          // nothing picked

    state.speciesUuid = "sp-1";
    state.originAsi.species = HALF_ELF;
    expect(speciesStep.isComplete(state)).toBe(false);
    expect(speciesStep.incompleteHint(state)).toContain("step.species.hintPoints");

    inc(state, "species", "dex");
    inc(state, "species", "con");
    expect(speciesStep.isComplete(state)).toBe(true);
    expect(speciesStep.incompleteHint(state)).toBeNull();
    expect(speciesStep.summary(state, source)).toBe("Half-Elf · +1 DEX · +1 CON · +2 CHA");
  });

  it("passes Next straight through for a species with no increase", () => {
    const state = new CreatorState(null);
    state.speciesUuid = "sp-1";
    state.originAsi.species = null;
    expect(speciesStep.isComplete(state)).toBe(true);
    expect(speciesStep.summary(state, source)).toBe("Half-Elf");
  });

  // A step configured without `asiSource` must behave exactly as it did before the panel existed.
  it("leaves a panel-less origin step untouched", () => {
    const plain = originStep({
      id: "species", icon: "i", labelKey: "l", field: "speciesUuid", cards: () => []
    });
    const state = new CreatorState(null);
    state.speciesUuid = "sp-1";
    state.originAsi.species = HALF_ELF;      // present, but this step doesn't own it
    expect(plain.isComplete(state)).toBe(true);
    expect(plain.incompleteHint(state)).toBeNull();
    expect(plain.summary(state, source)).toBe("Half-Elf");
  });
});
