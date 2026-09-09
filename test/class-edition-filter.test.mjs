/**
 * The Class step's edition filter (class-step.mjs `editionFilterContext`).
 *
 * A world with both books enabled lists every class twice — thirteen apparently-duplicate pairs
 * told apart only by a small badge on the card. The drawer's dropdown shows one book at a time,
 * and opens on the edition the world actually plays by: dnd5e's own `rulesVersion` setting.
 *
 * What's pinned here is the part a player would notice going wrong: the control only exists where
 * it would do something, the default can never open the drawer on an empty list, content that
 * declares no edition is never filtered away, and the pick the player makes outranks the default.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import { classStep } from "../scripts/steps/class-step.mjs";
import { CreatorState } from "../scripts/state/creator-state.mjs";

/** A world holding both editions of two classes, plus one homebrew class declaring none. */
const BOTH_EDITIONS = [
  { uuid: "Compendium.x.Item.fighter14", name: "Fighter", img: "f.webp", rules: "2014" },
  { uuid: "Compendium.x.Item.wizard14", name: "Wizard", img: "w.webp", rules: "2014" },
  { uuid: "Compendium.x.Item.fighter24", name: "Fighter", img: "f.webp", rules: "2024" },
  { uuid: "Compendium.x.Item.wizard24", name: "Wizard", img: "w.webp", rules: "2024" },
  { uuid: "Compendium.x.Item.witch", name: "Witch", img: "h.webp", rules: null }
];

/** The step's `source`, over whichever class list a test hands it. */
function sourceOver(classes) {
  return {
    classes: () => classes,
    card: uuid => classes.find(c => c.uuid === uuid) ?? null,
    detail: async uuid => ({ name: classes.find(c => c.uuid === uuid)?.name ?? "", img: "x.webp" }),
    advancementGroups: async () => [],
    rulesOf: uuid => classes.find(c => c.uuid === uuid)?.rules ?? null
  };
}

/** The step context for a state, over the given class list. */
function contextFor(state, classes = BOTH_EDITIONS) {
  return classStep.context({ state, source: sourceOver(classes) });
}

/** The names of the cards a player would actually see under the active filter. */
const shown = ctx => ctx.cards.filter(c => !c.hidden).map(c => c.name);

describe("class drawer edition filter", () => {
  beforeEach(() => installFoundryShims());

  it("is not offered in a world holding only one edition of classes", async () => {
    const single = BOTH_EDITIONS.filter(c => c.rules !== "2014");
    const ctx = await contextFor(new CreatorState(null), single);

    expect(ctx.rulesFilter).toBeNull();
    // Nothing filtered, so every card is on offer and the readout says so.
    expect(shown(ctx)).toEqual(["Fighter", "Wizard", "Witch"]);
    expect(ctx.count).toBe(3);
  });

  it("opens on the edition the world plays by, per dnd5e's rulesVersion", async () => {
    const ctx = await contextFor(new CreatorState(null));

    expect(ctx.rulesFilter.value).toBe("2024");
    expect(ctx.rulesFilter.options.map(o => o.value)).toEqual(["", "2024", "2014"]);
    expect(ctx.rulesFilter.options.find(o => o.selected).value).toBe("2024");
    expect(shown(ctx)).toEqual(["Fighter", "Wizard", "Witch"]);
    // The "Available: N" readout counts what is on screen, not what was loaded.
    expect(ctx.count).toBe(3);
  });

  it("opens on 2014 in a legacy world", async () => {
    dnd5e.settings.rulesVersion = "legacy";
    const ctx = await contextFor(new CreatorState(null));

    expect(ctx.rulesFilter.value).toBe("2014");
    expect(ctx.cards.filter(c => !c.hidden).map(c => c.uuid))
      .toEqual(["Compendium.x.Item.fighter14", "Compendium.x.Item.wizard14", "Compendium.x.Item.witch"]);
  });

  // Homebrew and third-party packs frequently never set `source.rules`. Hiding those from every
  // filter would be a worse failure than showing them under both — the rule the grids already use.
  it("never filters away content that declares no edition", async () => {
    const state = new CreatorState(null);
    for ( const edition of ["2024", "2014"] ) {
      state.classRulesFilter = edition;
      expect(shown(await contextFor(state))).toContain("Witch");
    }
  });

  it("follows the chosen class's edition, so the selected card is never hidden", async () => {
    const state = new CreatorState(null);
    state.classUuid = "Compendium.x.Item.fighter14";     // a 2014 class in a 2024-default world
    const ctx = await contextFor(state);

    expect(ctx.rulesFilter.value).toBe("2014");
    expect(ctx.cards.find(c => c.uuid === state.classUuid).hidden).toBe(false);
  });

  it("lets an explicit pick outrank both the world setting and the chosen class", async () => {
    const state = new CreatorState(null);
    state.classUuid = "Compendium.x.Item.fighter14";
    state.classRulesFilter = "2024";
    const ctx = await contextFor(state);

    expect(ctx.rulesFilter.value).toBe("2024");
    expect(shown(ctx)).toEqual(["Fighter", "Wizard", "Witch"]);
  });

  it("shows both editions when the player asks for both", async () => {
    const state = new CreatorState(null);
    state.classRulesFilter = "";                          // not the same as "never touched it"
    const ctx = await contextFor(state);

    expect(ctx.rulesFilter.value).toBe("");
    expect(ctx.rulesFilter.options[0].selected).toBe(true);
    expect(ctx.count).toBe(5);
    expect(ctx.cards.every(c => !c.hidden)).toBe(true);
  });

  // A pack declaring some edition the dropdown doesn't offer is treated like content declaring
  // none: no option here would ever bring it back, so filtering it away would strand it.
  it("keeps content from an unrecognised edition on offer under either filter", async () => {
    const odd = [...BOTH_EDITIONS, { uuid: "Compendium.x.Item.bard", name: "Bard", rules: "2025" }];
    const state = new CreatorState(null);
    for ( const edition of ["2024", "2014"] ) {
      state.classRulesFilter = edition;
      const ctx = await contextFor(state, odd);
      expect(ctx.rulesFilter.options.map(o => o.value)).toEqual(["", "2024", "2014"]);
      expect(shown(ctx)).toContain("Bard");
    }
  });
});
