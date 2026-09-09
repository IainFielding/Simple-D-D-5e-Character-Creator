import { t, log } from "../config.mjs";
import { getEnabledPacks } from "./compendium-util.mjs";
import { createItemData } from "./item-factory.mjs";
import { TOOL_IMG, toolCategoryKey, toolChoices } from "./tool-source.mjs";
import { forEachLimit, WARM_CONCURRENCY } from "./concurrency.mjs";

/**
 * Resolves a class's and background's starting equipment into selectable options, and
 * later collects the chosen gear (and currency) for the build. Options come straight
 * from each item's `system.startingEquipment` tree: a root OR exposes each branch as a
 * lettered option, a root AND is option A, and a non-zero `system.wealth` adds a final
 * "gold" option. Nested OR/tool/focus picks become inline sub-choices.
 *
 * One instance per builder session; built option sets are memoised per origin UUID. It
 * reads selections from `state.equipment` but is otherwise free of UI/state coupling.
 *
 * For a junior dev: dnd5e stores starting gear as a small tree of nodes, each with a `type`:
 *   AND      – take all children together (a bundle)
 *   OR       – choose one child (this is what becomes a lettered A/B/C option)
 *   linked   – a specific item (a leaf)
 *   tool     – "any tool of category X" — expands to a sub-pick (see tool-source.mjs)
 *   currency – a lump of starting gold
 * We flatten that tree into player-facing "options" (A, B, C…), remembering their choice in
 * state.equipment[key] as { selectedOption, orSelections }, and later read it back to grant the gear.
 */

const VALID_TYPES = new Set(["AND", "OR", "linked", "currency", "tool"]);
// Letters used to label the top-level options a player chooses between (Option A, Option B, …).
const OPTION_LABELS = "ABCDEFGH";

/** Spellcasting-focus picks per class identifier; items are referenced by identifier. */
const CLASS_FOCUS_CHOICES = {
  wizard:  { label: "equipment.focus.arcane",  ids: ["crystal", "orb", "rod", "staff", "wand"] },
  druid:   { label: "equipment.focus.druidic", ids: ["sprig-of-mistletoe", "wooden-staff", "yew-wand"] },
  ranger:  { label: "equipment.focus.druidic", ids: ["sprig-of-mistletoe", "wooden-staff", "yew-wand"] },
  cleric:  { label: "equipment.focus.holy",    ids: ["amulet", "emblem", "reliquary"] },
  paladin: { label: "equipment.focus.holy",    ids: ["amulet", "emblem", "reliquary"] }
};

export class EquipmentSource {

  /** origin uuid -> { name, img, options }, memoised. */
  #cache = new Map();
  /** focus identifier -> {uuid,name,img}|null, memoised. */
  #focusCache = new Map();

  /**
   * Build the option sets for the chosen class & background and seed default sub-choices.
   *
   * Origins normally arrive as compendium UUIDs on the state (`classUuid`/`backgroundUuid`). A state
   * may instead hand over the origin *documents* via `equipmentDocs()` — the Ember hand-off does,
   * because Ember synthesises its background from a culture and a path at completion time, so it
   * exists only as an item on the advancement clone and has no compendium entry to resolve.
   * @returns {Promise<{class?: object, background?: object}>}
   */
  async load(state, source) {
    const out = {};
    const docs = state.equipmentDocs?.() ?? null;
    for ( const [key, field] of [["class", "classUuid"], ["background", "backgroundUuid"]] ) {
      const staged = docs?.[key] ?? null;
      // Cache staged origins under the compendium entry they were copied from where there is one
      // (a class), so every character shares that option set; a synthesised origin (Ember's
      // background) falls back to its own uuid, which is unique to the character being built.
      const uuid = staged ? (staged._stats?.compendiumSource ?? staged.uuid) : state[field];
      if ( !uuid ) continue;
      const data = await this.#buildFor(uuid, key, source, staged);
      if ( !data ) continue;
      out[key] = data;

      const eq = state.equipment[key] ?? (state.equipment[key] = { selectedOption: 0, orSelections: {} });
      if ( eq.selectedOption == null ) eq.selectedOption = 0;
      for ( const opt of data.options ) if ( opt.tree ) seedOrSelections(eq.orSelections, opt.tree);
    }
    return out;
  }

