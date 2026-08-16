import { MODULE_ID, log } from "../config.mjs";
import { isGrantedSpell, spellKey } from "../data/spell-identity.mjs";

/**
 * Collapse a feature-granted spell and a separately-chosen copy of the same spell into one document.
 *
 * **The problem.** A class, subclass or feature `ItemGrant` whose advancement declares
 * `configuration.spell.prepared = 2` hands out an always-prepared spell — Divine Smite at Paladin 2,
 * a Life Domain's domain spells, Hunter's Mark from Favored Enemy. Many of those spells are also on
 * the same class's ordinary spell list, so the player could pick them again on the spells step. That
 * left *two* Items on the character: the granted one (always prepared, carrying its free-cast uses
 * and the "(free casting)" forward activity dnd5e builds) and a plain prepared copy. The plain copy
 * is the one dnd5e counts toward `system.spellcasting.preparation.value`
 * (`SpellData#countsPrepared` requires `prepared === 1`), so it permanently consumed one of the
 * character's prepared slots for a spell they already always have — and, having no forward activity,
 * it burned a real spell slot when clicked.
 *
 * **The fix.** Prevention comes first: both spell steps hide anything already owned (see
 * {@link module:data/spell-identity}). This is the safety net behind it, for the case prevention
 * cannot reach — a spell chosen at an earlier level that a *later* feature grants.
 *
 * **Which copy survives.** Always the granted one. It carries the richer configuration (preparation
 * state, uses, forward activity), and — decisively — the granting advancement records the item id it
 * created in its own `value.added`. Deleting the granted copy would leave that record pointing at a
 * document that no longer exists, which is why the module this approach was studied from needs a
 * whole redirect pass to clean up after itself. Deleting the *chosen* copy costs nothing: no
 * advancement, and nothing else on the actor, refers to it.
 *
 * **Planning is separate from applying, deliberately.** {@link planSpellReconciliation} only reads,
 * so it can be run against a level-up driver's *clone* to learn what a merge would free up while the
 * player is still choosing. The clone is an unsaved copy that keeps the real actor's id, so calling
 * `deleteEmbeddedDocuments` on it would write straight through to the character — only
 * {@link reconcileGrantedSpells}, which is given the real actor, is ever allowed to write.
 *
 * **When it refuses.** A missed merge is a visible duplicate; a wrong merge destroys a spell the
 * character was entitled to. So the match must be unambiguous on every axis that could mean "these
 * are actually different entitlements" — see {@link mergeable}.
 *
 * The reconciliation approach (identity by compendium source, compatibility before merging, refusing
 * on doubt) is modelled on the always-prepared reconciliation in **Character Builder (DnD 5e)** by
 * Raphael Andrade, MIT-licensed. No code was copied; this is a much smaller re-implementation
 * against our own data shapes.
 */

/**
 * @typedef {object} SpellReconciliation
 * @property {object[]} merged            One row per collapsed pair, for the Review screen.
 * @property {string[]} deleteIds         Ids of the duplicate documents to remove.
 * @property {object[]} updates           Embedded-item updates marking each survivor.
 * @property {number} releasedSpells      Prepared-spell selections handed back.
 * @property {number} releasedCantrips    Cantrip selections handed back.
 */

/**
 * Work out which granted/chosen spell duplicates could be collapsed. **Pure** — reads only.
 *
 * @param {Actor5e|{items: Iterable<Item5e>}} actorLike   An actor, or a driver clone mid-level-up.
 * @returns {SpellReconciliation}
 */
export function planSpellReconciliation(actorLike) {
  const plan = { merged: [], deleteIds: [], updates: [], releasedSpells: 0, releasedCantrips: 0 };
  if ( !actorLike?.items ) return plan;

  // Bucket every spell by identity. Only a bucket holding both a granted and a chosen copy is a
  // candidate; anything else is left exactly as it is.
  const buckets = new Map();
  for ( const item of actorLike.items ) {
    if ( item.type !== "spell" ) continue;
    const key = spellKey(item);
    if ( !key ) continue;
    const bucket = buckets.get(key) ?? { granted: [], chosen: [] };
    (isGrantedSpell(item) ? bucket.granted : bucket.chosen).push(item);
    buckets.set(key, bucket);
  }

  for ( const bucket of buckets.values() ) {
    if ( !bucket.granted.length || !bucket.chosen.length ) continue;
    // One granted copy claims one chosen copy. Two genuinely distinct grants of the same spell are
    // vanishingly rare, but pairing rather than sweeping keeps the arithmetic honest either way.
    const survivor = bucket.granted[0];
    const duplicate = bucket.chosen.find(candidate => mergeable(survivor, candidate));
    if ( !duplicate ) continue;

    const level = Number(duplicate.system?.level ?? 0);
    // Only a regularly-prepared leveled spell was occupying a preparation slot. A cantrip was
    // occupying a cantrips-known slot instead; anything else was occupying nothing.
    if ( level === 0 ) plan.releasedCantrips++;
    else if ( Number(duplicate.system?.prepared ?? 0) === 1 ) plan.releasedSpells++;

    plan.deleteIds.push(duplicate.id);
    // Record the double entitlement on the survivor so the Review screen can say *why* this spell is
    // always prepared, rather than showing it as an ordinary pick.
    plan.updates.push({ _id: survivor.id, [`flags.${MODULE_ID}.alsoChosen`]: true });
    plan.merged.push({
      id: survivor.id,
      name: survivor.name,
      img: survivor.img,
      level,
      grantedBy: grantSourceName(survivor, actorLike),
      removedId: duplicate.id
    });
  }

  return plan;
}

