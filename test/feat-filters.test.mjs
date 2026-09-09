import { beforeEach, describe, expect, it } from "vitest";
import { CreatorShellBase } from "../scripts/app/shell-base.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * The ASI feat picker's client-side filter — the pass that decides which feat cards a player sees.
 *
 * Worth its own suite for the reason the spell pass has one: it runs against the DOM without a
 * re-render, so nothing else exercises it, and it does two things the spell pass never has to. A
 * card's abilities are a *set* (a half-feat offering "+1 Strength or Constitution" must answer to
 * either), and the cards live in grouped grids behind headings — so filtering to one ability
 * routinely empties a whole group, and a heading left standing over nothing reads as a bug.
 *
 * No DOM in this suite, so the method is borrowed off the prototype with the smallest `this` that
 * satisfies it — the pattern test/spell-filters.test.mjs uses.
 */

/** A stub feat card: the `data-*` attributes asi.hbs emits, plus a recorded hidden flag. */
function card(name, abilities = "") {
  const li = { hidden: false, classList: { toggle: (_c, on) => { li.hidden = on; }, contains: () => li.hidden } };
  const el = { dataset: { name, abilities }, closest: () => li, li };
  return el;
}

/** A stub grid: its cards, plus the heading element that introduces it. */
function grid(cards) {
  const head = { hidden: false, classList: {
    toggle: (_c, on) => { head.hidden = on; }, contains: c => c === "creator-choice-group-head"
  } };
  const g = {
    cards, children: cards.map(c => c.li), hidden: false,
    classList: { toggle: (_c, on) => { g.hidden = on; } },
    previousElementSibling: head
  };
  return g;
}

/** A stand-in shell holding one picker built from the given grids. */
function shellLike(grids, controls = {}) {
  const cards = grids.flatMap(g => g.cards);
  const empty = { hidden: false, classList: { toggle: (_c, on) => { empty.hidden = on; } } };
  const picker = {
    querySelector(selector) {
      if ( selector === "[data-feat-empty]" ) return empty;
      const attr = selector.replace(/[[\]]/g, "");
      return attr in controls ? { value: controls[attr] } : null;
    },
    querySelectorAll: selector => (selector === ".creator-choice-grid" ? grids : cards)
  };
  return { empty, element: { querySelector: sel => (sel === ".creator-asi-feat-picker" ? picker : null) } };
}

const apply = shell => CreatorShellBase.prototype._applyFeatFilters.call(shell);
const visible = grids => grids.flatMap(g => g.cards).filter(c => !c.li.hidden).map(c => c.dataset.name);

beforeEach(() => installFoundryShims());

describe("_applyFeatFilters", () => {
  it("does nothing at all when no picker is open", () => {
    expect(() => apply({ element: { querySelector: () => null } })).not.toThrow();
  });

  it("shows every feat when no control is rendered", () => {
    const g = [grid([card("Alert"), card("Slasher", "str dex")])];
    apply(shellLike(g));
    expect(visible(g)).toEqual(["Alert", "Slasher"]);
  });

  it("matches the search anywhere in the name, case-insensitively", () => {
    const g = [grid([card("Alert"), card("Magic Initiate"), card("Skill Expert")])];
    apply(shellLike(g, { "data-feat-search": "SKILL" }));
    expect(visible(g)).toEqual(["Skill Expert"]);
  });

  it("matches a half-feat on any ability it can raise, not just its first", () => {
    const g = [grid([card("Slasher", "str dex"), card("Actor", "cha"), card("Alert")])];
    apply(shellLike(g, { "data-feat-filter-ability": "dex" }));
    expect(visible(g)).toEqual(["Slasher"]);
    apply(shellLike(g, { "data-feat-filter-ability": "str" }));
    expect(visible(g)).toEqual(["Slasher"]);
  });

  it("leaves a feat with no increase out of every ability filter", () => {
    const g = [grid([card("Alert"), card("Actor", "cha")])];
    apply(shellLike(g, { "data-feat-filter-ability": "cha" }));
    expect(visible(g)).toEqual(["Actor"]);
  });

  it("requires the search and the ability filter to agree", () => {
    const g = [grid([card("Slasher", "str dex"), card("Crusher", "str con")])];
    apply(shellLike(g, { "data-feat-search": "crush", "data-feat-filter-ability": "dex" }));
    expect(visible(g)).toEqual([]);
  });

  it("hides an emptied group together with the heading above it", () => {
    const recommended = grid([card("Spellfire Adept", "cha")]);
    const other = grid([card("Slasher", "str dex")]);
    apply(shellLike([recommended, other], { "data-feat-filter-ability": "str" }));

    expect(recommended.hidden).toBe(true);
    expect(recommended.previousElementSibling.hidden).toBe(true);
    expect(other.hidden).toBe(false);
    expect(other.previousElementSibling.hidden).toBe(false);
  });

  it("says so when a filter matches nothing, and stops saying so when it matches again", () => {
    const g = [grid([card("Alert"), card("Slasher", "str dex")])];
    const shell = shellLike(g, { "data-feat-search": "nothing here" });
    apply(shell);
    expect(shell.empty.hidden).toBe(false);

    const found = shellLike(g, { "data-feat-search": "alert" });
    apply(found);
    expect(found.empty.hidden).toBe(true);
  });
});
