/**
 * Collapsing the same content republished by more than one package.
 *
 * A world with the Player's Handbook module, the system's own SRD packs, and a book like Forge of
 * the Artificer enabled carries the same classes, species and backgrounds several times over. Left
 * alone the grids show every one of them twice or three times, with nothing on the cards to tell
 * the copies apart.
 *
 * This module holds only the *policy* — which copy wins — and deliberately knows nothing about
 * Foundry. The one fact it needs from the outside (is a package the game system, or a real
 * installed book?) arrives as an injected lookup, so the rule is unit-testable without a running
 * game. {@link module:data/source-index} supplies the real lookup over `game.packs`.
 */

/**
 * The publisher whose copy wins outright.
 *
 * The Player's Handbook module is preferred over everything else because it is the copy carrying
 * the official artwork the class, species and background screens already use as their backdrops —
 * losing it would visibly downgrade those grids, not just swap one identical card for another.
 */
export const PREFERRED_PACKAGE = "dnd-players-handbook";

/**
 * The content package a compendium uuid belongs to: `Compendium.<packageId>.<pack>.Item.<id>`.
 * @param {string} uuid
 * @returns {string}
 */
export function packageOf(uuid) {
  return String(uuid).split(".")[1] ?? "";
}

/**
 * How strongly a package's copy is preferred — lower wins.
 *
 * The middle rank is the point of this function. Preferring one hardcoded module id meant every
 * *other* real book that reprints SRD content — Forge of the Artificer, Ravenloft, the Faerûn
 * books, or a GM's own homebrew compendium — lost to whichever copy happened to be indexed first,
 * which is arbitrary. Keying the decision off the package *type* instead covers every such book
 * without naming any of them: a GM who installed a real book wants that book's copy, and the
 * system's bundled SRD is the generic fallback by definition.
 *
 * A package that resolves to no type at all (an unknown or since-uninstalled id) is treated as a
 * real package rather than as system content, so an unrecognised source is never silently ranked
 * below the SRD.
 * @param {string} packageId
 * @param {(packageId: string) => string|null} packageTypeOf   "system" | "module" | "world" | null
 * @returns {0|1|2}
 */
export function rankPackage(packageId, packageTypeOf) {
  if ( packageId === PREFERRED_PACKAGE ) return 0;
  return packageTypeOf(packageId) === "system" ? 2 : 1;
}

/**
 * Collapse cards that are the same content republished, keeping the best-ranked copy.
 *
 * Deliberately strict about what counts as "the same": identifier, name **and** rules edition must
 * all agree. Matching on the identifier alone would collapse genuinely different content that shares
 * one — the Forge Artificer and Tasha's Artificer are both `artificer`, and are different classes
 * with different features at different levels. Anything that is not an exact match is left alone,
 * which errs towards showing a duplicate rather than hiding someone's content.
 *
 * Insertion order is preserved, so a grid's existing ordering survives. Ties keep the copy found
 * first, so an equal-ranked duplicate never reshuffles the grid.
 * @param {object[]} cards
 * @param {(packageId: string) => string|null} packageTypeOf   See {@link rankPackage}.
 * @returns {object[]}
 */
export function dedupeCards(cards, packageTypeOf) {
  const byKey = new Map();
  for ( const card of cards ) {
    const key = [card.classIdentifier ?? "", card.identifier ?? "", card.name, card.rules ?? ""].join("|");
    const seen = byKey.get(key);
    if ( !seen ) {
      byKey.set(key, card);
      continue;
    }
    // Strictly better only — an equal rank leaves the first copy in place.
    if ( rankPackage(packageOf(card.uuid), packageTypeOf) < rankPackage(packageOf(seen.uuid), packageTypeOf) ) {
      byKey.set(key, card);
    }
  }
  return [...byKey.values()];
}