/**
 * Merge every granted/chosen spell duplicate on a **real actor**.
 *
 * Safe to call more than once — once the duplicate is gone there is nothing left to match, so a
 * second pass is a no-op. Never pass a driver clone: see the note on planning above.
 *
 * @param {Actor5e} actor
 * @returns {Promise<SpellReconciliation>}
 */
export async function reconcileGrantedSpells(actor) {
  const plan = planSpellReconciliation(actor);
  if ( !plan.deleteIds.length ) return plan;

  // Mark the survivors before removing the duplicates, so a failure part-way can only ever leave an
  // extra spell to tidy up — never a character missing one.
  await actor.updateEmbeddedDocuments("Item", plan.updates, { render: false });
  await actor.deleteEmbeddedDocuments("Item", plan.deleteIds, { render: false });
  log(`reconciled ${plan.deleteIds.length} duplicate granted spell(s)`, plan.merged.map(m => m.name));
  return plan;
}

/* -------------------------------------------- */

/**
 * Whether a granted spell and a chosen spell are the same entitlement and may be collapsed.
 *
 * Identity has already matched (same compendium source, same level) by the time this is called; what
 * remains is to rule out the ways two same-named spells can still be genuinely separate.
 *
 * @param {Item5e} granted
 * @param {Item5e} chosen
 * @returns {boolean}
 */
function mergeable(granted, chosen) {
  // Identity matched on `system.identifier`, which is deliberately loose enough to see the same
  // spell in two packages as one thing. The cost of that looseness is that a homebrew pack reusing
  // an official identifier for a different spell would match too, so the name has to agree as well.
  // Cheap, and it keeps the merge as narrow as it was before the key was widened.
  if ( String(granted.name ?? "") !== String(chosen.name ?? "") ) return false;

  // A feat's spell is its own entitlement. Magic Initiate grants Cure Wounds once per long rest
  // *and* a Cleric may prepare it normally; those are two different things the character can do, and
  // collapsing them would silently take one away.
  const chosenSource = String(chosen.system?.sourceItem ?? "");
  const grantedSource = String(granted.system?.sourceItem ?? "");
  if ( chosenSource.startsWith("feat:") || grantedSource.startsWith("feat:") ) return false;

  // Different slot pools are different resources — a Warlock's pact-magic copy and an ordinary
  // spell-slot copy are not interchangeable, so neither can stand in for the other.
  const grantedMethod = String(granted.system?.method ?? "");
  const chosenMethod = String(chosen.system?.method ?? "");
  if ( grantedMethod && chosenMethod && (grantedMethod !== chosenMethod) ) return false;

  // Likewise a different casting ability: the same spell cast off Wisdom and off Charisma comes
  // from two different sources, with two different attack bonuses and save DCs.
  const grantedAbility = String(granted.system?.ability ?? "");
  const chosenAbility = String(chosen.system?.ability ?? "");
  if ( grantedAbility && chosenAbility && (grantedAbility !== chosenAbility) ) return false;

  return true;
}

/**
 * The display name of whatever granted a spell — the feature, subclass or class behind its
 * `advancementOrigin` — for the Review screen's attribution. Falls back to the spell's own
 * `sourceItem` tag, and finally to nothing rather than guessing.
 *
 * @param {Item5e} item
 * @param {Actor5e|{items: Iterable<Item5e>}} actorLike
 * @returns {string}
 */
function grantSourceName(item, actorLike) {
  const origin = item.getFlag?.("dnd5e", "advancementOrigin") ?? item.flags?.dnd5e?.advancementOrigin ?? "";
  const [ownerId] = String(origin).split(".");
  if ( ownerId ) {
    const owner = actorLike.items?.get?.(ownerId)
      ?? [...(actorLike.items ?? [])].find(candidate => candidate.id === ownerId);
    if ( owner?.name ) return owner.name;
  }
  const tag = String(item.system?.sourceItem ?? "");
  return tag.includes(":") ? tag.split(":")[1] : "";
}
