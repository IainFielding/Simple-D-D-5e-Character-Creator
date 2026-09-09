import { storeConfig, log } from "../config.mjs";
import { collectEquipment } from "./equipment-source.mjs";
import { createItemData } from "./item-factory.mjs";

/**
 * The starting-gold store's data layer: what's on the shelves and what it costs.
 *
 * Stock is the GM's curated inventory list from the `storeConfig` setting — entries of
 * `{uuid, name, img, type, baseCp, overrideCp, hidden}` managed exclusively in the
 * Configure Store window (drag items in, override prices, hide or remove rows). A fresh
 * world starts from the factory UUID list ({@link module:data/store-defaults}); those
 * skeleton entries carry only a `uuid` until {@link hydrateEntries} resolves the item and
 * snapshots its name, icon, and price. The snapshots make the shelf render without any
 * compendium reads; the uuid stays the source of truth and the item is re-resolved at
 * purchase time.
 *
 * All money is normalised to **copper** (dnd5e's currency conversion rates) so budget,
 * price, and cart arithmetic are integer-safe; formatting back to gp/sp/cp happens only
 * at the display edge. The price/entry/cart helpers are pure functions, exported for
 * unit tests; only {@link StoreSource} itself touches Foundry's document resolvers.
 *
 * One instance lives in the warm-once source cache ({@link module:data/source-cache}) on
 * the EquipmentSource pattern: no per-session state.
 */

/* -------------------------------------------- */
/*  Price math (pure)                           */
/* -------------------------------------------- */

/** Copper pieces per one unit of each denomination, dnd5e's standard rates. */
const FALLBACK_CONVERSION = { pp: 0.1, gp: 1, ep: 2, sp: 10, cp: 100 };

/** dnd5e's conversion rate for a denomination (units per 1 gp), with a rules fallback. */
function conversionRate(denomination) {
  const raw = Number(globalThis.CONFIG?.DND5E?.currencies?.[denomination]?.conversion);
  if ( Number.isFinite(raw) && raw > 0 ) return raw;
  return FALLBACK_CONVERSION[denomination] ?? 1;
}

/**
 * Normalise an amount of one denomination to whole copper pieces.
 * @param {number} amount
 * @param {string} [denomination]
 * @returns {number}
 */
export function toCopper(amount, denomination = "gp") {
  const value = Number(amount);
  if ( !Number.isFinite(value) ) return 0;
  return Math.round(value * (100 / conversionRate(denomination)));
}

/**
 * A currency map (denomination -> amount) summed into copper pieces.
 * @param {Record<string, number>} currency
 * @returns {number}
 */
export function totalCp(currency) {
  let sum = 0;
  for ( const [denomination, amount] of Object.entries(currency ?? {}) ) {
    sum += toCopper(amount, denomination);
  }
  return sum;
}

/**
 * Apply the GM's price multiplier to a base copper price. Anything priced ends up
 * costing at least 1 cp so a heavy discount can't make items free.
 * @param {number} baseCp
 * @param {number} [multiplier]
 * @returns {number}
 */
export function multiplyCp(baseCp, multiplier = 1) {
  const base = Number(baseCp) || 0;
  if ( base <= 0 ) return 0;
  const mult = Number.isFinite(Number(multiplier)) && Number(multiplier) > 0 ? Number(multiplier) : 1;
  return Math.max(1, Math.round(base * mult));
}

/**
 * A store price in copper: the item's `system.price {value, denomination}` normalised,
 * with the GM's multiplier applied.
 * @param {{value: number, denomination?: string}|null} price
 * @param {number} [multiplier]
 * @returns {number} Whole copper pieces, or 0 for a missing/non-positive price.
 */
export function priceCp(price, multiplier = 1) {
  return multiplyCp(toCopper(price?.value ?? 0, price?.denomination || "gp"), multiplier);
}

/**
 * Format a copper amount for display, largest denomination first ("15 gp", "7 sp 5 cp").
 * @param {number} cp
 * @returns {string}
 */
export function formatCp(cp) {
  const value = Math.max(0, Math.round(Number(cp) || 0));
  const gp = Math.floor(value / 100);
  const sp = Math.floor((value % 100) / 10);
  const rest = value % 10;
  const parts = [];
  if ( gp ) parts.push(`${gp} gp`);
  if ( sp ) parts.push(`${sp} sp`);
  if ( rest || !parts.length ) parts.push(`${rest} cp`);
  return parts.join(" ");
}

/**
 * Express a copper amount as a gp/sp/cp currency map (for the actor's currency fields).
 * @param {number} cp
 * @returns {{gp: number, sp: number, cp: number}}
 */
