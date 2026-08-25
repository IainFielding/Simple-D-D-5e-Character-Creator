import { describe, it, expect, beforeEach } from "vitest";

/**
 * The alignment control and the banned-alignment house rule behind it.
 *
 * dnd5e models `system.details.alignment` as a plain `StringField` and the character sheet renders
 * whatever is in it verbatim — so the control stores the **label** a player picked ("Lawful Good"),
 * never the `CONFIG.DND5E.alignments` key, which would show them "lg" on their own sheet. That is
 * also why this field had to become a real list before it could be restricted at all: you cannot
 * ban an option from a free-text box.
 *
 * The rules are reproduced here rather than imported for the same reason as the other step tests —
 * `details-step.mjs` reaches Foundry globals at module scope. What is modelled is exactly the pair
 * of functions under test: `allowedAlignments` (config.mjs) and `alignmentContext` (details-step).
 */
describe("banned alignments and the Other escape hatch", () => {
  const ALL = {
    lg: "Lawful Good", ng: "Neutral Good", cg: "Chaotic Good",
    ln: "Lawful Neutral", tn: "True Neutral", cn: "Chaotic Neutral",
    le: "Lawful Evil", ne: "Neutral Evil", ce: "Chaotic Evil"
  };
  const OTHER = "__other__";

  let banned;

  /** `allowedAlignments()` — CONFIG order, minus whatever the GM ruled out. */
  const allowedAlignments = () => Object.entries(ALL)
    .filter(([key]) => !banned.includes(key))
    .map(([key, label]) => ({ key, label }));

  /** `alignmentContext(state)` from details-step.mjs. */
  const context = state => {
    const current = state.details.alignment ?? "";
    const options = allowedAlignments();
    const known = options.some(o => o.label === current);
    const other = state.alignmentOther || (!!current && !known);
    return {
      isOther: other,
      otherValue: other ? current : "",
      options: [
        { value: "", label: "Not decided", selected: !other && !current },
        ...options.map(o => ({ value: o.label, label: o.label, selected: !other && (o.label === current) })),
        { value: OTHER, label: "Other…", selected: other }
      ]
    };
  };

  /** The `alignment` case of the step's own change handler. */
  const pick = (state, value) => {
    state.alignmentOther = value === OTHER;
    state.details.alignment = state.alignmentOther ? "" : value;
    return state;
  };

  const stateWith = (alignment = "") => ({ details: { alignment }, alignmentOther: false });
  const offered = ctx => ctx.options.map(o => o.label);

  beforeEach(() => { banned = []; });

  it("offers every alignment when the GM has banned none", () => {
    expect(allowedAlignments()).toHaveLength(9);
  });

  it("drops a banned alignment from the offered list", () => {
    banned = ["le", "ne", "ce"];
    const labels = offered(context(stateWith()));
    expect(labels).not.toContain("Lawful Evil");
    expect(labels).not.toContain("Chaotic Evil");
    expect(labels).toContain("Lawful Good");
  });

  it("keeps CONFIG's order rather than sorting, so the grid stays the familiar square", () => {
    expect(allowedAlignments().map(a => a.key))
      .toEqual(["lg", "ng", "cg", "ln", "tn", "cn", "le", "ne", "ce"]);
  });

  it("stores the readable label, never the key", () => {
    const state = pick(stateWith(), "Lawful Good");
    expect(state.details.alignment).toBe("Lawful Good");
  });

  it("marks the stored alignment as the selected option", () => {
    const ctx = context(stateWith("Chaotic Neutral"));
    expect(ctx.options.find(o => o.selected).label).toBe("Chaotic Neutral");
    expect(ctx.isOther).toBe(false);
  });

  it("selects nothing but the placeholder on a fresh character", () => {
    const ctx = context(stateWith());
    expect(ctx.options.find(o => o.selected).label).toBe("Not decided");
  });

  /**
   * The reason `alignmentOther` exists as its own flag: "Other with nothing typed yet" and "nothing
   * chosen" are indistinguishable from `details.alignment` alone, so without it the control would
   * snap straight back to the list on the very next render.
   */
  it("stays on Other after picking it, before anything is typed", () => {
    const state = pick(stateWith(), OTHER);
    expect(state.details.alignment).toBe("");
    const ctx = context(state);
    expect(ctx.isOther).toBe(true);
    expect(ctx.options.find(o => o.selected).label).toBe("Other…");
  });

  it("round-trips a custom alignment typed into Other", () => {
    const state = pick(stateWith(), OTHER);
    state.details.alignment = "Lawful Anxious";              // the free-text box writing through
    const ctx = context(state);
    expect(ctx.isOther).toBe(true);
    expect(ctx.otherValue).toBe("Lawful Anxious");
  });

  /**
   * Losing what a player typed is a far worse failure than showing an alignment the house rules no
   * longer allow, so an unrecognised value lands in Other with its text intact — whether it is
   * homebrew, arrived through the Ember hand-off, or was banned after the character was started.
   */
  it("preserves an unrecognised alignment rather than blanking it", () => {
    const ctx = context(stateWith("Neutral Anxious"));
    expect(ctx.isOther).toBe(true);
    expect(ctx.otherValue).toBe("Neutral Anxious");
  });

  it("preserves an alignment banned after the character already chose it", () => {
    banned = ["ce"];
    const ctx = context(stateWith("Chaotic Evil"));
    expect(ctx.isOther).toBe(true);
    expect(ctx.otherValue).toBe("Chaotic Evil");
    expect(offered(ctx)).not.toContain("Chaotic Evil");
  });

  it("returns to the list when a standard alignment is picked after Other", () => {
    const state = pick(stateWith("Lawful Anxious"), "True Neutral");
    expect(state.alignmentOther).toBe(false);
    const ctx = context(state);
    expect(ctx.isOther).toBe(false);
    expect(ctx.otherValue).toBe("");
    expect(state.details.alignment).toBe("True Neutral");
  });

  // A GM banning every alignment is a real (if odd) configuration; it must not leave a dead control.
  it("still offers Other when every alignment is banned", () => {
    banned = Object.keys(ALL);
    const ctx = context(stateWith());
    expect(allowedAlignments()).toHaveLength(0);
    expect(offered(ctx)).toEqual(["Not decided", "Other…"]);
  });
});

