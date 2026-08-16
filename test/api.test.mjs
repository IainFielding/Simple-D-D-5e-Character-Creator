import { beforeEach, describe, expect, it } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import { HOOKS, HOOK_PREFIX, fireHook, fireCancellableHook } from "../scripts/config.mjs";

/**
 * The contract this file holds the code to: **the public surface is a promise, so it has to be
 * hard to break by accident.**
 *
 * Three things are checked, and each one guards a different way the promise could be broken
 * silently by an ordinary refactor:
 *
 *  1. **Hook names never drift.** Every name is asserted literally, against the string a consumer
 *     will have typed into their own `Hooks.on(...)`. Renaming one in config.mjs looks harmless in
 *     a diff and breaks every integration in the wild; this makes it fail the build instead.
 *  2. **The emit helpers honour the cancellable contract**, including the awkward cases — a
 *     listener returning a falsy-but-not-false value is *not* a veto, and a listener that throws
 *     is not a veto either.
 *  3. **A throwing listener cannot take a build down.** Another module's bug must not cost a
 *     player their character.
 *
 * The hook *emission sites* (does a build actually announce itself?) are UI-driven and covered by
 * the manual pass in docs/API.md, not here.
 */

describe("public hook registry", () => {
  beforeEach(() => {
    installFoundryShims();
    Hooks.fired = [];
  });

  it("uses the module-title namespace, not the author namespace", () => {
    // "sogrom" would collide with the same author's other content modules.
    expect(HOOK_PREFIX).toBe("simpleCharacterCreator");
  });

  it("publishes exactly the documented names", () => {
    // Written out literally rather than derived from HOOKS: a test that builds the expected value
    // the same way the source does would pass through any rename, which is the whole risk here.
    expect({ ...HOOKS }).toEqual({
      ready: "simpleCharacterCreator.ready",
      preOpenCreator: "simpleCharacterCreator.preOpenCreator",
      creatorOpened: "simpleCharacterCreator.creatorOpened",
      creationStepChanged: "simpleCharacterCreator.creationStepChanged",
      preCreateCharacter: "simpleCharacterCreator.preCreateCharacter",
      characterCreated: "simpleCharacterCreator.characterCreated",
      preLevelUpTakeover: "simpleCharacterCreator.preLevelUpTakeover",
      levelUpStarted: "simpleCharacterCreator.levelUpStarted",
      levelUpStepChanged: "simpleCharacterCreator.levelUpStepChanged",
      preLevelUpApply: "simpleCharacterCreator.preLevelUpApply",
      levelUpApplied: "simpleCharacterCreator.levelUpApplied",
      levelUpCancelled: "simpleCharacterCreator.levelUpCancelled",
      emberHandoff: "simpleCharacterCreator.emberHandoff"
    });
  });

  it("is frozen, so nothing can rewrite a name at runtime", () => {
    expect(Object.isFrozen(HOOKS)).toBe(true);
  });

  it("names every cancellable hook with a pre- prefix and nothing else", () => {
    // The prefix is how a consumer knows a return value is read, so it has to mean exactly that.
    const cancellable = [
      HOOKS.preOpenCreator, HOOKS.preCreateCharacter, HOOKS.preLevelUpTakeover, HOOKS.preLevelUpApply
    ];
    const prefixed = Object.values(HOOKS).filter(h => /\.pre[A-Z]/.test(h));
    expect(prefixed.sort()).toEqual(cancellable.sort());
  });
});

describe("fireHook", () => {
  beforeEach(() => {
    installFoundryShims();
    Hooks.fired = [];
  });

  it("passes the payload through as a single object argument", () => {
    let seen = null;
    Hooks.on(HOOKS.characterCreated, payload => { seen = payload; });
    fireHook(HOOKS.characterCreated, { actor: { id: "abc" }, targetLevel: 3 });
    expect(seen).toEqual({ actor: { id: "abc" }, targetLevel: 3 });
  });

  it("survives a listener that throws", () => {
    Hooks.on(HOOKS.levelUpApplied, () => { throw new Error("another module is broken"); });
    // The assertion is simply that this returns rather than propagating: a third party's bug must
    // not unwind the flow that was mid-way through finishing a character.
    expect(() => fireHook(HOOKS.levelUpApplied, { actor: null })).not.toThrow();
  });
});

describe("fireCancellableHook", () => {
  beforeEach(() => {
    installFoundryShims();
    Hooks.fired = [];
  });

  it("allows the action when nobody is listening", () => {
    expect(fireCancellableHook(HOOKS.preCreateCharacter, {})).toBe(true);
  });

  it("vetoes on exactly false", () => {
    Hooks.on(HOOKS.preCreateCharacter, () => false);
    expect(fireCancellableHook(HOOKS.preCreateCharacter, {})).toBe(false);
  });

  it("does not veto on other falsy returns", () => {
    // A listener that just forgot to return is the common case, and must not cancel a build.
    for ( const value of [undefined, null, 0, "", NaN] ) {
      installFoundryShims();
      Hooks.on(HOOKS.preLevelUpApply, () => value);
      expect(fireCancellableHook(HOOKS.preLevelUpApply, {})).toBe(true);
    }
  });

  it("treats a throwing listener as no veto", () => {
    Hooks.on(HOOKS.preLevelUpTakeover, () => { throw new Error("broken listener"); });
    // Silently cancelling somebody's level-up because a third-party module has a bug would be a
    // far worse failure than ignoring that module.
    expect(fireCancellableHook(HOOKS.preLevelUpTakeover, {})).toBe(true);
  });

  it("stops at the first veto", () => {
    const called = [];
    Hooks.on(HOOKS.preOpenCreator, () => { called.push("first"); return false; });
    Hooks.on(HOOKS.preOpenCreator, () => { called.push("second"); });
    expect(fireCancellableHook(HOOKS.preOpenCreator, {})).toBe(false);
    expect(called).toEqual(["first"]);
  });
});