export function fromCopper(cp) {
  const value = Math.max(0, Math.round(Number(cp) || 0));
  return { gp: Math.floor(value / 100), sp: Math.floor((value % 100) / 10), cp: value % 10 };
}

/* -------------------------------------------- */
/*  Inventory entries (pure)                    */
/* -------------------------------------------- */

/** The item types the store can stock: priced physical gear (mirrors dnd5e's physical types). */
export const PHYSICAL_TYPES = ["weapon", "equipment", "consumable", "tool", "container", "loot"];

/** The stored shelf-icon fallback for items without art. */
const FALLBACK_IMG = "icons/svg/item-bag.svg";

/**
 * Guard one stored inventory entry field by field, so a hand-edited setting or an older
 * shape can never break the shelf. A skeleton entry (just a `uuid`, e.g. the factory
 * default list) passes through with an empty name — {@link hydrateEntries} fills it in.
 * @param {object} raw
 * @returns {{uuid: string, name: string, img: string, type: string, subtype: string,
 *            baseCp: number, overrideCp: number|null, hidden: boolean}}
 */
export function sanitizeEntry(raw) {
  const entry = raw && typeof raw === "object" ? raw : {};
  const baseCp = Number(entry.baseCp);
  const overrideCp = Number(entry.overrideCp);
  return {
    uuid: typeof entry.uuid === "string" ? entry.uuid : "",
    name: typeof entry.name === "string" ? entry.name : "",
    img: typeof entry.img === "string" && entry.img ? entry.img : FALLBACK_IMG,
    type: typeof entry.type === "string" ? entry.type : "",
    subtype: typeof entry.subtype === "string" ? entry.subtype : "",
    baseCp: Number.isFinite(baseCp) && baseCp > 0 ? Math.round(baseCp) : 0,
    overrideCp: Number.isFinite(overrideCp) && overrideCp > 0 ? Math.round(overrideCp) : null,
    hidden: !!entry.hidden
  };
}

/**
 * Build a full inventory entry from a resolved Item document (a drag-drop add, or a
 * skeleton entry being hydrated): the display/price snapshot plus untouched defaults.
 * @param {object} item          An Item document (or index-entry-shaped object).
 * @param {string} [uuid]        The uuid to store; defaults to the item's own.
 * @returns {object}             A sanitized entry.
 */
export function entryFromItem(item, uuid) {
  return {
    uuid: uuid ?? item?.uuid ?? "",
    name: item?.name ?? "",
    img: item?.img || FALLBACK_IMG,
    type: item?.type ?? "",
    subtype: item?.system?.type?.value ?? "",   // dnd5e's per-category subtype key
    baseCp: priceCp(item?.system?.price),
    overrideCp: null,
    hidden: false
  };
}

/**
 * The effective shelf price of one entry in copper: the GM's per-item override when set,
 * else the snapshot base price scaled by the global multiplier.
 * @param {{baseCp: number, overrideCp: number|null}} entry
 * @param {number} [multiplier]
 * @returns {number}
 */
export function effectiveCp(entry, multiplier = 1) {
  const override = Number(entry?.overrideCp);
  if ( Number.isFinite(override) && override > 0 ) return Math.round(override);
  return multiplyCp(entry?.baseCp ?? 0, multiplier);
}

/**
 * Parse the GM's price-override inputs (a number string and a denomination) into copper.
 * Blank, non-numeric, and non-positive values all mean "no override" — never a free item.
 * @param {string|number} value
 * @param {string} [denomination]
 * @returns {number|null}
 */
export function parsePriceInput(value, denomination = "gp") {
  const raw = String(value ?? "").trim();
  if ( !raw ) return null;
  const amount = Number(raw);
  if ( !Number.isFinite(amount) || amount <= 0 ) return null;
  const cp = toCopper(amount, denomination);
  return cp > 0 ? cp : null;
}

/**
 * Re-express a copper amount as the largest denomination that divides it cleanly, for
 * pre-filling the override inputs (1500 → 15 gp, 30 → 3 sp, 7 → 7 cp).
 * @param {number} cp
 * @returns {{value: number, denomination: string}}
 */
export function cpToPriceParts(cp) {
  const value = Math.max(0, Math.round(Number(cp) || 0));
  if ( value > 0 ) {
    for ( const denomination of ["pp", "gp", "ep", "sp"] ) {
      const per = toCopper(1, denomination);
      if ( per > 1 && value % per === 0 ) return { value: value / per, denomination };
    }
  }
  return { value, denomination: "cp" };
}

