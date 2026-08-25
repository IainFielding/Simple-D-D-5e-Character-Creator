import { describe, it, expect } from "vitest";

/**
 * The Level-Up Options window writes seven settings that used to sit in four separate stretches of
 * the flat settings list. The keys are unchanged, so every existing accessor still reads them — the
 * only thing that moved is where a GM edits them.
 *
 * The submit logic is reproduced here rather than imported: `levelup-options.mjs` reaches Foundry
 * globals at module scope, and what is under test is the guarding, not the window.
 */
describe("Level-Up Options submit guards its values", () => {
  const HP_MODES = ["choice", "average-roll", "average"];
  const SUMMARY_MODES = ["public", "gm", "off"];
  const DEFAULTS = { levelUpHpMode: "choice", levelUpSummary: "public", levelUpReadyNotice: "gm" };

  const oneOf = (allowed, value, fallback) => (allowed.includes(value) ? value : fallback);

  /** `LevelUpOptionsApp.#onSubmit`, over Foundry's already-serialised form data. */
  const submit = data => ({
    showLevelUpButton: !!data.showLevelUpButton,
    showLevelUpHeaderMenu: !!data.showLevelUpHeaderMenu,
    showContextMenu: !!data.showContextMenu,
    levelUpHpMode: oneOf(HP_MODES, data.levelUpHpMode, DEFAULTS.levelUpHpMode),
    levelUpHpRollToChat: !!data.levelUpHpRollToChat,
    levelUpSummary: oneOf(SUMMARY_MODES, data.levelUpSummary, DEFAULTS.levelUpSummary),
    levelUpReadyNotice: oneOf(SUMMARY_MODES, data.levelUpReadyNotice, DEFAULTS.levelUpReadyNotice)
  });

  it("keeps valid values as given", () => {
    expect(submit({
      showLevelUpButton: true, showLevelUpHeaderMenu: false, showContextMenu: true,
      levelUpHpMode: "average-roll", levelUpHpRollToChat: true,
      levelUpSummary: "gm", levelUpReadyNotice: "off"
    })).toEqual({
      showLevelUpButton: true, showLevelUpHeaderMenu: false, showContextMenu: true,
      levelUpHpMode: "average-roll", levelUpHpRollToChat: true,
      levelUpSummary: "gm", levelUpReadyNotice: "off"
    });
  });

  // An unchecked checkbox is simply absent from the serialised form, not present-and-false.
  it("reads an absent checkbox as off", () => {
    const out = submit({});
    expect(out.showLevelUpButton).toBe(false);
    expect(out.showLevelUpHeaderMenu).toBe(false);
    expect(out.showContextMenu).toBe(false);
    expect(out.levelUpHpRollToChat).toBe(false);
  });

  it("rejects an unknown hit-point mode", () => {
    for ( const bad of ["max-always", "", null, undefined] ) {
      expect(submit({ levelUpHpMode: bad }).levelUpHpMode).toBe("choice");
    }
  });

  it("rejects an unknown announcement mode, per setting's own default", () => {
    expect(submit({ levelUpSummary: "shout" }).levelUpSummary).toBe("public");
    expect(submit({ levelUpReadyNotice: "shout" }).levelUpReadyNotice).toBe("gm");
  });

  // Turning every entry point off is a real choice, not an error: players then level through the
  // sheet's own class controls. The window warns, but must not override them.
  it("allows every entry point to be turned off", () => {
    const out = submit({ levelUpHpMode: "average" });
    expect([out.showLevelUpButton, out.showLevelUpHeaderMenu, out.showContextMenu])
      .toEqual([false, false, false]);
  });
});