  /**
   * Pre-build the starting-equipment option sets for every class and background up front, so
   * reaching the Choices step (or switching origin there) is instant rather than paying a cold
   * compendium read — the tool-category and spellcasting-focus lookups it performs request index
   * fields not loaded by the initial origin index, which would otherwise force Foundry to
   * re-index every pack on the click. Memoised per origin UUID via {@link #buildFor}; one
   * origin's failure is swallowed so it can't abort the rest of the warm-up.
   * @param {import("./source-index.mjs").SourceIndex} source
   * @param {() => void} [onTick]  Invoked once per origin warmed, for progress reporting.
   */
  async warmAll(source, onTick) {
    const origins = [
      ...source.classes().map(c => ["class", c.uuid]),
      ...source.backgrounds().map(c => ["background", c.uuid])
    ];
    await forEachLimit(origins, WARM_CONCURRENCY, async ([key, uuid]) => {
      try {
        await this.#buildFor(uuid, key, source);
      } catch ( err ) {
        log(`failed to warm equipment for ${uuid}`, err);
      }
      onTick?.();
    });
  }

  /**
   * @param {string} uuid            Cache key: the origin's compendium UUID, or a staged document's own.
   * @param {"class"|"background"} key
   * @param {import("./source-index.mjs").SourceIndex} source
   * @param {Item5e|null} [staged]   An already-resolved origin document (see {@link load}); when
   *   given, nothing is fetched — the tree is read straight off it.
   */
  async #buildFor(uuid, key, source, staged = null) {
    if ( this.#cache.has(uuid) ) return this.#cache.get(uuid);
    const doc = staged ?? await fromUuid(uuid).catch(() => null);
    if ( !doc ) return null;

    const entries = doc.system?.startingEquipment ?? [];
    const wealth = doc.system?.wealth ?? "0";
    const roots = [...entries]
      .filter(e => !e.group && VALID_TYPES.has(e.type))
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

    const options = [];
    if ( roots.length ) {
      const root = buildNode(roots[0]);
      if ( root.type === "OR" ) {
        for ( const child of root.children ) { await this.#resolveNodes(child); options.push({ type: "equipment", tree: child }); }
      } else {
        await this.#resolveNodes(root);
        options.push({ type: "equipment", tree: root });
      }
    }
    if ( parseInt(wealth) > 0 ) options.push({ type: "gold", wealth });
    if ( !options.length ) { this.#cache.set(uuid, null); return null; }

    options.forEach((opt, i) => { opt.label = OPTION_LABELS[i] ?? String(i + 1); });

    // Description-embedded gold (fallback for classes that state gold in prose).
    const descHTML = doc.system?.description?.value ?? "";
    for ( const opt of options ) {
      if ( opt.type === "equipment" ) opt.descriptionGold = extractDescriptionGold(descHTML, opt.label);
    }

    // Spellcasting focus pick (class only).
    if ( key === "class" ) await this.#expandFocusChoice(doc.system?.identifier ?? "", options);

    const card = source.card(uuid);
    const data = { name: card?.name ?? doc.name, img: card?.img ?? doc.img, options };
    this.#cache.set(uuid, data);
    return data;
  }

  /** Resolve linked-item names/images and tool category choices throughout a tree. */
  async #resolveNodes(node) {
    if ( node.type === "linked" && node.key ) {
      const doc = await fromUuid(node.key).catch(() => null);
      if ( doc ) { node.name = doc.name; node.img = doc.img; node.identifier = doc.system?.identifier ?? null; }
      else log(`equipment item did not resolve: ${node.key}`);
    }
    if ( node.type === "tool" && node.key ) {
      node.name = dnd5e.documents.Trait?.keyLabel?.(`tool:${node.key}`) ?? node.key;
      node.img = TOOL_IMG[node.key] ?? null;
      const category = toolCategoryKey(node.key);
      if ( category ) {
        const choices = await toolChoices(category);
        if ( choices.length ) { node.isToolChoice = true; node.choices = choices; }
      }
    }
    for ( const child of node.children ?? [] ) await this.#resolveNodes(child);
  }

  /** Add the class's focus pick to each equipment option, converting or injecting a node. */
  async #expandFocusChoice(classId, options) {
    const cfg = CLASS_FOCUS_CHOICES[classId];
    if ( !cfg?.ids?.length ) return;
    const choices = await this.#focusItems(cfg.ids);
    if ( choices.length <= 1 ) return;

    const ids = new Set(cfg.ids);
    const uuids = new Set(choices.map(c => c.uuid));
    const label = t("equipment.choosePrompt", { label: t(cfg.label) });
    const isFocus = n => n.type === "linked" && (ids.has(n.identifier) || uuids.has(n.key));

    for ( const opt of options ) {
      if ( opt.type !== "equipment" || !opt.tree ) continue;
      const node = findNode(opt.tree, isFocus) ?? injectFocusNode(opt);
      node.isFocusChoice = true;
      node.choices = choices;
      node.choiceLabel = label;
    }
  }