/**
 * Fill in the display/price snapshots of any skeleton entries (a bare `{uuid}` from the
 * factory default list, or a snapshot lost to a hand-edit) by resolving the item, while
 * preserving the GM's per-entry override and hidden flag. Entries that fail to resolve
 * pass through skeletal — the config window flags them, the shelf skips them. The
 * resolver is injected (`fromUuid` in production) so tests stay Foundry-free.
 * @param {object[]} entries
 * @param {(uuid: string) => Promise<object|null>} resolve
 * @returns {Promise<object[]>} Sanitized, hydrated entries (uuid-less rows dropped).
 */
export async function hydrateEntries(entries, resolve) {
  const out = [];
  for ( const raw of entries ?? [] ) {
    const entry = sanitizeEntry(raw);
    if ( !entry.uuid ) continue;
    // A complete snapshot needs no resolution. `subtype === undefined` on the raw entry
    // (as opposed to a legitimate "") means a pre-subtype save — re-resolve to heal it.
    const complete = entry.name && raw?.subtype !== undefined;
    if ( complete ) { out.push(entry); continue; }
    let doc = null;
    try { doc = await resolve(entry.uuid); } catch { doc = null; }
    if ( !doc ) { out.push(entry); continue; }
    out.push({ ...entryFromItem(doc, entry.uuid), overrideCp: entry.overrideCp, hidden: entry.hidden });
  }
  return out;
}

/**
 * The player-facing stock for a curated inventory: visible, resolvable, hydrated entries
 * with a positive effective price, each priced final (override or multiplied base) so the
 * step renders without further price math.
 * @param {object[]} inventory                    Stored/hydrated entries.
 * @param {number} [priceMultiplier]
 * @param {(uuid: string) => boolean} [isAvailable]  Whether the uuid still resolves.
 * @returns {{uuid: string, name: string, img: string, type: string, subtype: string, cp: number}[]}
 */
export function buildStock(inventory, priceMultiplier = 1, isAvailable = () => true) {
  const out = [];
  for ( const raw of inventory ?? [] ) {
    const entry = sanitizeEntry(raw);
    if ( !entry.uuid || !entry.name || entry.hidden ) continue;
    if ( !isAvailable(entry.uuid) ) continue;
    const cp = effectiveCp(entry, priceMultiplier);
    if ( cp <= 0 ) continue;
    out.push({ uuid: entry.uuid, name: entry.name, img: entry.img, type: entry.type, subtype: entry.subtype, cp });
  }
  return out;
}

/* -------------------------------------------- */
/*  Cart (pure)                                 */
/* -------------------------------------------- */

/**
 * The cart's total cost in copper. Purchases are `uuid -> {qty, cp, …}` on the state,
 * each caching the price it was added at.
 * @param {Record<string, {qty: number, cp: number}>} purchases
 * @returns {number}
 */
export function cartTotalCp(purchases) {
  let sum = 0;
  for ( const p of Object.values(purchases ?? {}) ) {
    const qty = Number(p?.qty) || 0;
    const cp = Number(p?.cp) || 0;
    if ( qty > 0 && cp > 0 ) sum += qty * cp;
  }
  return sum;
}

/**
 * Deduct a cart total from a starting-currency map. When the cart fits, the remainder
 * comes back re-expressed as gp/sp/cp change (the denominations collapse — starting
 * wealth is a fresh grant, not an existing coin pouch); when it doesn't, `spendable` is
 * false and the currency is returned untouched so the caller can decline the purchase.
 * @param {Record<string, number>} currency
 * @param {number} cartCp
 * @returns {{spendable: boolean, remainder: Record<string, number>}}
 */
export function remainingCurrency(currency, cartCp) {
  const cost = Math.max(0, Math.round(Number(cartCp) || 0));
  if ( cost <= 0 ) return { spendable: true, remainder: { ...(currency ?? {}) } };
  const total = totalCp(currency);
  if ( cost > total ) return { spendable: false, remainder: { ...(currency ?? {}) } };
  return { spendable: true, remainder: fromCopper(total - cost) };
}

/**
 * Apply the shop cart to the currency a starting-equipment choice yielded: what there is to
 * spend, and the coin left afterwards. Both wizards ask this — the creation grant and the Ember
 * hand-off — and must answer it identically, since the cart was filled against one budget.
 *
 * An overspent cart means stale state (the Store step's own gate keeps it inside the budget), so
 * it is dropped rather than written as negative gold. A world with the store switched off spends
 * nothing regardless of what an older session left in the cart.
 * @param {Record<string, {qty: number, cp: number}>} purchases
 * @param {Record<string, number>} currency  The currency the equipment choice yields.
 * @returns {{cartCp: number, currency: Record<string, number>}} `cartCp` is 0 when nothing is
 *   spent, in which case `currency` is the grant untouched.
 */
