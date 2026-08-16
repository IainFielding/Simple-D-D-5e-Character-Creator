/**
 * Identity for spell *documents* — "is this the same spell as that one?".
 *
 * Two places need to answer that question and neither can use the obvious test. A spell the player
 * picks off a class list and a spell handed out by a feature's `ItemGrant` are separate Items with
 * separate ids, different `system.prepared` values, and often different `system.sourceItem` tags
 * (`class:cleric` vs `subclass:life`), yet they are the same spell and must not both sit on the
 * character. Matching on any one of those fields misses the pair; matching on name is too loose.
 *
 * The stable identity is the **compendium source** the document was copied from, which both copies
 * carry, plus the spell level to guard against a pack that reuses an id across editions. Homebrew
 * created directly in a world has no compendium source, so `system.identifier` is the fallback.
 *
 * @see module:build/spell-reconcile for the merge that consumes this
 */

/**
 * The identity key for one spell item or pool entry, or `null` when it cannot be established.
 *
 * Accepts both live Items and the plain pool-entry shape the spell steps work in (`{ uuid, level }`),
 * so a pool row can be tested against the actor's items without materialising anything.
 *
 * @param {Item5e|{uuid?: string, level?: number, system?: object}} item
 * @returns {string|null}
 */
export function spellKey(item) {
  if ( !item ) return null;
  const level = Number(item.system?.level ?? item.level ?? 0);
  const source = item._stats?.compendiumSource
    ?? item.getFlag?.("dnd5e", "sourceId")
    ?? item.flags?.dnd5e?.sourceId
    ?? item.uuid
    ?? "";
  if ( source ) return `${source}|${level}`;
  const identifier = item.system?.identifier ?? "";
  return identifier ? `id:${identifier}|${level}` : null;
}

/**
 * Every spell already present on an actor (or an advancement clone), as identity keys.
 *
 * Deliberately unfiltered: **every** spell counts, whatever its `prepared` value and whatever
 * granted it. This is the "do you already have this?" question, which is not the same as the
 * "may you swap this away?" question — conflating the two is what let a feature-granted spell be
 * offered for selection a second time.
 *
 * @param {Actor5e|{items: Iterable<Item5e>}} actorLike
 * @returns {Set<string>}
 */
export function ownedSpellKeys(actorLike) {
  const keys = new Set();
  for ( const item of actorLike?.items ?? [] ) {
    if ( item.type !== "spell" ) continue;
    const key = spellKey(item);
    if ( key ) keys.add(key);
  }
  return keys;
}

/**
 * Whether a spell item was handed out by an advancement rather than chosen by the player.
 *
 * dnd5e stamps `flags.dnd5e.advancementOrigin` (`<itemId>.<advancementId>`) on everything an
 * advancement creates, so this holds for class, subclass and feature grants alike, and never for
 * the copies our own spell steps create.
 *
 * @param {Item5e} item
 * @returns {boolean}
 */
export function isGrantedSpell(item) {
  return Boolean(item?.getFlag?.("dnd5e", "advancementOrigin") ?? item?.flags?.dnd5e?.advancementOrigin);
}
