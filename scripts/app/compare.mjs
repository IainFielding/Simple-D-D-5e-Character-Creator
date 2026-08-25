import { ABILITIES, t, log } from "../config.mjs";
import { advancementArray } from "../data/advancement-util.mjs";

/**
 * Side-by-side comparison of pinned options — the one thing Quick Build cannot do for you.
 *
 * Quick Build answers "I don't know, pick something sensible". This answers the opposite question:
 * "I know exactly what I'm choosing between, and I want them next to each other." A player weighing
 * two subclasses has to pick one, read it, pick the other, read that, and hold the first in their
 * head — the picker shows one detail page at a time, by design. So the comparison happens in
 * memory, which is where it goes wrong.
 *
 * **This module extracts almost nothing itself, and that is the whole design.** The equivalent in
 * other builders runs to a thousand lines because it re-reads every advancement type per category —
 * movement, senses, resistances, scale values, damage parts — building bespoke cells for each. We
 * already do that reading once, in {@link module:data/source-index}: `advancementGroups()` flattens
 * an item's traits and its granted features and spells for the detail pane, and
 * `abilityScoreIncrease()` flattens its ASI for the origin panel. A comparison grid is a *transpose*
 * of what the detail pane already shows — so this file is a transpose, plus the handful of headline
 * fields (`system.spellcasting`, movement, senses) the pane doesn't surface because a single page
 * has room for prose instead.
 *
 * The consequence worth knowing: a row appears here because some pinned item has that trait, not
 * because we listed it. Third-party content that grants something we have never heard of gets a row
 * for it as long as dnd5e's own Trait advancement carries it, and no row when nothing has it.
 *
 * Pins are session state on the shell ({@link PinSet}), not world state: comparing is something you
 * do for thirty seconds on the way to a decision, and a pin that outlived the window would be a
 * second, invisible kind of selection.
 */

/** The pick categories that can be compared. Each maps to a picker that renders a pin control. */
export const COMPARE_CATEGORIES = new Set(["class", "species", "background", "subclass"]);

/**
 * The most columns a comparison may hold.
 *
 * Not a technical limit — the grid would render nine. It is a legibility one: past four columns the
 * cells are too narrow for a skill list to sit on one line, and a grid you have to scroll sideways
 * to read is worse than the two-pass reading this feature exists to replace. Four covers "which of
 * these subclasses", which is the case that prompted it.
 */
export const MAX_PINS = 4;

/* -------------------------------------------- */
/*  The pin store                               */
/* -------------------------------------------- */

/**
 * The set of options pinned for comparison, per category, for the life of one wizard window.
 *
 * An array rather than a Set because insertion order *is* column order — the player pins Champion
 * then Battle Master and expects to read them left to right in that order — and because the cap
 * needs a length.
 */
export class PinSet {
  /** @type {Map<string, string[]>} category → pinned uuids, in pin order. */
  #pins = new Map();

