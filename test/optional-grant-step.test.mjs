import { describe, it, expect, beforeEach } from "vitest";
import { optionalGrantStep } from "../scripts/levelup/steps/optional-grant-step.mjs";

/**
 * The optional-class-feature screen. Two shapes reach it, and telling them apart is the whole job:
 *
 *  - a plain **optional** ItemGrant, whose items are independent — tick what you want;
 *  - a **replacement** grant, whose items are alternatives — Tasha's swaps a 2014 feature for its
 *    Tasha's version, so taking both would give a character something no edition grants.
 *
 * The grouping is the part worth pinning, because the obvious implementation is wrong: one base can
 * map to *several* replacements (Natural Explorer is swapped for Deft Explorer **and** Canny) while
 * `configuration.replacements` records only the first.
 */
describe("the optional-grant screen", () => {
  const uuid = id => `Compendium.dnd5e.classfeatures.Item.${id}`;
  // The pre-v10 shape the replacement map's keys are stored in — no `.Item.` segment.
  const bare = id => `Compendium.dnd5e.classfeatures.${id}`;

  let applied;
  let driver;
  let state;

  /** A record shaped like the driver's, with `selected` describing the current clone state. */
  function record({ items, replacements = null, selected = [] }) {
    const adv = { title: "Features", configuration: { items, replacements } };
    return { level: 1, screenLevel: 1, advancement: adv, item: { name: "Ranger" }, replacements, selected };
  }

  beforeEach(() => {
    applied = null;
    driver = {
      optionalGrantState: rec => ({
        options: rec.advancement.configuration.items.map(i => ({
          uuid: i.uuid, selected: rec.selected.includes(i.uuid)
        }))
      }),
      setOptionalGrant: (rec, uuids) => { applied = uuids; }
    };
  });

  /* -------------------------------------------- */

  it("keeps a base and its several replacements in one group", () => {
    // Natural Explorer -> [Deft Explorer, Canny]: the map names only the first.
    const rec = record({
      items: [
        { uuid: uuid("naturalExplorer"), optional: true },
        { uuid: uuid("deftExplorer"), optional: true },
        { uuid: uuid("canny"), optional: true },
        { uuid: uuid("rangerArchetype") }
      ],
      replacements: { [bare("naturalExplorer")]: uuid("deftExplorer") },
      selected: [uuid("naturalExplorer"), uuid("rangerArchetype")]
    });
    state = { optionalGrantSteps: [rec] };

    // Picking Canny must drop *both* the base and the sibling replacement, and must leave the
    // non-optional Ranger Archetype — which is in no group — exactly where it was.
    optionalGrantStep.handle("optionalGrantPick", {
      dataset: {
        index: "0", uuid: uuid("canny"),
        group: [uuid("naturalExplorer"), uuid("deftExplorer"), uuid("canny")].join("|")
      }
    }, { state, driver });

    expect(applied).toEqual([uuid("canny"), uuid("rangerArchetype")]);
  });

  it("toggles an independent optional item without touching its neighbours", () => {
    const rec = record({
      items: [{ uuid: uuid("a") }, { uuid: uuid("b") }, { uuid: uuid("c") }],
      selected: [uuid("a"), uuid("b"), uuid("c")]
    });
    state = { optionalGrantSteps: [rec] };

    optionalGrantStep.handle("optionalGrantToggle",
      { dataset: { index: "0", uuid: uuid("b") } }, { state, driver });

    expect(applied).toEqual([uuid("a"), uuid("c")]);
  });

  it("lets every optional item be declined", () => {
    const rec = record({ items: [{ uuid: uuid("a") }], selected: [uuid("a")] });
    state = { optionalGrantSteps: [rec] };

    optionalGrantStep.handle("optionalGrantToggle",
      { dataset: { index: "0", uuid: uuid("a") } }, { state, driver });

    // An empty answer is a real one — "decline all" — and must not read as "no opinion".
    expect(applied).toEqual([]);
  });

  // A default is always applied by the driver, so this screen must never gate the level.
  it("never blocks Next", () => {
    expect(optionalGrantStep.isCompleteAt()).toBe(true);
  });

  /* -------------------------------------------- */
  /*  Grouping                                    */
  /* -------------------------------------------- */

  /** The `members` of each rendered group, as arrays. */
  async function groupsOf(rec) {
    const { sections } = await optionalGrantStep.sectionsAt({ state: { optionalGrantSteps: [rec] }, driver }, 1);
    return sections[0].groups.map(g => g.members.split("|"));
  }

  it("folds an unnamed alternative into the group of the grant's only base", async () => {
    // The map names Deft Explorer; Canny is a replacement for the same base that it never records.
    // With one base there is only one group it can belong to, so it belongs there.
    const rec = record({
      items: [
        { uuid: uuid("naturalExplorer"), optional: true },
        { uuid: uuid("deftExplorer"), optional: true },
        { uuid: uuid("canny"), optional: true },
        { uuid: uuid("rangerArchetype") }
      ],
      replacements: { [bare("naturalExplorer")]: uuid("deftExplorer") },
      selected: [uuid("naturalExplorer"), uuid("rangerArchetype")]
    });

    const groups = await groupsOf(rec);
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]))
      .toEqual(new Set([uuid("naturalExplorer"), uuid("deftExplorer"), uuid("canny")]));
    // The non-optional item is in no group — it is granted either way, not a choice.
    expect(groups[0]).not.toContain(uuid("rangerArchetype"));
  });

  it("keeps two bases in separate groups instead of pooling their alternatives", async () => {
    // Each group is exclusive to the handler, so a shared member would let a click under one base
    // silently drop the *other* base's pick. Nothing must appear in both.
    const rec = record({
      items: [
        { uuid: uuid("favoredEnemy"), optional: true },
        { uuid: uuid("favoredFoe"), optional: true },
        { uuid: uuid("naturalExplorer"), optional: true },
        { uuid: uuid("deftExplorer"), optional: true }
      ],
      replacements: {
        [bare("favoredEnemy")]: uuid("favoredFoe"),
        [bare("naturalExplorer")]: uuid("deftExplorer")
      },
      selected: [uuid("favoredEnemy"), uuid("naturalExplorer")]
    });

    const groups = await groupsOf(rec);
    expect(groups).toHaveLength(2);
    expect(new Set(groups[0])).toEqual(new Set([uuid("favoredEnemy"), uuid("favoredFoe")]));
    expect(new Set(groups[1])).toEqual(new Set([uuid("naturalExplorer"), uuid("deftExplorer")]));
    const shared = groups[0].filter(m => groups[1].includes(m));
    expect(shared).toEqual([]);
  });

  it("leaves an unattributable alternative out rather than sharing it between bases", async () => {
    // Two bases and a Canny the map attributes to neither: it cannot be placed without guessing,
    // and guessing wrong lets one group unpick the other. Dropping the option is the safe answer.
    const rec = record({
      items: [
        { uuid: uuid("favoredEnemy"), optional: true },
        { uuid: uuid("favoredFoe"), optional: true },
        { uuid: uuid("naturalExplorer"), optional: true },
        { uuid: uuid("deftExplorer"), optional: true },
        { uuid: uuid("canny"), optional: true }
      ],
      replacements: {
        [bare("favoredEnemy")]: uuid("favoredFoe"),
        [bare("naturalExplorer")]: uuid("deftExplorer")
      },
      selected: [uuid("favoredEnemy"), uuid("naturalExplorer")]
    });

    const groups = await groupsOf(rec);
    expect(groups.flat()).not.toContain(uuid("canny"));
  });

  it("marks the currently-applied member of each group as selected", async () => {
    const rec = record({
      items: [
        { uuid: uuid("naturalExplorer"), optional: true },
        { uuid: uuid("deftExplorer"), optional: true }
      ],
      replacements: { [bare("naturalExplorer")]: uuid("deftExplorer") },
      selected: [uuid("deftExplorer")]
    });

    const { sections } = await optionalGrantStep.sectionsAt(
      { state: { optionalGrantSteps: [rec] }, driver }, 1);
    const picked = sections[0].groups[0].options.filter(o => o.selected).map(o => o.uuid);
    expect(picked).toEqual([uuid("deftExplorer")]);
  });
});
