import { beforeEach, describe, expect, it } from "vitest";
import { onGetHeaderControls } from "../scripts/levelup/intercept.mjs";
import { SETTINGS } from "../scripts/config.mjs";

/**
 * "Level Up" in the ⋯ menu of a character sheet's header — the third front door onto the flow,
 * beside the sheet button and the sidebar's right-click entry.
 *
 * Worth pinning because of where it runs. Foundry fires `getHeaderControlsApplicationV2` once per
 * class in an application's inheritance chain, so listening on the base name catches *every*
 * ApplicationV2 in the world — dnd5e sheets, Tidy sheets, the compendium browser, our own windows.
 * The guards are therefore the whole feature, and a mistake in them adds a Level Up entry to
 * something that has nothing to level.
 */

const CLASS_ITEM = { type: "class" };

/** A sheet-alike over a levellable character. */
function sheet({ type = "character", isOwner = true, level = 3, items = [CLASS_ITEM] } = {}) {
  return { actor: { type, isOwner, items, system: { details: { level } } } };
}

/** Run the hook handler over a fresh controls array and hand it back. */
function controlsFor(application) {
  const controls = [];
  onGetHeaderControls(application, controls);
  return controls;
}

const ours = controls => controls.filter(c => c.action === "sogromLevelUp");

beforeEach(() => {
  game.settings.set(null, SETTINGS.headerMenu, true);
  game.settings.set(null, SETTINGS.mode, "creation-levelup");
});

describe("the Level Up header control", () => {

  it("is offered on a character with a class to level", () => {
    const controls = controlsFor(sheet());
    expect(ours(controls)).toHaveLength(1);
    expect(typeof ours(controls)[0].onClick).toBe("function");
  });

  it("stays off until the GM asks for it", () => {
    // Off by default: the sheet button already exists, and a default of true would silently add an
    // entry to every character sheet's menu on update.
    game.settings.set(null, SETTINGS.headerMenu, false);
    expect(ours(controlsFor(sheet()))).toHaveLength(0);
  });

  it("stays away when the world leaves levelling to the system", () => {
    game.settings.set(null, SETTINGS.mode, "creation");
    expect(ours(controlsFor(sheet()))).toHaveLength(0);
  });

  it("ignores anything that isn't a levellable character", () => {
    // The hook fires for every ApplicationV2 there is, so most of what it sees is not a sheet.
    expect(ours(controlsFor({}))).toHaveLength(0);                       // no actor at all
    expect(ours(controlsFor(sheet({ type: "npc" })))).toHaveLength(0);
    expect(ours(controlsFor(sheet({ isOwner: false })))).toHaveLength(0);
    expect(ours(controlsFor(sheet({ items: [] })))).toHaveLength(0);     // no class yet
    expect(ours(controlsFor(sheet({ level: 20 })))).toHaveLength(0);     // already at the cap
  });

  it("leaves the sheet's own controls alone and never doubles up", () => {
    const controls = [{ action: "configureToken" }];
    onGetHeaderControls(sheet(), controls);
    onGetHeaderControls(sheet(), controls);
    expect(controls[0].action).toBe("configureToken");
    expect(ours(controls)).toHaveLength(1);
  });

  it("never throws out of a hook the whole world renders through", () => {
    const hostile = { get actor() { throw new Error("no actor here"); } };
    expect(() => onGetHeaderControls(hostile, [])).not.toThrow();
  });
});