  /** Resolve focus items by identifier from the world's equipment packs, cached per id. */
  async #focusItems(ids) {
    const want = new Set(ids.filter(id => !this.#focusCache.has(id)));
    if ( want.size ) {
      const PRIORITY = ["dnd-players-handbook.equipment", "dnd5e.equipment24", "dnd5e.equipment"];
      const rankOf = c => { const i = PRIORITY.findIndex(p => c.startsWith(p)); return i >= 0 ? i : PRIORITY.length; };
      const enabled = getEnabledPacks();
      const best = new Map();
      for ( const pack of game.packs ) {
        if ( pack.metadata.type !== "Item" ) continue;
        if ( pack.metadata.system && pack.metadata.system !== "dnd5e" ) continue;
        if ( enabled && !enabled.has(pack.collection) ) continue;
        try {
          const index = await pack.getIndex({ fields: ["system.identifier"] });
          for ( const e of index ) {
            const id = e.system?.identifier;
            if ( !id || !want.has(id) ) continue;
            const rank = rankOf(pack.collection);
            const existing = best.get(id);
            if ( !existing || rank < existing.rank ) best.set(id, { uuid: e.uuid, name: e.name, img: e.img, rank });
          }
        } catch ( err ) {
          log(`focus item scan failed for ${pack.collection}`, err);
        }
      }
      for ( const id of want ) {
        const c = best.get(id);
        this.#focusCache.set(id, c ? { uuid: c.uuid, name: c.name, img: c.img } : null);
      }
    }
    return ids.map(id => this.#focusCache.get(id)).filter(Boolean);
  }
}

/* -------------------------------------------- */
/*  Display & collection (pure helpers)         */
/* -------------------------------------------- */

/**
 * Display rows for the selected option of one equipment source, given the player's
 * inline OR/tool/focus selections. Currency rows are separated out for the summary.
 */
export function describeOption(data, eqState) {
  const selectedIdx = eqState.selectedOption ?? 0;
  const opt = data.options[selectedIdx];
  const rows = opt?.type === "equipment" ? flattenTree(opt.tree, eqState.orSelections) : [];
  return {
    options: data.options.map((o, i) => ({
      index: i, label: o.label, isGold: o.type === "gold", wealth: o.wealth,
      isSelected: i === selectedIdx
    })),
    isGold: opt?.type === "gold",
    wealth: opt?.wealth,
    // `isOrGroup` lets the template branch without a comparison helper.
    rows: rows.filter(r => !r.isCurrency).map(r => ({ ...r, isOrGroup: r.type === "or-group" })),
    currency: rows.filter(r => r.isCurrency).map(r => r.name).join(", ")
      || (opt?.descriptionGold ? `${opt.descriptionGold} GP` : "")
  };
}

/**
 * A flat summary of one source's selected option for the review page: each OR/focus/tool
 * choice collapsed to the picked item, plus a combined gold string.
 * @returns {{items: {name:string, img:?string, count:?number, uuid:?string}[], gold: string}}
 */
export function summarizeOption(data, eqState) {
  const opt = data.options[eqState.selectedOption ?? 0];
  if ( !opt ) return { items: [], gold: "" };
  if ( opt.type === "gold" ) return { items: [], gold: `${opt.wealth} GP` };

  const items = [];
  const goldParts = [];
  for ( const r of flattenTree(opt.tree, eqState.orSelections) ) {
    if ( r.type === "or-group" ) {
      if ( r.isBranch ) continue;          // branch router — the nested selector carries the real pick
      const sel = r.options.find(o => o.isSelected) ?? r.options[0];
      if ( sel ) items.push({ name: sel.name, img: sel.img, count: sel.count, uuid: sel.uuid ?? null });
    } else if ( r.isCurrency ) {
      goldParts.push(r.name);
    } else {
      items.push({ name: r.name, img: r.img, count: r.count, uuid: r.uuid ?? null });
    }
  }
  let gold = goldParts.join(", ");
  if ( !gold && opt.descriptionGold ) gold = `${opt.descriptionGold} GP`;
  return { items, gold };
}

/**
 * Every origin's selected equipment, summarised for a review screen and keyed by the origin that
 * granted it. A source with nothing to show is omitted, so the map can be rendered as-is.
 *
 * The selection is read back from the wizard's own state rather than off the character, because
 * starting gear is not an advancement: nothing has been written to the actor at the point either
 * review runs. A source the player never reached carries no selection, and is skipped —
 * {@link summarizeOption} indexes into its argument and would throw on one.
 * @param {Record<string, object>} loaded      The loaded equipment trees, by origin key.
 * @param {Record<string, object>} selection   The player's picks (`state.equipment`).
 * @returns {Record<string, {items: object[], gold: string, hasAny: boolean}>}
 */
export function summarizeEquipment(loaded, selection) {
  const out = {};
  for ( const key of ["class", "background"] ) {
    if ( !loaded?.[key] || !selection?.[key] ) continue;
    const { items, gold } = summarizeOption(loaded[key], selection[key]);
    if ( !items.length && !gold ) continue;
    out[key] = { items, gold, hasAny: true };
  }
  return out;
}

/** Flatten an equipment tree into display rows (items, currency, and inline OR selectors). */
function flattenTree(node, orSelections = {}) {
  if ( !node ) return [];
  if ( node.type === "AND" ) return node.children.flatMap(c => flattenTree(c, orSelections));
  if ( node.type === "OR" ) {
    if ( !node.children.length ) return [];
    if ( node.children.length === 1 ) return flattenTree(node.children[0], orSelections);
    const selected = orSelections[node._id] ?? node.children[0]._id;
    const rows = [{
      type: "or-group", _id: node._id,
      options: node.children.map(c => ({
        _id: c._id, name: c.name ?? t("equipment.unknown"), img: c.img,
        // Tool branches carry a category key ("art"), not a compendium uuid — no item tooltip.
        count: c.count, uuid: c.type === "tool" ? null : (c.key ?? null), isSelected: c._id === selected
      }))
    }];
    // If the chosen branch is itself a further choice (e.g. which specific Musical Instrument
    // once "Musical Instrument" is picked over "Artisan's Tools"), surface that nested selector.
    // The outer row then just routes the branch — `isBranch` tells the summary to skip it so the
    // collapsed pick reflects the specific tool, not the category, matching `collectTree`.
    const chosen = node.children.find(c => c._id === selected) ?? node.children[0];
    for ( const sub of flattenTree(chosen, orSelections) ) {
      if ( sub.type === "or-group" ) { rows.push(sub); rows[0].isBranch = true; }
    }
    return rows;
  }
  if ( node.type === "linked" ) {
    if ( node.isFocusChoice && node.choices?.length > 1 ) return [focusGroup(node, orSelections)];
    return [{ type: "item", _id: node._id, name: node.name ?? t("equipment.unknown"),
      img: node.img ?? "icons/svg/item-bag.svg", count: node.count ?? null, uuid: node.key ?? null }];
  }
  if ( node.type === "tool" ) {
    if ( node.isToolChoice && node.choices?.length ) {
      if ( node.choices.length === 1 ) {
        const c = node.choices[0];
        return [{ type: "item", _id: node._id, name: c.name, img: c.img ?? "icons/svg/trophy.svg", count: null, uuid: c.uuid ?? null }];
      }
      return [focusGroup(node, orSelections, node.name)];
    }
    return [{ type: "item", _id: node._id, name: node.name ?? t("traitChoice.tool"),
      img: node.img ?? "icons/svg/trophy.svg", count: node.count ?? null }];
  }
  if ( node.type === "currency" ) {
    const amount = parseInt(node.count ?? 0) || 0;
    return [{ type: "item", _id: node._id, isCurrency: true,
      name: `${amount} ${(node.key ?? "gp").toUpperCase()}` }];
  }
  return [];
}

/** Inline pick-one selector row for a focus / tool-category / OR choice. */
function focusGroup(node, orSelections, promptName) {
  const choices = node.choices;
  const selected = orSelections[node._id] ?? choices[0].uuid;
  return {
    type: "or-group", _id: node._id,
    label: node.choiceLabel ?? t("equipment.choosePrompt", { label: promptName ?? t("equipment.one") }),
    options: choices.map(c => ({ _id: c.uuid, uuid: c.uuid, name: c.name, img: c.img, isSelected: c.uuid === selected }))
  };
}

/**
 * Collect the chosen gear and currency for the build across both sources.
 *
 * `currencyOnly` runs the exact same selection walk but skips resolving/creating item data,
 * so callers that only need the money side of the choice (the store step's spendable budget)
 * share this one implementation without paying the compendium reads.
 * @returns {Promise<{items: object[], currency: Record<string, number>}>}
 */
export async function collectEquipment(loaded, state, { currencyOnly = false } = {}) {
  const items = [];
  const currency = {};
  for ( const key of ["class", "background"] ) {
    const data = loaded[key];
    if ( !data ) continue;
    const eq = state.equipment[key];
    const opt = data.options[eq.selectedOption ?? 0];
    if ( !opt ) continue;
    if ( opt.type === "gold" ) {
      currency.gp = (currency.gp ?? 0) + (parseInt(opt.wealth ?? "0") || 0);
    } else if ( opt.type === "equipment" ) {
      const collected = await collectTree(opt.tree, eq.orSelections, currencyOnly);
      for ( const entry of collected ) {
        if ( entry._currencyDenomination ) {
          currency[entry._currencyDenomination] = (currency[entry._currencyDenomination] ?? 0) + entry._currencyAmount;
        } else items.push(entry);
      }
      if ( opt.descriptionGold && !collected.some(e => e._currencyDenomination === "gp") ) {
        currency.gp = (currency.gp ?? 0) + opt.descriptionGold;
      }
    }
  }
  return { items, currency };
}

/**
 * Resolve a tree into item data (equipped by default) and currency markers. With
 * `currencyOnly` the walk is identical but item leaves yield nothing, so no compendium
 * document is ever resolved.
 */
async function collectTree(node, orSelections = {}, currencyOnly = false) {
  if ( !node ) return [];
  if ( node.type === "AND" ) {
    const out = [];
    for ( const child of node.children ) out.push(...await collectTree(child, orSelections, currencyOnly));
    return out;
  }
  if ( node.type === "OR" ) {
    const selected = orSelections[node._id] ?? node.children[0]?._id;
    const chosen = node.children.find(c => c._id === selected) ?? node.children[0];
    return chosen ? collectTree(chosen, orSelections, currencyOnly) : [];
  }
  if ( node.type === "currency" ) {
    const amount = parseInt(node.count ?? 0) || 0;
    return amount > 0 ? [{ _currencyDenomination: node.key ?? "gp", _currencyAmount: amount }] : [];
  }
  if ( currencyOnly ) return [];
  if ( node.type === "tool" ) {
    if ( !node.isToolChoice || !node.choices?.length ) return [];
    const uuid = node.choices.length === 1 ? node.choices[0].uuid : (orSelections[node._id] ?? node.choices[0].uuid);
    return createItemData(uuid, { context: "equipment item" });
  }
  if ( node.type === "linked" && (node.key || node.isFocusChoice) ) {
    const uuid = node.isFocusChoice && node.choices?.length
      ? (node.choices.length === 1 ? node.choices[0].uuid : (orSelections[node._id] ?? node.choices[0].uuid))
      : node.key;
    return createItemData(uuid, { qty: node.count ?? 1, context: "equipment item" });
  }
  return [];
}

/* -------------------------------------------- */
/*  Tree-shape utilities                        */
/* -------------------------------------------- */

/**
 * Plain tree node from a live EquipmentEntryData instance (its `.children` getter).
 *
 * Every tree walker below ({@link flattenTree}, {@link collectTree}, {@link seedOrSelections})
 * branches on these five node types:
 *   • AND      — a bundle: take all children.
 *   • OR       — a choice: take one child branch (the player's `orSelections` picks which).
 *   • linked   — a concrete compendium item (may host a spellcasting-focus sub-choice).
 *   • tool     — a tool proficiency, possibly a "pick one from this category" sub-choice.
 *   • currency — a coin amount (e.g. 15 GP).
 */
function buildNode(entry) {
  return {
    _id: entry._id, type: entry.type,
    count: entry.count ?? null, key: entry.key ?? null,
    group: entry.group ?? null, sort: entry.sort ?? 0,
    children: (entry.children ?? []).filter(c => VALID_TYPES.has(c.type)).map(buildNode)
  };
}

/** Seed default selections for nested OR / tool / focus choice nodes. */
function seedOrSelections(orSelections, node) {
  if ( node.type === "OR" && node.children.length > 1 ) orSelections[node._id] ??= node.children[0]._id;
  if ( node.type === "tool" && node.isToolChoice && node.choices?.length > 1 ) orSelections[node._id] ??= node.choices[0].uuid;
  if ( node.type === "linked" && node.isFocusChoice && node.choices?.length > 1 ) orSelections[node._id] ??= node.choices[0].uuid;
  for ( const child of node.children ?? [] ) seedOrSelections(orSelections, child);
}

/** Depth-first search for the first node matching a predicate. */
function findNode(node, predicate) {
  if ( !node ) return null;
  if ( predicate(node) ) return node;
  for ( const child of node.children ?? [] ) {
    const found = findNode(child, predicate);
    if ( found ) return found;
  }
  return null;
}

/** Append a synthetic linked node to host an injected focus choice. */
function injectFocusNode(opt) {
  const node = { type: "linked", _id: `focus-${foundry.utils.randomID()}`, key: null, count: null, children: [] };
  if ( opt.tree?.type === "AND" ) opt.tree.children.push(node);
  else opt.tree = { type: "AND", _id: `focus-and-${foundry.utils.randomID()}`, children: [opt.tree, node].filter(Boolean) };
  return node;
}

/** Extract the GP amount for an option label from item description HTML. */
function extractDescriptionGold(html, label) {
  if ( !html ) return null;
  const text = html.replace(/<[^>]+>/g, " ");
  const marker = `(${label})`;
  const start = text.indexOf(marker);
  if ( start < 0 ) return null;
  const after = text.slice(start + marker.length);
  const end = after.match(/;\s*(?:or\s+)?\([A-Z]\)/i);
  const section = end ? after.slice(0, end.index) : after.split(/[\n\r]/)[0];
  const award = section.match(/\[\[\/award\s+(\d+)\s*gp\]\]/i);
  if ( award ) return parseInt(award[1]);
  const gp = section.match(/\band\s+(\d+)\s*GP\b/i) ?? section.match(/,\s*(\d+)\s*GP\b/i);
  return gp ? parseInt(gp[1]) : null;
}
