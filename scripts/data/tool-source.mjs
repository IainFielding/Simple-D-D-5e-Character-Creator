import { log } from "../config.mjs";

/**
 * Shared resolution of D&D tool *categories* into the concrete tools a player can pick —
 * Artisan's Tools, Gaming Sets, Musical Instruments. Used in two places:
 *
 *   • Starting equipment (a class/background that hands you "a Musical Instrument").
 *   • Advancement Trait choices (e.g. the Monk's "choose one Artisan's Tool or Musical
 *     Instrument" tool-proficiency pick), where the dnd5e wildcard expansion is unreliable.
 *
 * Tool items carry their category in `system.type.value` (matching the tool trait key,
 * e.g. "art"/"music") and their proficiency id in `system.type.baseItem` (e.g. "lute").
 * A trait key is written with both — `tool:music:lute` — which is the form `Trait.actorValues`
 * reports and `Trait.mixedChoices` expands a pool into. The last `:` segment alone is what reaches
 * `system.tools.<id>.value`, so the category is redundant for *applying* a proficiency, but not for
 * recognising one that is already there; see `expandToolPool` in `choice-resolver.mjs`.
 */

/** Display icons for the three pickable tool categories. */
export const TOOL_IMG = {
  art: "icons/tools/hand/hammer-and-nail.webp",
  game: "icons/sundries/gaming/dice-pair-white-green.webp",
  music: "icons/tools/instruments/harp-yellow-teal.webp"
};

/**
 * category -> choice[], memoised. The tools themselves never change at runtime, but *which packs
 * they may be read from* does — {@link toolChoices} fetches through the Compendium Browser, which
 * applies the world's source configuration — so this is cleared alongside the other pack-derived
 * caches. See {@link resetToolCache}.
 */
const toolCache = new Map();

/** Drop the tool memo. Called from `invalidateSources()` when the enabled-source set changes. */
export function resetToolCache() {
  toolCache.clear();
}

/**
 * A tool key that needs the player to pick a specific tool (e.g. "art"), or null for an
 * already-specific tool (e.g. "viol") that stands on its own.
 * @param {string} key
 * @returns {string|null}
 */
export function toolCategoryKey(key) {
  const dnd = CONFIG.DND5E ?? {};
  if ( dnd.tools?.[key] ) return null;
  if ( dnd.toolTypes?.[key] || dnd.toolProficiencies?.[key] ) return key;
  return null;
}

/**
 * The specific tool items in a category (e.g. every musical instrument), deduplicated by
 * base item and memoised.
 * @param {string} category   e.g. "music"
 * @returns {Promise<Array<{uuid:string, name:string, img:string, baseItem:string|null}>>}
 */
export async function toolChoices(category) {
  if ( toolCache.has(category) ) return toolCache.get(category);
  let entries = [];
  const browser = dnd5e.applications?.CompendiumBrowser;
  if ( browser?.fetch ) {
    try {
      const all = await browser.fetch(Item, {
        types: new Set(["tool"]),
        indexFields: new Set(["system.type.value", "system.type.baseItem"])
      });
      entries = all.filter(e => (e.system?.type?.value ?? "") === category);
    } catch ( err ) {
      log(`tool choice fetch failed for "${category}"`, err);
    }
  }
  const choices = dedupeToolsByPriority(entries)
    .map(e => ({ uuid: e.uuid, name: e.name, img: e.img, baseItem: e.system?.type?.baseItem ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  toolCache.set(category, choices);
  return choices;
}

/** Dedupe tool index entries by base item, preferring PHB then 2024 then legacy packs. */
function dedupeToolsByPriority(entries) {
  const PRIORITY = ["Compendium.dnd-players-handbook.", "Compendium.dnd5e.equipment24.", "Compendium.dnd5e.equipment."];
  const rank = uuid => { const i = PRIORITY.findIndex(p => (uuid ?? "").startsWith(p)); return i >= 0 ? i : PRIORITY.length; };
  const byKey = new Map();
  for ( const e of entries ) {
    const key = e.system?.type?.baseItem || e.name;
    if ( !key ) continue;
    const existing = byKey.get(key);
    if ( !existing || rank(e.uuid) < rank(existing.uuid) ) byKey.set(key, e);
  }
  return [...byKey.values()];
}
