import { beforeEach, describe, expect, it } from "vitest";
import { CreatorShellBase, SPELL_FILTER_CONTROLS } from "../scripts/app/shell-base.mjs";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";

/**
 * The client-side spell filter — the pass that decides which rows a player can see.
 *
 * It runs against the DOM without a re-render (so the search field keeps focus while typing), which
 * is what makes it worth testing separately from the step that supplies the options: nothing else in
 * the module reads `dataset` and toggles a class, and getting the property filter's two directions
 * the wrong way round would silently show a player the opposite of what they asked for.
 *
 * There is no DOM in this suite, so the method is borrowed off the prototype with the smallest
 * `this` that satisfies it — the same pattern test/ember-creation.test.mjs uses for the shells'
 * view-model arithmetic.
 */

/** A stub row: the `data-*` attributes spell-row.hbs emits, plus a recorded hidden flag. */
function row(dataset) {
  const el = { dataset, hidden: null };
  el.classList = { toggle: (_cls, on) => { el.hidden = on; } };
  el.closest = () => el;
  return el;
}

/**
 * A stand-in shell. `controls` maps a filter's `data-` attribute to its current value; anything
 * absent is a control the step did not render, which must read as "not filtering".
 */
function shellLike(rows, controls = {}) {
  const shell = {
    afterFilter: null,
    element: {
      querySelector(selector) {
        const attr = selector.replace(/[[\]]/g, "");
        return attr in controls ? { value: controls[attr] } : null;
      },
      querySelectorAll: () => rows
    },
    _afterFilter(needle, filtered) { shell.afterFilter = { needle, filtered }; }
  };
  return shell;
}

const apply = shell => CreatorShellBase.prototype._applySpellFilters.call(shell);
const visible = rows => rows.filter(r => !r.hidden).map(r => r.dataset.name);

/** Three rows spanning every axis the filter knows about. */
function sampleRows() {
  return [
    row({ name: "Fireball", level: "3", school: "Evocation", props: "vocal somatic material",
      casting: "action", range: "ft" }),
    row({ name: "Detect Magic", level: "1", school: "Divination",
      props: "vocal somatic concentration ritual", casting: "action", range: "self" }),
    row({ name: "Alarm", level: "1", school: "Abjuration", props: "vocal somatic material ritual",
      casting: "minute", range: "ft" })
  ];
}

beforeEach(() => installFoundryShims());

describe("_applySpellFilters", () => {
  it("shows everything when no control is rendered at all", () => {
    const rows = sampleRows();
    apply(shellLike(rows));
    expect(visible(rows)).toEqual(["Fireball", "Detect Magic", "Alarm"]);
  });

  it("matches the search anywhere in the name, case-insensitively", () => {
    const rows = sampleRows();
    apply(shellLike(rows, { "data-creator-search": "MAGIC" }));
    expect(visible(rows)).toEqual(["Detect Magic"]);
  });

  it("filters by level and by school", () => {
    const byLevel = sampleRows();
    apply(shellLike(byLevel, { "data-spell-filter-level": "1" }));
    expect(visible(byLevel)).toEqual(["Detect Magic", "Alarm"]);

    const bySchool = sampleRows();
    apply(shellLike(bySchool, { "data-spell-filter-school": "Evocation" }));
    expect(visible(bySchool)).toEqual(["Fireball"]);
  });

  it("keeps only the spells carrying a property for a ':yes' filter", () => {
    const rows = sampleRows();
    apply(shellLike(rows, { "data-spell-filter-prop": "ritual:yes" }));
    expect(visible(rows)).toEqual(["Detect Magic", "Alarm"]);
  });

  it("keeps only the spells *lacking* a property for a ':no' filter", () => {
    const rows = sampleRows();
    apply(shellLike(rows, { "data-spell-filter-prop": "concentration:no" }));
    expect(visible(rows)).toEqual(["Fireball", "Alarm"]);
  });

  it("matches a property key exactly, so 'ritual' never matches a longer key that contains it", () => {
    const rows = [row({ name: "Odd", props: "ritualistic" }), row({ name: "Real", props: "ritual" })];
    apply(shellLike(rows, { "data-spell-filter-prop": "ritual:yes" }));
    expect(visible(rows)).toEqual(["Real"]);
  });

  it("filters by casting time and by range unit", () => {
    const byCasting = sampleRows();
    apply(shellLike(byCasting, { "data-spell-filter-casting": "minute" }));
    expect(visible(byCasting)).toEqual(["Alarm"]);

    const byRange = sampleRows();
    apply(shellLike(byRange, { "data-spell-filter-range": "self" }));
    expect(visible(byRange)).toEqual(["Detect Magic"]);
  });

  it("combines every active filter — a row must satisfy all of them", () => {
    const rows = sampleRows();
    apply(shellLike(rows, {
      "data-spell-filter-level": "1",
      "data-spell-filter-prop": "ritual:yes",
      "data-spell-filter-range": "ft"
    }));
    expect(visible(rows)).toEqual(["Alarm"]);
  });

  it("hides a row missing the attribute a filter asks about, rather than letting it through", () => {
    const rows = [row({ name: "Unindexed" })];
    apply(shellLike(rows, { "data-spell-filter-casting": "action" }));
    expect(visible(rows)).toEqual([]);
  });

  it("tells _afterFilter whether anything beyond the search is narrowing", () => {
    const searchOnly = shellLike(sampleRows(), { "data-creator-search": "fire" });
    apply(searchOnly);
    expect(searchOnly.afterFilter).toEqual({ needle: "fire", filtered: false });

    const narrowed = shellLike(sampleRows(), { "data-spell-filter-prop": "ritual:yes" });
    apply(narrowed);
    expect(narrowed.afterFilter).toEqual({ needle: "", filtered: true });
  });
});

describe("SPELL_FILTER_CONTROLS", () => {
  it("has one state key per control, all distinct", () => {
    const keys = SPELL_FILTER_CONTROLS.map(c => c.stateKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("carries exactly one search box; everything else is a dropdown", () => {
    // _wireSpellFilters uses "is any control other than the search present?" to decide whether the
    // step is a spell step at all, so a second value-carrying non-dropdown here would break that.
    const searches = SPELL_FILTER_CONTROLS.filter(c => c.event === "input");
    expect(searches).toEqual([
      { selector: "[data-creator-search]", stateKey: "spellSearch", event: "input" }
    ]);
  });
});
