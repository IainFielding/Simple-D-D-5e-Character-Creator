import { log } from "../config.mjs";
import { getEnabledPacks } from "./compendium-util.mjs";

/**
 * Weapon icon resolution from the D&D Player's Handbook pack. A weapon-trait pick
 * (most visibly Weapon Mastery on level-up, but any "choose a weapon" trait choice)
 * normally shows the system's generic per-weapon glyph via `Trait.keyIcon`. When the
 * official Player's Handbook module is present and enabled, its equipment pack ships
 * the proper 2024 weapon art — the same source the creator's grids prefer — so we
 * surface that instead, matching how "the pictures in the creator" look.
 *
 * A weapon-trait key is "weapon:<category>:<baseItem>" (e.g. "weapon:mar:longsword").
 * The final segment is the weapon's base-item id, which equals `system.type.baseItem`
 * on the concrete weapon item — the join we use to find its icon.
 */

/** PHB pack collections are namespaced under this module id. */
const PHB_PREFIX = "dnd-players-handbook.";

/**
 * baseItem id -> image, built once per session from the enabled PHB pack(s), or an
 * empty map when the PHB isn't active (so callers fall back to the generic icon).
 * `null` until first built.
 * @type {Map<string, string>|null}
 */
let phbWeaponImgs = null;

/**
 * Drop the weapon-icon map. Called from `invalidateSources()` when the enabled-source set changes:
 * {@link phbWeaponMap} skips a PHB pack the world has switched off, so the map is only valid while
 * that configuration holds.
 */
export function resetWeaponIcons() {
  phbWeaponImgs = null;
}

/**
 * Build (once) the base-item -> image map from the Player's Handbook equipment pack,
 * honouring the world's dnd5e source configuration the same way the creator does: a
 * PHB pack that exists but is switched off in the source config is treated as inactive.
 * Returns an empty map when no PHB weapon pack is active.
 * @returns {Promise<Map<string, string>>}
 */
/** Lower-cased letters/digits only, so "Quarterstaff" compares equal to "quarterstaff". */
function slug(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function phbWeaponMap() {
  if ( phbWeaponImgs ) return phbWeaponImgs;
  const map = new Map();
  // Bases whose image came from the item *named* for them, which no variant may displace.
  const canonical = new Set();
  const enabled = getEnabledPacks();
  for ( const pack of game.packs ) {
    if ( pack.metadata.type !== "Item" ) continue;
    if ( !pack.collection.startsWith(PHB_PREFIX) ) continue;
    if ( enabled && !enabled.has(pack.collection) ) continue;   // PHB present but disabled in source config
    try {
      const index = await pack.getIndex({ fields: ["type", "system.type.baseItem"] });
      for ( const e of index ) {
        if ( e.type !== "weapon" ) continue;
        const base = e.system?.type?.baseItem;
        if ( !base || !e.img ) continue;
        // Several items can share a base — the PHB's Staff, Wooden staff, and Quarterstaff are
        // all baseItem "quarterstaff" — and the index order would otherwise let a variant's art
        // win. The canonical base weapon is the one named for the base id, so it always wins;
        // a variant's image is only a fallback when no canonical entry exists.
        if ( slug(e.name) === slug(base) ) {
          map.set(base, e.img);
          canonical.add(base);
        } else if ( !canonical.has(base) && !map.has(base) ) {
          map.set(base, e.img);
        }
      }
    } catch ( err ) {
      log(`PHB weapon icon scan failed for ${pack.collection}`, err);
    }
  }
  phbWeaponImgs = map;
  return map;
}

/**
 * The Player's Handbook item image for a weapon-trait key, or null when the key isn't a
 * weapon key, the PHB isn't active, or it ships no matching weapon — leaving the caller
 * to fall back to the system's generic {@link dnd5e.documents.Trait.keyIcon}.
 * @param {string} key   e.g. "weapon:mar:longsword"
 * @returns {Promise<string|null>}
 */
export async function phbWeaponIcon(key) {
  if ( typeof key !== "string" || !key.startsWith("weapon:") ) return null;
  const base = key.split(":").pop();
  if ( !base ) return null;
  return (await phbWeaponMap()).get(base) ?? null;
}