/**
 * The House Rules window writes four settings, each guarded rather than trusted — these are inputs
 * a GM can empty or mistype, and a blank point-buy budget reaching the Abilities step would break
 * creation for the whole table rather than just ignoring one bad edit.
 */
describe("House Rules submit guards its values", () => {
  const DEFAULTS = { pointBuyBudget: 27, rollFormula: "4d6kh3", multiclass: "off" };
  const MULTICLASS_MODES = ["off", "prereq", "free"];

  /** `HouseRulesApp.#onSubmit`'s guarding, over Foundry's already-expanded form data. */
  const submit = data => {
    const budget = Number(data.pointBuyBudget);
    const formula = String(data.rollFormula ?? "").trim();
    return {
      pointBuyBudget: Number.isFinite(budget) && (budget > 0) ? Math.round(budget) : DEFAULTS.pointBuyBudget,
      rollFormula: formula || DEFAULTS.rollFormula,
      multiclass: MULTICLASS_MODES.includes(data.multiclass) ? data.multiclass : DEFAULTS.multiclass,
      bannedAlignments: Object.entries(data.banned ?? {}).filter(([, on]) => on).map(([key]) => key)
    };
  };

  it("keeps valid values as given", () => {
    expect(submit({
      pointBuyBudget: 32, rollFormula: "3d6", multiclass: "prereq",
      banned: { le: true, ne: false, ce: true }
    })).toEqual({
      pointBuyBudget: 32, rollFormula: "3d6", multiclass: "prereq", bannedAlignments: ["le", "ce"]
    });
  });

  it("falls back to the default budget on an empty or nonsense number", () => {
    for ( const bad of ["", "abc", 0, -5, null] ) {
      expect(submit({ pointBuyBudget: bad }).pointBuyBudget).toBe(27);
    }
  });

  it("rounds a fractional budget rather than storing it", () => {
    expect(submit({ pointBuyBudget: 27.6 }).pointBuyBudget).toBe(28);
  });

  it("falls back to the default formula on a blank or whitespace entry", () => {
    for ( const bad of ["", "   ", undefined] ) {
      expect(submit({ rollFormula: bad }).rollFormula).toBe("4d6kh3");
    }
  });

  it("rejects an unknown multiclass mode", () => {
    expect(submit({ multiclass: "sometimes" }).multiclass).toBe("off");
  });

  it("records no bans when every box is unticked", () => {
    expect(submit({ banned: { lg: false, ce: false } }).bannedAlignments).toEqual([]);
    expect(submit({}).bannedAlignments).toEqual([]);
  });
});
