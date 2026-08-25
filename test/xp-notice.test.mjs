import { describe, it, expect } from "vitest";
import { shouldNotify } from "../scripts/levelup/xp-notice.mjs";

/**
 * The XP-threshold notice: when a character earns enough experience for the next level, whisper an
 * actionable card rather than waiting for someone to notice.
 *
 * `shouldNotify` is deliberately pure — every input is passed in rather than read off globals — so
 * the interesting rules (fire once per threshold, respect a world that doesn't use XP, stay quiet
 * at the level cap) are testable without a running world. The parts that genuinely need Foundry
 * (`isActiveGM`, the whisper list, the flag round-trip) are verified in-world instead.
 */
describe("shouldNotify decides when a level-up card is due", () => {
  const base = {
    xp: { value: 300, max: 300 },
    xpChanged: true,
    eligible: true,
    usesXp: true,
    notified: null
  };
  const check = over => shouldNotify({ ...base, ...over });

  it("fires when XP reaches the threshold", () => {
    expect(check()).toBe(300);
  });

  it("fires when XP overshoots the threshold", () => {
    expect(check({ xp: { value: 450, max: 300 } })).toBe(300);
  });

  it("stays quiet below the threshold", () => {
    expect(check({ xp: { value: 299, max: 300 } })).toBeNull();
  });

  /**
   * `updateActor` fires for every change to the actor, not just XP. Without this guard the card
   * would re-post on renames, HP changes, and every other unrelated save.
   */
  it("stays quiet when the update did not touch XP", () => {
    expect(check({ xpChanged: false })).toBeNull();
  });

  it("stays quiet for a character that cannot be levelled", () => {
    expect(check({ eligible: false })).toBeNull();
  });

  it("stays quiet in a world that does not level by XP", () => {
    expect(check({ usesXp: false })).toBeNull();
  });

  // dnd5e sets `xp.max` to Infinity at the cap — there is no next level to earn.
  it("stays quiet at the level cap", () => {
    expect(check({ xp: { value: 355000, max: Infinity } })).toBeNull();
  });

  it("stays quiet when the threshold is not a real number", () => {
    for ( const max of [undefined, null, NaN] ) {
      expect(check({ xp: { value: 300, max } })).toBeNull();
    }
  });

  /**
   * Once per threshold, not once per save afterwards. The flag needs no clearing: the moment the
   * character actually levels, `xp.max` moves to the next threshold and stops matching on its own.
   */
  it("fires only once for the same threshold", () => {
    expect(check({ notified: 300 })).toBeNull();
  });

  it("fires again at the next threshold after levelling", () => {
    expect(check({ xp: { value: 900, max: 900 }, notified: 300 })).toBe(900);
  });

  it("treats a missing XP value as zero rather than throwing", () => {
    expect(shouldNotify({ ...base, xp: { max: 300 } })).toBeNull();
    expect(shouldNotify({ ...base, xp: undefined })).toBeNull();
  });
});
