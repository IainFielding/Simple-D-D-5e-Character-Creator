/**
 * Shape-tolerant readers for a dnd5e item's advancements.
 *
 * dnd5e hands advancements back in several shapes depending on how the document was obtained and
 * which system version produced it: a prepared document exposes an `advancement.byId` Collection
 * (Map-like) or plain object, while a `toObject()`d one carries only the raw `system.advancement`,
 * itself either an array or an id-keyed object. Every reader in the module wants a plain array, so
 * the flattening lives here once rather than being re-derived per caller.
 *
 * For a junior dev: this is the single seam a dnd5e version bump is most likely to break, which is
 * exactly why it is one function with its own unit tests rather than an inline expression repeated
 * across the data modules.
 */

/**
 * An advancement's display name, across both dnd5e generations.
 *
 * 5.3.x stores it as `title`; 6.0.0 renamed the schema field to `name` and left `title` as a
 * deprecated getter that calls `logCompatibilityWarning` **on every read**. That is not merely
 * untidy: `warmChoices` walks every advancement of every card concurrently, and each warning
 * carries a stack trace, which was enough to exhaust the renderer and crash the browser tab
 * outright — the hooks suite died as `page.evaluate: Target crashed`.
 *
 * `name` first, so 6.0.0 never touches the deprecated path; `title` remains the 5.3.x fallback.
 * @param {object} advancement
 * @returns {string}   The name, or "" when the advancement has neither.
 */
export function advancementTitle(advancement) {
  return advancement?.name ?? advancement?.title ?? "";
}

/**
 * A document's advancements as a flat array, tolerating every shape dnd5e may hand back. The
 * prepared `doc.advancement.byId` is preferred because it is always populated; the raw
 * `system.advancement` is the fallback for plain object data.
 * @param {object} doc
 * @returns {object[]}
 */
export function advancementArray(doc) {
  const byId = doc.advancement?.byId;
  if ( byId ) return typeof byId.values === "function" ? [...byId.values()] : Object.values(byId);
  const raw = doc.system?.advancement;
  if ( !raw ) return [];
  if ( Array.isArray(raw) ) return raw;
  if ( typeof raw.values === "function" ) return [...raw.values()];
  return Object.values(raw);
}

/**
 * A compendium uuid in its modern form, inserting the `.Item.` segment older content omits.
 *
 * Pre-v10 packs store `Compendium.<scope>.<pack>.<id>`; everything since carries
 * `Compendium.<scope>.<pack>.Item.<id>`. Both are still in the wild — the 2014 SRD classes and
 * Tasha's replacement maps use the old shape — and the two forms compare unequal, so anything that
 * *matches* uuids has to agree on one. Normalising on read and on write is the only way to keep a
 * selection, the record of what was applied, and a click on a card all talking about the same item.
 * @param {string} uuid
 * @returns {string}
 */
export function withItemSegment(uuid) {
  const parts = String(uuid).split(".");
  if ( parts[3] === "Item" ) return uuid;
  parts.splice(3, 0, "Item");
  return parts.join(".");
}

/* -------------------------------------------- */
/*  Reading what an advancement recorded        */
/* -------------------------------------------- */

/**
 * How many entries one of dnd5e's recorded collections holds, whatever shape it arrived in.
 *
 * The same field is a real `Set` on a prepared advancement (`Trait`'s `value.chosen` is a
 * `SetField`) but a plain array in raw source data from `toObject()`, and the `MappingField`s used
 * elsewhere arrive as plain objects. A bare `.length` reads `undefined` on all but the array —
 * which silently counts as zero, reporting a genuinely-made choice as unmade.
 * @param {Set|Map|object|Array|null|undefined} value
 * @returns {number}
 */
export function entryCount(value) {
  if ( !value ) return 0;
  if ( (value instanceof Set) || (value instanceof Map) ) return value.size;
  if ( Array.isArray(value) ) return value.length;
  if ( typeof value === "object" ) return Object.keys(value).length;
  return 0;
}

/**
 * The values of such a collection as a flat array, for the same reason as {@link entryCount}.
 * @param {Set|Map|object|Array|null|undefined} value
 * @returns {any[]}
 */
export function entryValues(value) {
  if ( !value ) return [];
  if ( value instanceof Map ) return [...value.values()];
  if ( (value instanceof Set) || Array.isArray(value) ) return [...value];
  if ( typeof value === "object" ) return Object.values(value);
  return [];
}

/**
 * The `{itemId: uuid}` map an advancement recorded, flattened across both storage shapes.
 *
 * dnd5e stores `value.added` two different ways, and which one is not a property of the individual
 * advancement's configuration but of its **type**: `ItemGrantAdvancement` writes a flat
 * `{itemId: uuid}`, while `ItemChoiceAdvancement` — whose value schema is
 * `MappingField(MappingField(StringField))` — nests that under the level it was chosen at. The
 * system's own signal for the difference is the `multiLevel` metadata flag, so that is what is read
 * here rather than a hardcoded list of type names.
 *
 * Getting this wrong is quiet rather than loud: a level-keyed map read flat yields level *numbers*
 * where item ids were expected, so every subsequent `items.get(id)` simply misses.
 * @param {object} advancement
 * @param {number} [level]   For a multi-level advancement, the level to read; omitted, every level
 *   is merged into one map.
 * @returns {Record<string, string>}
 */
