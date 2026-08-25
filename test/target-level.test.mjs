/**
 * The creation Class step's target-level picker (class-step.mjs).
 *
 * The creator itself only ever builds a level-1 character; this picker records where the player
 * actually wants to end up, and the shell hands the rest to the level-up wizard after Create (one
 * manager for the whole 1→target jump). What's pinned here is that contract's edges: the value is
 * always a sane level, the presets and the custom field can't both claim the pick, the choice
 * survives changing class, and the picker disappears in a world that has no level-up wizard to
 * finish the job.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import { classStep } from "../scripts/steps/class-step.mjs";
import { CreatorState } from "../scripts/state/creator-state.mjs";
import { MODULE_ID, SETTINGS } from "../scripts/config.mjs";

/** The step's `source`: the compendium-backed class index the card grid draws from. */
const source = {
  classes: () => [
    { uuid: "Compendium.x.Item.fighter", name: "Fighter", img: "f.webp" },
    { uuid: "Compendium.x.Item.wizard", name: "Wizard", img: "w.webp" }
  ],
  card: uuid => ({ name: uuid?.endsWith("wizard") ? "Wizard" : "Fighter" }),
  detail: async () => ({ name: "Wizard", img: "w.webp", enriched: "<p>arcane</p>" }),
  advancementGroups: async () => [],
  // The step reads the chosen class's edition to scope its "Read the Rules" link. These fixtures
  // declare none, which is the real "content that names no edition" case.
  rulesOf: () => null
};

/** The dispatcher context a step handler receives. */
function ctxFor(state) {
  return { state, source, spells: { }, equipment: {}, app: {} };
}

/** The picker's view-model for the state's current pick. */
async function pickerFor(state) {
  const ctx = await classStep.context({ state, source });
  return ctx.targetLevel;
}

/** Click a preset chip. */
function clickPreset(state, level) {
  return classStep.handle("target-level", { dataset: { level: String(level) } }, ctxFor(state));
}

/** Type into the custom level field. */
function typeCustom(state, value) {
  return classStep.handle("target-level-custom", { value: String(value) }, ctxFor(state));
}

describe("creation target-level picker", () => {
  beforeEach(() => {
    installFoundryShims();
    // The picker only exists where the level-up wizard does; default the world to both.
    game.settings.set(MODULE_ID, SETTINGS.mode, "creation-levelup");
  });

  it("defaults to level 1, with the level-1 chip active and no custom value", async () => {
    const state = new CreatorState(null);
    expect(state.targetLevel).toBe(1);

    const picker = await pickerFor(state);
    expect(picker.value).toBe(1);
    expect(picker.presets.map(p => p.level)).toEqual([1, 3, 5]);
    expect(picker.presets.find(p => p.active).level).toBe(1);
    expect(picker.custom).toBe(false);
    expect(picker.customValue).toBe("");
    expect(picker.aboveOne).toBe(false);
  });

  it("moves the active chip when a preset is clicked", async () => {
    const state = new CreatorState(null);
    await clickPreset(state, 5);

    expect(state.targetLevel).toBe(5);
    const picker = await pickerFor(state);
    expect(picker.presets.find(p => p.active).level).toBe(5);
    expect(picker.custom).toBe(false);
    expect(picker.aboveOne).toBe(true);
  });

  it("shows a non-preset level in the custom field, with no chip active", async () => {
    const state = new CreatorState(null);
    await typeCustom(state, 7);

    expect(state.targetLevel).toBe(7);
    const picker = await pickerFor(state);
    expect(picker.presets.some(p => p.active)).toBe(false);
    expect(picker.custom).toBe(true);
    expect(picker.customValue).toBe(7);
  });

  it("hands a custom entry that lands on a preset back to that chip", async () => {
    const state = new CreatorState(null);
    await typeCustom(state, 3);

    const picker = await pickerFor(state);
    expect(picker.presets.find(p => p.active).level).toBe(3);
    expect(picker.custom).toBe(false);
    expect(picker.customValue).toBe("");
  });

  it("clamps a custom entry to 1…the system's level cap", async () => {
    const state = new CreatorState(null);
    CONFIG.DND5E.maxLevel = 20;

    await typeCustom(state, 99);
    expect(state.targetLevel).toBe(20);

    await typeCustom(state, 0);
    expect(state.targetLevel).toBe(1);

    await typeCustom(state, -4);
    expect(state.targetLevel).toBe(1);
  });

  it("rounds a fractional entry down and falls back to 1 on junk", async () => {
    const state = new CreatorState(null);

    await typeCustom(state, "4.8");
    expect(state.targetLevel).toBe(4);

    await typeCustom(state, "");
    expect(state.targetLevel).toBe(1);

    await typeCustom(state, "abc");
    expect(state.targetLevel).toBe(1);
  });

  it("respects a world that lowered the level cap", async () => {
    const state = new CreatorState(null);
    CONFIG.DND5E.maxLevel = 6;

    await typeCustom(state, 12);
    expect(state.targetLevel).toBe(6);

    const picker = await pickerFor(state);
    expect(picker.max).toBe(6);
  });

  it("keeps the chosen level when the player changes class", async () => {
    const state = new CreatorState(null);
    await clickPreset(state, 5);
    // resetClassDependent() wipes the class's spells and advancement picks; "I want a level 5
    // character" is about the character, not the class, and must survive.
    state.resetClassDependent();

    expect(state.targetLevel).toBe(5);
  });

  it("is hidden in a creation-only world, where no level-up wizard exists to finish the job", async () => {
    const state = new CreatorState(null);
    game.settings.set(MODULE_ID, SETTINGS.mode, "creation");

    expect(await pickerFor(state)).toBe(null);
  });
});
