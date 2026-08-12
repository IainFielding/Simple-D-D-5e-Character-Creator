import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import { bg3TraitIcon } from "../scripts/data/bg3-icons.mjs";

/**
 * Proficiency art from the optional Baldur's Gate 3 module.
 *
 * The module is never a dependency, so the contract has two halves: with it switched off every
 * lookup must return null (leaving callers on the system's own icons), and with it on only keys
 * the module actually ships art for may resolve — a path to a file that isn't there renders as a
 * broken image on the choice card.
 */
describe("Baldur's Gate 3 proficiency icons", () => {
  const DIR = "modules/sogrom-baldurs-gate-3-5e/assets/icons";

  /** Report the BG3 module as installed and enabled (or not). */
  function bg3(active) {
    game.modules = { get: id => id === "sogrom-baldurs-gate-3-5e" ? { active } : null };
  }

  beforeEach(() => {
    installFoundryShims();
    CONFIG.DND5E.skills = {
      acr: { fullKey: "acrobatics" },
      ani: { fullKey: "animalHandling" },
      slt: { fullKey: "sleightOfHand" },
      // A homebrew skill the module has no art for.
      brw: { fullKey: "basketWeaving" }
    };
  });

  /* -------------------------------------------- */

  it("returns nothing while the module is inactive", () => {
    bg3(false);
    expect(bg3TraitIcon("skills:acr")).toBeNull();
    expect(bg3TraitIcon("armor:hvy")).toBeNull();
  });

  it("returns nothing when the module isn't installed at all", () => {
    // The shims' default: `game.modules.get` yields null for everything.
    expect(bg3TraitIcon("skills:acr")).toBeNull();
  });

  it("maps skills through their fullKey, camelCase flattened", () => {
    bg3(true);
    expect(bg3TraitIcon("skills:acr")).toBe(`${DIR}/acrobatics.webp`);
    expect(bg3TraitIcon("skills:ani")).toBe(`${DIR}/animalhandling.webp`);
    expect(bg3TraitIcon("skills:slt")).toBe(`${DIR}/sleightofhand.webp`);
  });

  it("maps the armour, weapon and instrument categories", () => {
    bg3(true);
    expect(bg3TraitIcon("armor:lgt")).toBe(`${DIR}/lightarmour.webp`);
    expect(bg3TraitIcon("armor:med")).toBe(`${DIR}/mediumarmour.webp`);
    expect(bg3TraitIcon("armor:hvy")).toBe(`${DIR}/heavyarmour.webp`);
    expect(bg3TraitIcon("armor:shl")).toBe(`${DIR}/shields.webp`);
    expect(bg3TraitIcon("weapon:sim")).toBe(`${DIR}/weapons.webp`);
    expect(bg3TraitIcon("weapon:mar")).toBe(`${DIR}/weapons.webp`);
    expect(bg3TraitIcon("tool:music")).toBe(`${DIR}/musicalinstruments.webp`);
  });

  it("leaves specific items to their own art", () => {
    bg3(true);
    // A single weapon or instrument is better served by its item image than by the module's one
    // generic category icon, so these fall through to the caller's existing resolution.
    expect(bg3TraitIcon("weapon:mar:longsword")).toBeNull();
    expect(bg3TraitIcon("tool:music:lute")).toBeNull();
  });

  it("declines keys the module ships no art for", () => {
    bg3(true);
    expect(bg3TraitIcon("skills:brw")).toBeNull();     // homebrew skill
    expect(bg3TraitIcon("skills:xyz")).toBeNull();     // unknown abbreviation
    expect(bg3TraitIcon("languages:common")).toBeNull();
    expect(bg3TraitIcon("tool:vehicle")).toBeNull();
    expect(bg3TraitIcon(undefined)).toBeNull();
  });
});
