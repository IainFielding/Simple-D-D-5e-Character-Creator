/**
 * The store's factory inventory: the item UUIDs a fresh world's shelves are stocked with
 * until the GM saves their own list in the Configure Store window (and what the window's
 * "Reset to defaults" restores). Every UUID points into the system's own 2024 equipment
 * compendium (`dnd5e.equipment24`, the free-rules content) or its legacy `dnd5e.items`
 * pack, so the defaults resolve in any dnd5e world with no extra modules — a classic
 * general store: simple and martial weapons, mundane armor, adventuring gear, a few kits,
 * musical instruments, the five equipment packs, and a spellbook.
 *
 * Only the UUIDs live here; names, icons, and prices are read from the items themselves the
 * first time the list is hydrated (see `hydrateEntries` in store-source.mjs), so system price
 * errata never leave this file stale. Consumers call {@link defaultInventoryUuids} rather than
 * the raw list: with the full Player's Handbook module active, the same ids are served from
 * its equipment pack instead (better art and full descriptions).
 */

const PACK = "Compendium.dnd5e.equipment24.Item";

export const DEFAULT_INVENTORY_UUIDS = [
  // Simple melee weapons
  `${PACK}.phbwepClub000000`,   // Club
  `${PACK}.phbwepDagger0000`,   // Dagger
  `${PACK}.phbwepGreatclub0`,   // Greatclub
  `${PACK}.phbwepHandaxe000`,   // Handaxe
  `${PACK}.phbwepJavelin000`,   // Javelin
  `${PACK}.phbwepLightHamme`,   // Light Hammer
  `${PACK}.phbwepMace000000`,   // Mace
  `${PACK}.phbwepQuartersta`,   // Quarterstaff
  `${PACK}.phbwepSickle0000`,   // Sickle
  `${PACK}.phbwepSpear00000`,   // Spear
  // Simple ranged weapons
  `${PACK}.phbwepDart000000`,   // Dart
  `${PACK}.phbwepLightCross`,   // Light Crossbow
  `${PACK}.phbwepShortbow00`,   // Shortbow
  `${PACK}.phbwepSling00000`,   // Sling
  // Martial weapons
  `${PACK}.phbwepBattleaxe0`,   // Battleaxe
  `${PACK}.phbwepGreatsword`,   // Greatsword
  `${PACK}.phbwepLongsword0`,   // Longsword
  `${PACK}.phbwepRapier0000`,   // Rapier
  `${PACK}.phbwepScimitar00`,   // Scimitar
  `${PACK}.phbwepShortsword`,   // Shortsword
  `${PACK}.phbwepWarhammer0`,   // Warhammer
  `${PACK}.phbwepHeavyCross`,   // Heavy Crossbow
  `${PACK}.phbwepLongbow000`,   // Longbow
  // Armor & shield
  `${PACK}.phbarmPaddedArmo`,   // Padded Armor
  `${PACK}.phbarmLeatherArm`,   // Leather Armor
  `${PACK}.phbarmStuddedLea`,   // Studded Leather Armor
  `${PACK}.phbarmHideArmor0`,   // Hide Armor
  `${PACK}.phbarmChainShirt`,   // Chain Shirt
  `${PACK}.phbarmScaleMail0`,   // Scale Mail
  `${PACK}.phbarmBreastplat`,   // Breastplate
  `${PACK}.phbarmRingMail00`,   // Ring Mail
  `${PACK}.phbarmChainMail0`,   // Chain Mail
  `${PACK}.phbarmShield0000`,   // Shield
  // Adventuring gear
  `${PACK}.phbagBedroll0000`,   // Bedroll
  `${PACK}.phbagBlanket0000`,   // Blanket
  `${PACK}.phbagCandle00000`,   // Candle
  `${PACK}.phbagRope0000000`,   // Rope
  `${PACK}.phbagTorch000000`,   // Torch
  `${PACK}.phbagTinderbox00`,   // Tinderbox
  `${PACK}.phbagRations0000`,   // Rations
  `${PACK}.phbagOil00000000`,   // Oil
  `${PACK}.phbagLamp0000000`,   // Lamp
  `${PACK}.phbagLanternHood`,   // Lantern, Hooded
  `${PACK}.phbagLanternBull`,   // Lantern, Bullseye
  `${PACK}.phbagCrowbar0000`,   // Crowbar
  `${PACK}.phbagGrapplingHo`,   // Grappling Hook
  `${PACK}.phbagHealersKit0`,   // Healer's Kit
  `${PACK}.phbagHuntingTrap`,   // Hunting Trap
  `${PACK}.phbagInk00000000`,   // Ink
  `${PACK}.phbagInkPen00000`,   // Ink Pen
  `${PACK}.phbagParchment00`,   // Parchment
  `${PACK}.phbagMirror00000`,   // Mirror
  `${PACK}.phbagNet00000000`,   // Net
  `${PACK}.phbagPole0000000`,   // Pole
  `${PACK}.phbagShovel00000`,   // Shovel
  `${PACK}.phbagSpikesIron0`,   // Spikes, Iron
  `${PACK}.phbagTent0000000`,   // Tent
  `${PACK}.phbagPotionofHea`,   // Potion of Healing
  `${PACK}.phbagHolyWater00`,   // Holy Water
  `${PACK}.phbagAntitoxin00`,   // Antitoxin
  `${PACK}.phbagAcid0000000`,   // Acid
  `${PACK}.phbagAlchemistsF`,   // Alchemist's Fire
  `${PACK}.phbagCaltrops000`,   // Caltrops
  `${PACK}.phbagBallBearing`,   // Ball Bearings
  `${PACK}.phbagChain000000`,   // Chain
  `${PACK}.phbagClimbersKit`,   // Climber's Kit
  `${PACK}.phbagManacles000`,   // Manacles
  `${PACK}.phbagLock0000000`,   // Lock
  `${PACK}.phbagClothesTrav`,   // Clothes, Traveler's
  `${PACK}.phbagSignalWhist`,   // Signal Whistle
  `${PACK}.phbagBell0000000`,   // Bell
  // Tools & kits
  `${PACK}.phbtulThievesToo`,   // Thieves' Tools
  `${PACK}.phbtulHerbalismK`,   // Herbalism Kit
  `${PACK}.phbtulDisguiseKi`,   // Disguise Kit
  `${PACK}.phbtulNavigators`,   // Navigator's Tools
  `${PACK}.phbtulSmithsTool`,   // Smith's Tools
  // Musical instruments
  `${PACK}.phbmusBagpipes00`,   // Bagpipes
  `${PACK}.phbmusDrum000000`,   // Drum
  `${PACK}.phbmusDulcimer00`,   // Dulcimer
  `${PACK}.phbmusFlute00000`,   // Flute
  `${PACK}.phbmusHorn000000`,   // Horn
  `${PACK}.phbmusLute000000`,   // Lute
  `${PACK}.phbmusLyre000000`,   // Lyre
  `${PACK}.phbmusPanflute00`,   // Pan Flute
  `${PACK}.phbmusShawm00000`,   // Shawm
  `${PACK}.phbmusViol000000`,   // Viol
  // Equipment packs (containers — buying one brings its contents along)
  `${PACK}.phbagBurglarsPac`,   // Burglar's Pack
  `${PACK}.phbagDungeoneers`,   // Dungeoneer's Pack
  `${PACK}.phbagExplorersPa`,   // Explorer's Pack
  `${PACK}.phbagPriestsPack`,   // Priest's Pack
  `${PACK}.phbagScholarsPac`,   // Scholar's Pack
  // From the system's legacy items pack (also ships with dnd5e itself)
  "Compendium.dnd5e.items.Item.LBajgahniRJbAgDr"  // Spellbook
];

