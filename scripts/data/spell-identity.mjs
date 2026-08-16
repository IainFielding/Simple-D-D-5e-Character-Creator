/**
 * Identity for spell *documents* — "is this the same spell as that one?".
 *
 * Two places need to answer that question and neither can use the obvious test. A spell the player
 * picks off a class list and a spell handed out by a feature's `ItemGrant` are separate Items with
 * separate ids, different `system.prepared` values, and often different `system.sourceItem` tags
 * (`class:cleric` vs `subclass:life`), yet they are the same spell and must not both sit on the
 * character. Matching on any one of those fields misses the pair; matching on name is too loose.
 *
 * The stable identity is **`system.identifier`** — `cure-wounds` — plus the spell level. Not the
 * compendium source, which looks more precise and is the wrong answer: a world running the Player's
 * Handbook module alongside the system's own packs holds two copies of every spell, and a subclass
 * granting `dnd5e.spells24`'s Cure Wounds against a player picking the PHB module's produces two
 * documents whose sources differ and whose spell is identical. Keying on source silently failed to
 * match them, which is the common case rather than an edge one. (Found by the e2e harness, whose
 * Cleric case could not even locate an overlapping spell to test until this was understood.)
 *
 * The level rides along so a pack reusing an identifier across editions cannot collapse two spells,
 * and the compendium source is the fallback for the handful of spells — 11 of 352 in the 2024
 * pack — that ship without an identifier at all.
 *
 * Identity alone never authorises a merge: {@link module:build/spell-reconcile.mergeable} still has
 * to agree on name, casting method, ability and provenance.
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
  // `item.identifier` is the pool-row spelling (see `buildSpellFromEntry`); `system.identifier` is
  // a live document's.
  const identifier = item.system?.identifier ?? item.identifier ?? "";
  if ( identifier ) return `id:${identifier}|${level}`;
  const source = item._stats?.compendiumSource
    ?? item.getFlag?.("dnd5e", "sourceId")
    ?? item.flags?.dnd5e?.sourceId
    ?? item.uuid
    ?? "";
  return source ? `${source}|${level}` : null;
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