export function addedEntries(advancement, level) {
  const added = advancement?.value?.added;
  if ( !added ) return {};
  if ( !advancement.constructor?.metadata?.multiLevel ) return { ...added };
  if ( level !== undefined ) return { ...(added[level] ?? {}) };
  return Object.assign({}, ...entryValues(added).map(m => m ?? {}));
}

/**
 * Whether an advancement on a class item applies to *this* character's version of that class.
 *
 * A class can carry two versions of the same grant — one restricted to when it is the character's
 * original class, one to when it is not — which is how dnd5e models the reduced proficiencies a
 * multiclass entry grants (the 2024 Bard gives 3 skills and 3 tools as an original class, 1 and 1
 * as a multiclass pick). dnd5e's own `AdvancementManager` filters its step list by exactly this, so
 * an inapplicable grant never gets a step to answer and its `value` stays empty forever — which
 * means anything reading `value` directly has to apply the same filter or report that empty value
 * as an unanswered choice.
 *
 * Read here rather than off the advancement so it also works on plain `toObject()` data, which
 * carries `classRestriction` but no getters.
 *
 * **Deliberately diverges from `Advancement#appliesToClass` in one case.** `Item5e#isOriginalClass`
 * returns `null` for an item not embedded in an actor — a compendium document, which is exactly what
 * the creation grids and the choice resolver work with — and dnd5e's own getter resolves that `null`
 * as matching *both* restrictions ("always true outside an embedded class item"). Taking that
 * literally at creation would offer a Bard both its 3-skill original-class grant and its 1-skill
 * multiclass grant at once, which is the duplication this filter exists to prevent. An unanswerable
 * original-class question is therefore resolved as "yes, original" instead: the first class a
 * character takes always is one, and a real multiclass entry is embedded by the time it is asked.
 * @param {object} advancement
 * @param {object} [item]   The owning item; defaults to the advancement's own.
 * @returns {boolean}
 */
export function appliesToClass(advancement, item = advancement?.item) {
  const restriction = advancement?.classRestriction;
  if ( !restriction ) return true;
  const original = item?.isOriginalClass ?? true;
  return (restriction === "primary") ? !!original : !original;
}

/**
 * Every real player choice on an item that is still unanswered.
 *
 * dnd5e deliberately never blocks its own "Next"/"Complete" button on an unmade Trait, ItemChoice,
 * ASI or Subclass pick, so an item can land on a character with a genuine choice silently left
 * empty. "The item is there" is therefore not the same as "everything about it was chosen", which
 * matters wherever we inherit a character we did not build ourselves — the Ember hand-off, and the
 * e2e harness comparing our output against a natively-built one.
 *
 * Reads the real per-advancement `value` dnd5e itself tracks rather than re-deriving anything, via
 * the shape-tolerant readers above.
 * @param {object} item      A class, species, background or feat item.
 * @param {number} [level]   The character's relevant level for this item (a class's own
 *   `system.levels`). Left at Infinity for level-less items, whose choices are all level-1.
 * @returns {{id: string, type: string, title: string}[]}
 */
export function unresolvedAdvancements(item, level = Infinity) {
  const out = [];
  const flag = adv => out.push({ id: adv._id, type: adv.type, title: advancementTitle(adv) || adv.type });

  for ( const adv of advancementArray(item) ) {
    if ( (typeof adv.level === "number") && (adv.level > level) ) continue;
    if ( !appliesToClass(adv, item) ) continue;

    switch ( adv.type ) {
      case "Trait": {
        const required = (adv.configuration?.choices ?? [])
          .reduce((sum, c) => sum + (c?.count ?? 0), 0);
        if ( required && (entryCount(adv.value?.chosen) < required) ) flag(adv);
        break;
      }
      case "ItemChoice": {
        // Only the tiers at or below the character's level are owed an answer yet.
        const choices = Object.entries(adv.configuration?.choices ?? {});
        const required = choices
          .filter(([at, c]) => (Number(at) <= level) && c?.count)
          .reduce((sum, [, c]) => sum + c.count, 0);
        if ( !required ) break;
        const added = choices
          .filter(([at]) => Number(at) <= level)
          .reduce((sum, [at]) => sum + entryCount(addedEntries(adv, at)), 0);
        if ( added < required ) flag(adv);
        break;
      }
      case "AbilityScoreImprovement": {
        // `points` is the spendable budget; with none there is nothing to answer, only the `fixed`
        // increases the advancement applies on its own. An untouched advancement still carries
        // `value: {type: "asi"}` — one real key — so the value must be checked for the two shapes a
        // *decision* actually takes, not merely for being non-empty.
        if ( !(adv.configuration?.points > 0) ) break;
        const spent = entryCount(adv.value?.assignments) || entryCount(adv.value?.feat);
        if ( !spent ) flag(adv);
        break;
      }
      case "Subclass":
        if ( !adv.value?.uuid ) flag(adv);
        break;
    }
  }
  return out;
}