/** The full Player's Handbook module, whose equipment pack mirrors the free-rules ids. */
const PHB_MODULE_ID = "dnd-players-handbook";
const SYSTEM_PREFIX = `${PACK}.`;
const PHB_PREFIX = `Compendium.${PHB_MODULE_ID}.equipment.Item.`;

/**
 * The default stock resolved against the best available source: with the Player's
 * Handbook module active its equipment pack takes over (same ids, richer art/text —
 * verified 1:1 for every id above except the legacy-pack Spellbook), item by item so an
 * id the module ever drops falls back to the system copy instead of a broken row.
 * Callers wanting the raw system list (tests, docs) use {@link DEFAULT_INVENTORY_UUIDS}.
 * @returns {string[]}
 */
export function defaultInventoryUuids() {
  if ( !globalThis.game?.modules?.get(PHB_MODULE_ID)?.active ) return [...DEFAULT_INVENTORY_UUIDS];
  return DEFAULT_INVENTORY_UUIDS.map(uuid => {
    if ( !uuid.startsWith(SYSTEM_PREFIX) ) return uuid;
    const phbUuid = PHB_PREFIX + uuid.slice(SYSTEM_PREFIX.length);
    try { return fromUuidSync(phbUuid) ? phbUuid : uuid; } catch { return uuid; }
  });
}
