/**
 * Proficiency icon art from the "Baldur's Gate 3" 5e module. That module ships a matched set of
 * game-styled icons for the eighteen skills plus the armour, weapon and instrument proficiency
 * categories, which read far better on the creator's choice cards than the system's generic
 * per-key glyphs (a pair of shoes for Acrobatics, a horse for Animal Handling, …).
 *
 * Entirely opt-in: the icons only appear when that module is installed *and* enabled, otherwise
 * every lookup returns null and callers fall back to {@link dnd5e.documents.Trait.keyIcon} as
 * before. Nothing here is a dependency — the module is never required.
 *
 * Trait keys arrive prefixed ("skills:acr", "armor:lgt", "tool:music"), the same shape
 * `Trait.keyIcon` parses.
 */

/** The Baldur's Gate 3 module's id, and where it keeps the proficiency art. */
const BG3_MODULE_ID = "sogrom-baldurs-gate-3-5e";
const BG3_ICON_DIR = `modules/${BG3_MODULE_ID}/assets/icons`;

/**
 * The skill icons the module actually ships, by file basename. A skill's basename is its dnd5e
 * `fullKey` lower-cased ("sleightOfHand" -> "sleightofhand"), so the key is derived rather than
 * tabulated — but only names in this set are emitted, so a homebrew skill (or a future one the
 * module hasn't drawn yet) falls through to the system icon instead of a broken image.
 */
const SKILL_ICONS = new Set([
  "acrobatics", "animalhandling", "arcana", "athletics", "deception", "history",
  "insight", "intimidation", "investigation", "medicine", "nature", "perception",
  "performance", "persuasion", "religion", "sleightofhand", "stealth", "survival"
]);

/**
 * Non-skill proficiency categories, by full trait key. Only whole categories are listed: a key
 * naming a specific item ("weapon:mar:longsword", "tool:art:smith") keeps its own art, which is
 * more informative than the module's one generic weapon/instrument icon.
 */
const CATEGORY_ICONS = {
  "armor:lgt": "lightarmour",
  "armor:med": "mediumarmour",
  "armor:hvy": "heavyarmour",
  "armor:shl": "shields",
  "weapon:sim": "weapons",
  "weapon:mar": "weapons",
  "tool:music": "musicalinstruments"
};

/** Whether the Baldur's Gate 3 module is installed and enabled in this world. */
const isBg3Active = () => !!game.modules?.get(BG3_MODULE_ID)?.active;

/**
 * The Baldur's Gate 3 icon for a proficiency trait key, or null when that module is inactive or
 * ships no art for the key — leaving the caller on its existing fallback.
 * @param {string} key   Prefixed trait key, e.g. "skills:acr" or "armor:hvy".
 * @returns {string|null}
 */
export function bg3TraitIcon(key) {
  if ( typeof key !== "string" || !isBg3Active() ) return null;

  const category = CATEGORY_ICONS[key];
  if ( category ) return `${BG3_ICON_DIR}/${category}.webp`;

  if ( !key.startsWith("skills:") ) return null;
  const fullKey = CONFIG.DND5E?.skills?.[key.split(":")[1]]?.fullKey;
  const name = String(fullKey ?? "").toLowerCase();
  return SKILL_ICONS.has(name) ? `${BG3_ICON_DIR}/${name}.webp` : null;
}
