import { beforeEach, describe, expect, it } from "vitest";
import {
  abilitiesComplete, abilitiesContext, abilitiesHandle
} from "../scripts/steps/abilities-step.mjs";
import { CreatorState } from "../scripts/state/creator-state.mjs";
import { ABILITIES, MODULE_ID, SETTINGS } from "../scripts/config.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * Manual ability entry — the home rule that lets a player type the six numbers in.
 *
 * The risk this file guards is not the arithmetic (there isn't any) but the *gate*. Manual entry
 * answers to none of the economies the other three methods enforce, so the two things that must
 * never slip are: it is unreachable unless the GM turned it on, and a build that used it keeps
 * working — under some other method — if the GM later turns it off. A world that switched the rule
 * off and found characters still being typed in would have no way to tell.
 *
 * The clamp is the third group: an input's `min`/`max` stop the steppers, not a paste, so the
 * bounds have to hold on the value that actually reaches the state.
 */

/** Stand-in for the element the shell hands a handler, carrying whatever the markup would. */
const el = (data = {}, value) => ({ dataset: data, value });

const setRule = on => game.settings.set(MODULE_ID, SETTINGS.manualAbilities, on);

/** A state on the manual method with the given scores; anything unnamed stays empty. */
function manualState(scores = {}) {
  const state = new CreatorState(null);
  state.abilityMethod = "manual";
  Object.assign(state.manualScores, scores);
  return state;
}

const filled = { str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 };

beforeEach(() => {
  installFoundryShims();
  setRule(true);
});

describe("the GM's switch", () => {
  it("is off by default, and the method isn't offered", () => {
    installFoundryShims();
    const ids = abilitiesContext(new CreatorState(null)).methods.map(m => m.id);
    expect(ids).toEqual(["point-buy", "standard-array", "roll"]);
  });

  it("offers the method once the rule is on", () => {
    const ids = abilitiesContext(new CreatorState(null)).methods.map(m => m.id);
    expect(ids).toEqual(["point-buy", "standard-array", "roll", "manual"]);
  });

  it("refuses a switch to a method this world doesn't offer", async () => {
    setRule(false);
    const state = new CreatorState(null);
    await abilitiesHandle("ability-method", el({ method: "manual" }), state);
    expect(state.abilityMethod).toBe("point-buy");
  });

  it("falls a build back to point-buy when the rule is withdrawn under it", () => {
    const state = manualState(filled);
    setRule(false);
    const ctx = abilitiesContext(state);
    expect(ctx.method).toBe("point-buy");
    expect(ctx.isManual).toBe(false);
    // Repaired on the state too, so the scores the character is built from are the ones on screen.
    expect(state.abilityMethod).toBe("point-buy");
    expect(state.resolvedScores().str).toBe(8);
  });

  it("does not call a withdrawn manual set complete", () => {
    const state = manualState(filled);
    expect(abilitiesComplete(state)).toBe(true);
    setRule(false);
    // Point-buy with nothing spent — not a finished set of scores.
    expect(abilitiesComplete(state)).toBe(false);
  });
});

describe("typing scores in", () => {
  it("is finished only once all six boxes hold a score", () => {
    expect(abilitiesComplete(manualState())).toBe(false);
    expect(abilitiesComplete(manualState({ str: 16, dex: 14 }))).toBe(false);
    expect(abilitiesComplete(manualState(filled))).toBe(true);
  });

  it("stores what was typed, and shows the modifier for it", async () => {
    const state = manualState();
    await abilitiesHandle("ability-set", el({ ability: "str" }, "17"), state);
    expect(state.manualScores.str).toBe(17);
    const row = abilitiesContext(state).rows.find(r => r.key === "str");
    expect(row.value).toBe(17);
    expect(row.modifier).toBe("+3");
    expect(row.assigned).toBe(true);
  });

  it("clears a box back to empty rather than to a number nobody typed", async () => {
    const state = manualState({ str: 17 });
    await abilitiesHandle("ability-set", el({ ability: "str" }, ""), state);
    expect(state.manualScores.str).toBeNull();
    const row = abilitiesContext(state).rows.find(r => r.key === "str");
    // The empty string leaves the box blank; a 0 would read as a score.
    expect(row.value).toBe("");
    expect(row.modifier).toBe("");
  });

  it("pulls a pasted score into range instead of refusing it", async () => {
    const state = manualState();
    await abilitiesHandle("ability-set", el({ ability: "str" }, "400"), state);
    expect(state.manualScores.str).toBe(20);
    await abilitiesHandle("ability-set", el({ ability: "dex" }, "-5"), state);
    expect(state.manualScores.dex).toBe(1);
    await abilitiesHandle("ability-set", el({ ability: "con" }, "13.9"), state);
    expect(state.manualScores.con).toBe(13);
    await abilitiesHandle("ability-set", el({ ability: "int" }, "abc"), state);
    expect(state.manualScores.int).toBeNull();
  });

  it("follows a world that has raised the system's ability cap", async () => {
    CONFIG.DND5E.maxAbilityScore = 30;
    const state = manualState();
    await abilitiesHandle("ability-set", el({ ability: "str" }, "26"), state);
    expect(state.manualScores.str).toBe(26);
    expect(abilitiesContext(state).max).toBe(30);
  });

  it("resets the typed scores rather than the point-buy spread", async () => {
    const state = manualState(filled);
    await abilitiesHandle("ability-reset", el(), state);
    expect(ABILITIES.every(k => state.manualScores[k] === null)).toBe(true);
    // Point-buy's own working values are a different method's, and are left alone.
    expect(state.pointBuy.str).toBe(8);
  });

  it("keeps each method's working values, so flipping between them loses nothing", async () => {
    const state = manualState(filled);
    await abilitiesHandle("ability-method", el({ method: "point-buy" }), state);
    state.pointBuy.str = 15;
    await abilitiesHandle("ability-method", el({ method: "manual" }), state);
    expect(state.manualScores).toMatchObject(filled);
    expect(state.pointBuy.str).toBe(15);
  });
});

describe("what the character is built from", () => {
  it("resolves to the typed scores", () => {
    expect(manualState(filled).resolvedScores()).toEqual(filled);
  });

  it("reads an empty box as 8, the same floor the other methods use", () => {
    const scores = manualState({ str: 16 }).resolvedScores();
    expect(scores.str).toBe(16);
    expect(scores.dex).toBe(8);
  });
});
