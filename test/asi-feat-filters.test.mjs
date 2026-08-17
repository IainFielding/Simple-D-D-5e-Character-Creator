import { describe, expect, it } from "vitest";
import { asiFeatFilters } from "../scripts/levelup/manager-driver.mjs";

/**
 * Which feats the compendium browser offers for an ability-score improvement.
 *
 * The rule cannot be expressed with the level prerequisite alone, and that is the whole reason this
 * exists: in dnd5e's own 2024 content, origin feats and fighting-style feats carry **no** level
 * prerequisite, so a filter built only from `prerequisites.level <= level` offered a background's
 * gift and a class feature's at every single ASI.
 *
 * The browser's set filters read `1` as "only these" and `-1` as "not these" (see
 * CompendiumBrowser#_applyFilters — positive builds `in`, negative builds `NOT..in`). Which of the
 * two is used is the load-bearing decision here, so it is what these tests pin.
 */

const subtypeOf = level => asiFeatFilters(level).locked.additional.subtype;

describe("the ASI feat browser filters", () => {

  it("keeps the browser on feats, at or below the character's level", () => {
    const filters = asiFeatFilters(8);
    expect(filters.locked.types).toEqual(new Set(["feat"]));
    expect(filters.locked.additional.category).toEqual({ feat: 1 });
    expect(filters.locked.arbitrary).toEqual([
      { k: "system.prerequisites.level", o: "lte", v: 8 }
    ]);
  });

  it("hides the feats an improvement may never take", () => {
    // Origin feats come from a background and fighting styles from a class feature. Neither is an
    // ASI's to offer, and neither declares a level that would have kept it out.
    expect(subtypeOf(8)).toMatchObject({ origin: -1, fightingStyle: -1 });
  });

  it("hides epic boons below 19 and offers them at 19", () => {
    // A level-19 improvement is *for* an epic boon, so this cannot be a blanket exclusion — and it
    // cannot be left to the level prerequisite either, because several boons ship without one.
    expect(subtypeOf(18).epicBoon).toBe(-1);
    expect(subtypeOf(19).epicBoon).toBeUndefined();
    expect(subtypeOf(20).epicBoon).toBeUndefined();
  });

  it("excludes the wrong kinds rather than admitting only the right one", () => {
    // The distinction that keeps 2014 and homebrew worlds working. The subtype split arrived with
    // the 2024 rules, so those feats have an empty subtype: a `{general: 1}` allow-list would build
    // an `in` query and show the player nothing at all. Every value here must be an exclusion.
    for ( const value of Object.values(subtypeOf(8)) ) expect(value).toBe(-1);
    expect(subtypeOf(8).general).toBeUndefined();
  });
});
