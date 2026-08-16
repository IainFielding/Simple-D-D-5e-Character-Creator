import { log } from "../config.mjs";

/**
 * Finding the source book's own Journal page for a class or subclass.
 *
 * dnd5e ships a dedicated page type for each (`JournalClassPageSheet`, registered for both), and
 * content packages author one per class: official art, the editorial text, the 1–20 progression
 * table, every feature's description, and — on a class page — a summary of each subclass. That is
 * far richer than the item description we show, it is already localised and already styled, and it
 * costs nothing to maintain because it is read from the active package at runtime rather than copied.
 *
 * **The link only runs one way.** A page names its item (`system.item`, a UUID — see
 * `dnd5e/data/journal/class.mjs`); nothing on the item points back, there is no registry, and unlike
 * spell lists there is no `flags.dnd5e.classPages` manifest declaration to read. So the map has to be
 * built by scanning, which is why it is built **once, lazily**, and cached for the session.
 *
 * **`system.item` is not indexed.** Foundry's compendium index carries only `name`, `type` and
 * `sort` per page, so the pages themselves must be loaded. The scan narrows first: the index is used
 * to find the handful of entries that contain a `class`/`subclass` page at all — in the Player's
 * Handbook that is about a dozen out of several hundred — and only those entries are loaded.
 */

/** @type {Map<string, JournalEntryPage>|null} Item UUID → its source page. Built once per session. */
let pageIndex = null;
/** @type {Promise<Map<string, JournalEntryPage>>|null} The in-flight build, shared by callers. */
let building = null;

/** The page types that carry a class-style view. Both are handled by dnd5e's own page sheet. */
const PAGE_TYPES = new Set(["class", "subclass"]);

/**
 * Whether a pack could hold dnd5e class journals: it must hold JournalEntries and either belong to
 * dnd5e or declare no system at all. Mirrors {@link module:data/compendium-util.isUsableItemPack},
 * minus the source-configuration filter — that setting only governs *content* packs, and hiding a
 * class's item source should not also hide the book page describing it.
 * @param {CompendiumCollection} pack
 * @returns {boolean}
 */
function isJournalPack(pack) {
  if ( pack.documentName !== "JournalEntry" ) return false;
  return !pack.metadata.system || (pack.metadata.system === "dnd5e");
}

/**
 * Build the item-UUID → page map by scanning every candidate journal pack.
 * @returns {Promise<Map<string, JournalEntryPage>>}
 */
async function buildIndex() {
  const map = new Map();
  for ( const pack of game.packs ?? [] ) {
    if ( !isJournalPack(pack) ) continue;
    try {
      const index = await pack.getIndex();
      // Narrow by the index where we can: only entries that actually contain a class/subclass page
      // are worth loading. Some index shapes omit `pages` entirely, in which case every entry in
      // this pack has to be loaded — correctness first, and the result is cached either way.
      const wanted = [];
      let indexCarriesPages = false;
      for ( const entry of index ) {
        if ( Array.isArray(entry.pages) ) {
          indexCarriesPages = true;
          if ( entry.pages.some(page => PAGE_TYPES.has(page.type)) ) wanted.push(entry._id);
        }
      }
      const documents = indexCarriesPages
        ? await Promise.all(wanted.map(id => pack.getDocument(id).catch(() => null)))
        : await pack.getDocuments();

      for ( const journal of documents ) {
        for ( const page of journal?.pages ?? [] ) {
          if ( !PAGE_TYPES.has(page.type) ) continue;
          const itemUuid = String(page.system?.item ?? "").trim();
          // First page to claim an item wins. Packs are iterated in Foundry's own order, and a
          // second package describing the same class is an edge case not worth a preference rule.
          if ( itemUuid && !map.has(itemUuid) ) map.set(itemUuid, page);
        }
      }
    } catch ( err ) {
      // A single unreadable pack must not cost us every other book's pages.
      log(`could not scan journal pack ${pack.collection}`, err);
    }
  }
  log(`indexed ${map.size} source journal page(s)`);
  return map;
}

/**
 * The source book's Journal page for a class or subclass item, or `null` when the active packages
 * do not provide one (SRD-only worlds, and most homebrew). Callers hide their "Full Details" control
 * on `null` rather than offering a dead button.
 *
 * @param {Item5e|{uuid?: string, _stats?: object, name?: string}} item   The class/subclass item, or
 *   a card carrying its compendium uuid.
 * @returns {Promise<JournalEntryPage|null>}
 */
export async function sourcePageFor(item) {
  const uuid = item?._stats?.compendiumSource ?? item?.getFlag?.("dnd5e", "sourceId") ?? item?.uuid ?? "";
  if ( !uuid ) return null;

  if ( !pageIndex ) {
    building ??= buildIndex().then(map => (pageIndex = map));
    try { await building; }
    catch ( err ) { log("source journal index failed", err); building = null; return null; }
  }
  return pageIndex.get(String(uuid)) ?? null;
}

/**
 * Whether a book page exists for a class or subclass, by uuid — so a step can decide whether to
 * offer its "Full Details" control at all rather than opening a panel that just repeats the
 * description already on screen.
 * @param {string} uuid
 * @returns {Promise<boolean>}
 */
export async function hasSourcePage(uuid) {
  return Boolean(await sourcePageFor({ uuid }));
}

/**
 * Drop the cached index — the GM changed which packages are active, so a page it found may no
 * longer exist and a page it missed may now be there.
 */
export function invalidateJournalIndex() {
  pageIndex = null;
  building = null;
}