  /**
   * The uuids pinned in a category, in pin order.
   * @param {string} category
   * @returns {string[]}
   */
  list(category) {
    return [...(this.#pins.get(category) ?? [])];
  }

  /** How many options are pinned in a category. */
  count(category) {
    return this.#pins.get(category)?.length ?? 0;
  }

  /** Whether a specific option is pinned. */
  has(category, uuid) {
    return !!this.#pins.get(category)?.includes(uuid);
  }

  /** Whether a category has enough pins to be worth comparing. One column is not a comparison. */
  canCompare(category) {
    return this.count(category) >= 2;
  }

  /**
   * Pin or unpin an option.
   * @param {string} category
   * @param {string} uuid
   * @returns {"added"|"removed"|"full"|"invalid"}  `"full"` when the cap would be exceeded — the
   *   caller says so rather than silently dropping the click.
   */
  toggle(category, uuid) {
    if ( !COMPARE_CATEGORIES.has(category) || !uuid ) return "invalid";
    if ( !this.#pins.has(category) ) this.#pins.set(category, []);
    const pins = this.#pins.get(category);
    const at = pins.indexOf(uuid);
    if ( at >= 0 ) {
      pins.splice(at, 1);
      return "removed";
    }
    if ( pins.length >= MAX_PINS ) return "full";
    pins.push(uuid);
    return "added";
  }

  /** Drop every pin in a category, or in all of them when called bare. */
  clear(category) {
    if ( category ) this.#pins.delete(category);
    else this.#pins.clear();
  }
}

/**
 * Decorate a picker's cards with their pin state and build the toolbar's compare control.
 *
 * Called from a pick step's `context()` — `pinContext(app?.pins, "class", cards)` — so a step opts
 * into comparison with one line and owns none of the logic. Steps run in tests without a shell, so
 * a missing store is not an error: it yields undecorated cards and no control, and the picker
 * renders exactly as it did before this feature existed.
 *
 * @param {PinSet|undefined} pins   The shell's pin store.
 * @param {string} category         One of {@link COMPARE_CATEGORIES}.
 * @param {object[]} cards          The picker's cards; each needs a `uuid`.
 * @returns {{cards: object[], compareCategory: ?string, compare: ?object}}
 */
export function pinContext(pins, category, cards) {
  if ( !pins || !COMPARE_CATEGORIES.has(category) ) return { cards, compareCategory: null, compare: null };
  const count = pins.count(category);
  return {
    cards: cards.map(c => ({ ...c, pinned: pins.has(category, c.uuid) })),
    // Read by the picker templates to decide whether to render a pin button on each row.
    compareCategory: category,
    compare: {
      category,
      count,
      canCompare: pins.canCompare(category),
      // "Compare" alone reads as an invitation with nothing behind it while the count is 0 or 1,
      // which is most of the time; the count is what tells the player the button is loaded.
      label: count ? t("compare.openCount", { count }) : t("compare.open"),
      // A disabled control has to say *why*, or it reads as broken content rather than as something
      // waiting on the player.
      hint: pins.canCompare(category) ? t("compare.tooltip") : t("compare.needTwo")
    }
  };
}

/* -------------------------------------------- */
/*  Building the grid                           */
/* -------------------------------------------- */

/**
 * Which rows a category shows, in order. `"traits"` is a marker rather than a row: it expands to
 * one row per distinct trait the pinned items grant (see {@link traitRows}), which is where most of
 * a background's or a class's comparison actually lives.
 *
 * The placement of `"traits"` is the only per-category judgement in here. A species leads with what
 * it *is* — type, size, speed, senses — and its proficiencies are a footnote; a class leads with the
 * numbers off its PHB table, which `advancementGroups` already emits as its first two trait tags
 * (primary ability, hit die), so there the traits come first and the progression facts follow.
 */
const LAYOUT = {
  class: ["traits", "spellcasting", "subclassLevel", "asiLevels"],
  subclass: ["parentClass", "spellcasting", "traits"],
  species: ["creatureType", "size", "speed", "senses", "originAsi", "traits"],
  background: ["originAsi", "traits"]
};

/** Row builders keyed by the names {@link LAYOUT} uses. Each returns a row, or null when empty. */
const ROWS = {
  spellcasting: entries => textRow("spellcasting", t("compare.row.spellcasting"), "fa-wand-magic-sparkles",
    entries.map(e => spellcastingText(e.doc))),
  subclassLevel: entries => textRow("subclassLevel", t("compare.row.subclassLevel"), "fa-sitemap",
    entries.map(e => levelsText(e.doc, "Subclass"))),
  asiLevels: entries => textRow("asiLevels", t("compare.row.asiLevels"), "fa-arrow-trend-up",
    entries.map(e => levelsText(e.doc, "AbilityScoreImprovement"))),
  parentClass: entries => textRow("parentClass", t("compare.row.parentClass"), "fa-chess-rook",
    entries.map(e => classIdentifierLabel(e.doc))),
  creatureType: entries => textRow("creatureType", t("compare.row.creatureType"), "fa-paw",
    entries.map(e => creatureTypeText(e.doc))),
  size: entries => textRow("size", t("compare.row.size"), "fa-up-right-and-down-left-from-center",
    entries.map(e => sizeText(e.doc))),
  speed: entries => textRow("speed", t("compare.row.speed"), "fa-person-running",
    entries.map(e => movementText(e.doc))),
  senses: entries => textRow("senses", t("compare.row.senses"), "fa-eye",
    entries.map(e => sensesText(e.doc))),
  originAsi: entries => textRow("originAsi", t("compare.row.abilityIncrease"), "fa-dumbbell",
    entries.map(e => asiText(e.asi)))
};

/**
 * Build the whole comparison view-model from a category's pinned uuids.
 *
 * Everything expensive in here is already memoised on the SourceIndex, so re-opening a comparison —
 * or comparing options the player has been reading anyway — costs a few object allocations. A uuid
 * that no longer resolves is dropped rather than rendered as an empty column: content can be
 * disabled between the pin and the click.
 *
 * @param {string} category                                   One of {@link COMPARE_CATEGORIES}.
 * @param {string[]} uuids                                    The pinned uuids, in column order.
 * @param {import("../data/source-index.mjs").SourceIndex} source
 * @returns {Promise<?object>}  The overlay's context, or null when fewer than two columns survive.
 */
export async function buildCompare(category, uuids, source) {
  if ( !COMPARE_CATEGORIES.has(category) ) return null;
  const entries = [];
  for ( const uuid of uuids ) {
    try {
      const doc = await fromUuid(uuid);
      if ( !doc ) {
        log(`compare: ${uuid} no longer resolves — dropping the column`);
        continue;
      }
      entries.push({
        uuid,
        doc,
        detail: await source.detail(uuid, doc),
        groups: await source.advancementGroups(uuid, doc),
        // Only the origin categories show an increase row, so only they pay for reading one.
        asi: (category === "species" || category === "background")
          ? await source.abilityScoreIncrease(uuid, doc)
          : null
      });
    } catch ( err ) {
      log(`compare: could not resolve ${uuid}`, err);
    }
  }
  if ( entries.length < 2 ) return null;
  return {
    category,
    title: t(`compare.title.${category}`),
    columns: entries.map(e => ({
      uuid: e.uuid,
      name: e.detail?.name ?? e.doc.name,
      img: e.detail?.img ?? e.doc.img,
      source: e.detail?.source ?? ""
    })),
    rows: compareRows(category, entries),
    // The column count, handed to CSS as a custom property rather than baked into a class name, so
    // any number between two and MAX_PINS lays out with no extra rule.
    gridStyle: `--cc-compare-cols: ${entries.length};`
  };
}

/**
 * Transpose resolved entries into comparison rows.
 *
 * Split out from {@link buildCompare} and kept free of `fromUuid` and of the SourceIndex so it can
 * be unit-tested against plain objects — the row *set* is the part of this feature with judgement
 * in it, and the part content can surprise.
 *
 * @param {string} category
 * @param {Array<{uuid: string, doc: object, detail: ?object, groups: ?object[], asi: ?object}>} entries
 * @returns {object[]}  Rows, each `{key, label, icon, cells}`; a cell is `{text}` or `{items}`.
 */
export function compareRows(category, entries) {
  const rows = [];
  // The book each option comes from, first. With both editions of the PHB enabled a world lists two
  // Fighters, and this is the row that says which is which — often the reason to compare them.
  rows.push(textRow("source", t("compare.row.source"), "fa-book",
    entries.map(e => e.detail?.source ?? "")));

  for ( const name of LAYOUT[category] ?? ["traits"] ) {
    if ( name === "traits" ) rows.push(...traitRows(entries));
    else rows.push(ROWS[name]?.(entries));
  }

  // The granted items last: they are the longest cells, and everything above is the summary a
  // reader wants before wading into a feature list.
  rows.push(itemRow("features", t("compare.row.features"), "fa-sparkles", entries, "features"));
  rows.push(itemRow("spells", t("compare.row.spells"), "fa-wand-sparkles", entries, "spells"));

  return rows.filter(Boolean);
}

/**
 * One row per distinct trait granted across the pinned items.
 *
 * Two wrinkles, both because the tags were built for a *detail pane* rather than for a grid:
 *
 *  - A choice tag carries its count in the label — "Skills (2)" — so a Fighter and a Ranger would
 *    land on two separate rows for the same trait, defeating the comparison. The count moves into
 *    the value, and the bare trait name becomes the row.
 *  - An item can carry two Trait advancements granting the same category (a fixed grant plus a
 *    choice). In a pane those are two lines under one heading; in a grid they are one cell, joined.
 *
 * Row order follows first appearance across the columns, so the leftmost pinned option sets the
 * order and the others fill in behind it. Deliberate: the first thing pinned is usually the one the
 * player already knows, so the grid reads in the order they are already thinking in.
 *
 * @param {object[]} entries
 * @returns {object[]}
 */
function traitRows(entries) {
  const COUNT = /\s*\((\d+)\)\s*$/;
  /** @type {Map<string, string[]>} trait label → per-column values, index-aligned with `entries`. */
  const byLabel = new Map();
  entries.forEach((entry, column) => {
    const tags = entry.groups?.find(g => g.key === "traits")?.tags ?? [];
    for ( const tag of tags ) {
      const match = COUNT.exec(tag.label);
      const label = match ? tag.label.slice(0, match.index) : tag.label;
      const value = match ? t("compare.chooseN", { count: match[1], options: tag.value }) : tag.value;
      if ( !byLabel.has(label) ) byLabel.set(label, new Array(entries.length).fill(""));
      const cells = byLabel.get(label);
      cells[column] = cells[column] ? `${cells[column]} · ${value}` : value;
    }
  });
  return [...byLabel]
    .map(([label, values]) => textRow(`trait:${label}`, label, "fa-tag", values))
    .filter(Boolean);
}

/* -------------------------------------------- */
/*  Cell formatting                             */
/* -------------------------------------------- */

const abilityLabel = key => CONFIG.DND5E?.abilities?.[key]?.label ?? key.toUpperCase();

/**
 * A text row, or null when no column had anything to say.
 *
 * The null is the point: a row empty across the board is noise in a grid whose whole job is to show
 * difference. A row where *one* column is empty is kept — "this one grants nothing here" is exactly
 * the comparison being made — and reads as an em-dash.
 */
function textRow(key, label, icon, values) {
  const cells = values.map(v => ({ text: String(v ?? "").trim() || "—" }));
  if ( cells.every(c => c.text === "—") ) return null;
  return { key, label, icon: `fa-solid ${icon}`, cells };
}

/**
 * A row of granted items — icon, content-link, level tag — pulled from an advancement block.
 * Same null-when-empty rule as {@link textRow}.
 */
function itemRow(key, label, icon, entries, blockKey) {
  const cells = entries.map(e => {
    const items = e.groups?.find(g => g.key === blockKey)?.items ?? [];
    return items.length ? { items } : { text: "—" };
  });
  if ( cells.every(c => !c.items) ) return null;
  return { key, label, icon: `fa-solid ${icon}`, cells };
}

/** "Full caster (Intelligence)", or "" for anything that doesn't cast. */
function spellcastingText(doc) {
  const casting = doc?.system?.spellcasting;
  const progression = casting?.progression;
  if ( !progression || progression === "none" ) return "";
  const raw = CONFIG.DND5E?.spellProgression?.[progression]?.label;
  // dnd5e builds this map at i18nInit from the registered spellcasting methods, where the labels are
  // already localized; `localize` on localized text is a no-op, so this is safe either way and still
  // covers a package that registers a method carrying a raw key.
  const label = raw ? game.i18n.localize(raw) : progression;
  return casting.ability ? `${label} (${abilityLabel(casting.ability)})` : label;
}

/**
 * The levels at which an item carries a given advancement type — "4, 8, 12, 16, 19" for a class's
 * ability score improvements, "3" for the level its subclass unlocks.
 *
 * Read off the advancements rather than hardcoded, because both of those move: 2014 classes take
 * their subclass at 1, 2 or 3 depending on the class, Rogue and Fighter get extra ASIs, and a
 * third-party class can do whatever it likes.
 */
function levelsText(doc, type) {
  const levels = [...new Set(advancementArray(doc)
    .filter(a => (a.type ?? a.constructor?.typeName) === type)
    .map(a => Number(a.level ?? a._source?.level ?? 0))
    .filter(l => l > 0))].sort((a, b) => a - b);
  return levels.join(", ");
}

/** A subclass's parent class, from its identifier ("battle-master" → "Battle Master"). */
function classIdentifierLabel(doc) {
  const id = doc?.system?.classIdentifier;
  if ( !id ) return "";
  return String(id).split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * A species' creature type. `typeLabel` is the data model's own getter, so a swarm, a custom type
 * and a subtype all come out worded the way the item sheet words them.
 */
function creatureTypeText(doc) {
  const label = doc?.system?.typeLabel;
  if ( label ) return label;
  const value = doc?.system?.type?.value;
  return value ? (CONFIG.DND5E?.creatureTypes?.[value]?.label ?? value) : "";
}

/**
 * A species' size, which is *not* a field on the item — dnd5e delivers it as a Size advancement,
 * whose configuration is the set of sizes the species may be. Usually one ("Medium"); a species that
 * lets the player choose lists both, which is itself worth seeing in a comparison.
 */
function sizeText(doc) {
  const sizes = new Set();
  for ( const adv of advancementArray(doc) ) {
    if ( (adv.type ?? adv.constructor?.typeName) !== "Size" ) continue;
    // A prepared advancement holds a Set here, raw source data an array; both iterate.
    for ( const size of adv.configuration?.sizes ?? [] ) sizes.add(size);
  }
  return [...sizes].map(s => CONFIG.DND5E?.actorSizes?.[s]?.label ?? s).join(" / ");
}

/**
 * A species' movement, and its senses below — both from the data model's own label getters, which
 * handle the units setting and the "special" free-text field the schema carries alongside the
 * numbers. Falling back to the raw fields keeps this working against a plain object in tests, and
 * against content whose model never prepared.
 */
function movementText(doc) {
  const labels = doc?.system?.movementLabels;
  if ( labels ) return Object.values(labels).join(", ");
  const movement = doc?.system?.movement;
  if ( !movement ) return "";
  const units = movement.units || "ft";
  return Object.entries(CONFIG.DND5E?.movementTypes ?? {})
    .filter(([key]) => Number(movement[key]) > 0)
    .map(([key, cfg]) => `${cfg?.label ?? key} ${movement[key]} ${units}`)
    .join(", ");
}

/** A species' senses — see {@link movementText}. */
function sensesText(doc) {
  const labels = doc?.system?.sensesLabels;
  if ( labels ) return [...labels].join(", ");
  const senses = doc?.system?.senses;
  // dnd5e moved the numbers under `ranges`; older data holds them on `senses` itself.
  const ranges = senses?.ranges ?? senses;
  if ( !ranges ) return "";
  const units = senses.units || "ft";
  return Object.entries(CONFIG.DND5E?.senses ?? {})
    .filter(([key]) => Number(ranges[key]) > 0)
    .map(([key, label]) => `${typeof label === "string" ? label : (label?.label ?? key)} ${ranges[key]} ${units}`)
    .join(", ");
}

/**
 * An origin's ability score increase, in the same words the increase panel uses.
 *
 * Both shapes have to read clearly side by side, because the point of comparing 2014 species or 2024
 * backgrounds is that they differ here: a fixed grant is "+2 Constitution, +1 Wisdom", a budget is
 * "3 points (max +2 each) across Str, Con, Wis", and the Half-Elf is both at once.
 */
function asiText(asi) {
  if ( !asi ) return "";
  const parts = [];
  const fixed = ABILITIES
    .filter(k => Number(asi.fixed?.[k] ?? 0) > 0)
    .map(k => `+${asi.fixed[k]} ${abilityLabel(k)}`);
  if ( fixed.length ) parts.push(fixed.join(", "));
  if ( asi.points > 0 ) {
    const open = ABILITIES.filter(k => !(asi.locked ?? []).includes(k));
    const scope = open.length === ABILITIES.length
      ? t("compare.anyAbility")
      : open.map(abilityLabel).join(", ");
    parts.push(t("compare.pointsToSpend", { points: asi.points, cap: asi.cap, abilities: scope }));
  }
  return parts.join(" · ");
}
