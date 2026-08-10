import { t, log } from "../../config.mjs";
import { atLevel, advancementHint } from "../levelup-state.mjs";
import { withItemSegment } from "../../data/advancement-util.mjs";

/**
 * Optional class features — the items an `ItemGrant` marks as declinable, and the base-or-alternative
 * pairs a replacement grant offers.
 *
 * Both shapes come from `dnd-tashas-cauldron`, which injects them into every 2014-rules class in the
 * world: *optional class features* as an ItemGrant with `configuration.optional`, and *replacement
 * features* as its own `TCOEReplacementGrant` type carrying a base→replacement map.
 *
 * The driver has already applied a default — everything for a plain optional grant (matching how
 * dnd5e's own manager pre-seeds the screen), the **base** of each pair for a replacement grant
 * (which is what "I did not take Tasha's alternative" means). So this block never blocks Next; it
 * exists so the player can say no, which without it they could not do at all.
 */
export const optionalGrantStep = {
  id: "optionalGrant",
  icon: "fa-solid fa-list-check",
  labelKey: "levelup.step.optionalGrant.label",
  template: "levelup/optional-grant",

  isCompleteAt() {
    // A default is always applied, so the block is satisfied on sight and never gates a level.
    return true;
  },

  async sectionsAt({ state, driver }, level) {
    const records = atLevel(state.optionalGrantSteps, level);
    if ( !records.length ) return null;
    const single = records.length === 1;

    const sections = await Promise.all(records.map(async record => {
      const st = driver.optionalGrantState(record);
      // A replacement grant's items are alternatives, so they are presented as groups of "this or
      // that" rather than as a flat list of independent tick-boxes.
      const groups = record.replacements ? buildGroups(record, st) : null;
      const items = await Promise.all(st.options.map(async o => ({
        uuid: o.uuid,
        selected: o.selected,
        ...(await itemCard(o.uuid))
      })));
      return {
        index: state.optionalGrantSteps.indexOf(record),
        title: record.advancement.title || record.item?.name || t("levelup.step.optionalGrant.label"),
        hint: await advancementHint(record),
        prompt: t(groups ? "levelup.step.optionalGrant.promptReplace" : "levelup.step.optionalGrant.prompt"),
        items: groups ? null : items,
        groups: groups ? await decorateGroups(groups) : null,
        collapsed: single
      };
    }));
    return { blockLabel: single ? sections[0].title : null, sections };
  },

  async handle(action, el, { state, driver }) {
    const record = state.optionalGrantSteps[Number(el.dataset.index)];
    if ( !record ) return;
    const st = driver.optionalGrantState(record);
    const uuid = el.dataset.uuid;
    if ( !uuid ) return;

    if ( action === "optionalGrantToggle" ) {
      // Independent items: flip just this one.
      const next = st.options.filter(o => (o.uuid === uuid) ? !o.selected : o.selected).map(o => o.uuid);
      await driver.setOptionalGrant(record, next);
      return;
    }
    if ( action === "optionalGrantPick" ) {
      // One of a base/alternative pair: take this side of the group and drop the other members,
      // leaving every item outside the group exactly as it was.
      const group = (el.dataset.group ?? "").split("|").filter(Boolean);
      const next = st.options
        .filter(o => group.includes(o.uuid) ? (o.uuid === uuid) : o.selected)
        .map(o => o.uuid);
      await driver.setOptionalGrant(record, next);
    }
  }
};

/* -------------------------------------------- */

/**
 * Group a replacement grant's items into base-and-alternatives sets, one exclusive group per base.
 *
 * The configuration's `replacements` map is base→alternative, but one base can map to *several*
 * items (Tasha's swaps Natural Explorer for Deft Explorer **and** Canny) while the map records only
 * the first. So a group is built from what the map names, and the optional items it names nowhere
 * are folded in as further alternatives — but only when the grant carries a **single** base, which
 * is the only arrangement in which they can be attributed to one.
 *
 * With two or more bases those unattributable extras are left out rather than added to every group.
 * Handing them to all of them is what the code used to do, and it is not a cosmetic error: the
 * step's handler treats a group as exclusive, so clicking an extra shown under one base would
 * deselect a different base's pick — losing a feature the player had chosen for an unrelated
 * replacement. Dropping an option is visible and safe; silently unpicking another group is neither.
 * The `log` marks the case, since no content is known to produce it today.
 *
 * Anything non-optional sits outside every group and is not offered as a choice at all.
 */
function buildGroups(record, state) {
  // Every uuid normalised, because `state.options` is too — this content stores the pre-v10 shape
  // and the two forms compare unequal, which showed a group's base as unselected and made clicking
  // it a no-op.
  const flat = foundry.utils.flattenObject(record.replacements);
  const bases = new Set(Object.keys(flat).map(withItemSegment));
  const configured = new Map(Array.from(record.advancement.configuration?.items ?? [])
    .map(i => (typeof i === "string") ? { uuid: i } : i)
    .map(i => [withItemSegment(i.uuid), i]));

  // Alternatives the map attributes to a base, keyed by that base. Scoped to what the grant
  // actually offers: the map is content the grant was mutated *with*, so a stale entry naming an
  // item no longer in `configuration.items` would otherwise render a card for something that
  // cannot be granted.
  const offered = new Set(state.options.map(o => o.uuid));
  const named = new Map([...bases].map(b => [b, []]));
  for ( const [rawBase, rawAlt] of Object.entries(flat) ) {
    const base = withItemSegment(rawBase);
    const alt = rawAlt ? withItemSegment(rawAlt) : null;
    if ( alt && offered.has(alt) && named.has(base) ) named.get(base).push(alt);
  }

  // Optional items the map attributes to nobody — the "and Canny" case.
  const attributed = new Set([...named.values()].flat());
  const extras = state.options
    .filter(o => configured.get(o.uuid)?.optional && !bases.has(o.uuid) && !attributed.has(o.uuid))
    .map(o => o.uuid);
  if ( extras.length && (bases.size > 1) ) {
    log(`replacement grant "${record.advancement.title ?? record.advancement.id}" has ${bases.size} bases `
      + `and ${extras.length} unattributable alternatives; leaving them out rather than sharing them`);
  }

  const selected = new Set(state.options.filter(o => o.selected).map(o => o.uuid));
  return [...bases].map(base => {
    const members = [base, ...named.get(base), ...(bases.size === 1 ? extras : [])];
    return {
      members,
      options: members.map(uuid => ({ uuid, selected: selected.has(uuid) }))
    };
  });
}

/** Resolve each group member to a rendered card. */
async function decorateGroups(groups) {
  return Promise.all(groups.map(async g => ({
    members: g.members.join("|"),
    options: await Promise.all(g.options.map(async o => ({ ...o, ...(await itemCard(o.uuid)) })))
  })));
}

/** Name and image for an item uuid, tolerating one that no longer resolves. */
async function itemCard(uuid) {
  const doc = await fromUuid(uuid).catch(() => null);
  return { name: doc?.name ?? uuid, img: doc?.img ?? null };
}