export function applyCartToCurrency(purchases, currency) {
  let cartCp = storeConfig().enabled ? cartTotalCp(purchases) : 0;
  const { spendable, remainder } = remainingCurrency(currency, cartCp);
  if ( cartCp > 0 && !spendable ) {
    log("store cart exceeds the starting currency; purchases skipped");
    cartCp = 0;
  }
  return { cartCp, currency: cartCp > 0 ? remainder : currency };
}

/**
 * The cart as a review panel: one row per purchased item, sorted by name and carrying its
 * quantity, plus the total spent. Null when nothing was bought, so a caller can drop the panel
 * rather than render an empty one. Both review screens show the same thing.
 * @param {Record<string, {qty: number, cp: number, name: string, img: string}>} purchases
 * @returns {{items: object[], total: string}|null}
 */
export function cartSummary(purchases) {
  const items = Object.entries(purchases ?? {})
    .filter(([, p]) => (Number(p?.qty) || 0) > 0)
    .map(([uuid, p]) => ({ uuid, name: p.name, img: p.img, count: p.qty > 1 ? p.qty : null }))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  if ( !items.length ) return null;
  return { items, total: formatCp(cartTotalCp(purchases)) };
}

/**
 * The player's spendable budget in copper: the currency their current equipment-step
 * selection yields (the lettered gold option, package currency, description gold) —
 * the same walk the build's equipment grant performs, in currency-only mode.
 * @returns {Promise<number>}
 */
export async function equipmentBudgetCp(loaded, state) {
  const { currency } = await collectEquipment(loaded, state, { currencyOnly: true });
  return totalCp(currency);
}

/* -------------------------------------------- */
/*  Stock source                                */
/* -------------------------------------------- */

export class StoreSource {

  /** inventory signature -> hydrated entries, so repeat renders skip re-resolution. */
  #hydrated = new Map();

  /**
   * The player-facing stock for the GM's config: the curated inventory hydrated (factory
   * skeletons resolved to name/icon/price snapshots), filtered to visible entries that
   * still resolve, priced final, sorted by name.
   * @param {object} config  The guarded {@link module:config.storeConfig} object.
   * @returns {Promise<{uuid: string, name: string, img: string, type: string, cp: number}[]>}
   */
  async stock(config) {
    const inventory = config?.inventory ?? [];
    // The signature covers everything hydration bakes in (uuid, override, hidden, whether
    // a snapshot exists), so a config edit invalidates while repeat opens stay instant.
    const signature = inventory
      .map(e => `${e?.uuid}:${e?.overrideCp ?? ""}:${e?.hidden ? 1 : 0}:${e?.name ? 1 : 0}:${e?.subtype === undefined ? "u" : "s"}`)
      .join("|");
    let hydrated = this.#hydrated.get(signature);
    if ( !hydrated ) {
      hydrated = await hydrateEntries(inventory, uuid => fromUuid(uuid));
      this.#hydrated.clear();                       // only the current config's list matters
      this.#hydrated.set(signature, hydrated);
    }
    return buildStock(hydrated, config?.priceMultiplier, uuid => this.#resolvable(uuid))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  /** Whether a uuid still points at something (its source pack may have been disabled). */
  #resolvable(uuid) {
    try { return !!fromUuidSync(uuid); } catch { return false; }
  }
}

/* -------------------------------------------- */
/*  Build helpers                               */
/* -------------------------------------------- */

/**
 * Resolve the cart into ready-to-create item data: quantity set, and weapons/equipment
 * equipped on arrival exactly like the class kit (the rest — consumables, tools, loot —
 * goes to the pack). Containers bring their contents, exactly like the equipment grant,
 * and the fresh ids they link by must be kept by the caller's
 * `createEmbeddedDocuments(…, { keepId: true })`. A missing item is logged and skipped
 * rather than failing the build.
 * @param {Record<string, {qty: number}>} purchases
 * @returns {Promise<object[]>}
 */
export async function purchasedItems(purchases) {
  const out = [];
  for ( const [uuid, p] of Object.entries(purchases ?? {}) ) {
    const qty = Number(p?.qty) || 0;
    if ( qty <= 0 ) continue;
    out.push(...await createItemData(uuid, { qty, stampSource: true, context: "purchased item" }));
  }
  return out;
}
