/**
 * Canonicalise an actor so two independently-built characters can be compared.
 *
 * The two build paths create the same *content* with different random ids, so a raw
 * `toObject()` diff is 100% noise. Normalising does three things:
 *
 *  1. **Identity, not id.** Every embedded item is keyed by what it *is* — its compendium
 *     source uuid — rather than by its random `_id`. Duplicates of the same source are
 *     disambiguated by an occurrence index after a stable sort.
 *  2. **Reference rewriting.** Item ids leak into advancement bookkeeping (`value.added` is
 *     *keyed* by item id; `value.feat`, `value.replaced`, `system.details.originalClass` and
 *     `flags.dnd5e.advancementOrigin` all embed them). Every 16-character id found anywhere —
 *     in a value, inside a compound string, or as an object key — is rewritten to its identity.
 *  3. **Dropping the incomparable.** Timestamps, sort orders, ownership, and the identity/
 *     biography fields the creator writes but a bare native build never touches.
 *
 * What survives is exactly what the advancement machinery produced. Derived state
 * (ability totals, hit points, proficiencies, scale values) is captured separately in
 * {@link derivedSnapshot}, because a source-only diff would miss a bug that changes what the
 * character can actually *do*.
 */

/** Actor-level source fields that say nothing about advancement output. */
const DROP_ACTOR = new Set([
  "_id", "_stats", "sort", "ownership", "folder", "img", "name", "prototypeToken", "effects"
]);

/** Item-level source fields dropped for the same reason. */
const DROP_ITEM = new Set(["_id", "_stats", "sort", "ownership", "folder"]);

/** `system.details` keys that are pure identity/biography, written only by the creator. */
const DROP_DETAILS = new Set([
  "alignment", "faith", "gender", "eyes", "hair", "skin", "height", "weight", "age",
  "trait", "ideal", "bond", "flaw", "appearance", "biography"
]);

/** A Foundry document id: exactly 16 alphanumerics, anchored (see {@link rewriteString}). */
const ID_RE = /^[a-zA-Z0-9]{16}$/;

/**
 * Document types that appear as the name half of a Foundry relative-uuid path — the
 * `Actor.<id>.Item.<id>.Activity.<id>` shape that `flags.core.originText` and `flags.dnd5e.cachedFor`
 * are written in. Recognising the *form* is what makes those safe to rewrite; see
 * {@link rewriteString}.
 */
const DOC_TYPES = new Set(["Actor", "Item", "Activity", "ActiveEffect", "Scene", "Token", "Compendium"]);

/** The module under test's flag scope, stripped from both snapshots. */
const MODULE_FLAG = "sogrom-dnd5e-character-creator";

/**
 * Strip the empty rider lists from an item's `flags.dnd5e`, and the `riders` flag itself once
 * nothing is left in it.
 *
 * Per *list* rather than per flag, because the native walk drops them a key at a time: an item can
 * come back with `riders.activity` populated and `riders.effect` gone, and comparing the whole flag
 * would keep an empty `effect: []` against nothing and report it. A list with content is untouched
 * and still reports.
 *
 * Anything that is not a recognised empty shape is left alone, so an unexpected value is reported
 * rather than quietly dropped — the safe direction for a rule that decides what the diff stops
 * looking at.
 * @param {object} [flags]   An item entry's `flags` object, mutated in place.
 */
function stripEmptyRiders(flags) {
  const riders = flags?.dnd5e?.riders;
  if ( riders === undefined ) return;
  if ( Array.isArray(riders) ) {
    if ( !riders.length ) delete flags.dnd5e.riders;
    return;
  }
  if ( !riders || (typeof riders !== "object") ) return;
  for ( const [key, value] of Object.entries(riders) ) {
    if ( Array.isArray(value) ? !value.length : !value ) delete riders[key];
  }
  if ( !Object.keys(riders).length ) delete flags.dnd5e.riders;
}

/* -------------------------------------------- */

/**
 * The identity of an embedded item: its compendium source if it has one (everything granted by
 * an advancement does), else a type/name fallback for hand-made items.
 * @param {object} item   Item source data.
 * @returns {string}
 */
function itemIdentity(item) {
  const source = item._stats?.compendiumSource ?? item.flags?.core?.sourceId;
  return source ?? `local:${item.type}:${item.name}`;
}

/**
 * A digest of what an item *is*, ignoring everything that differs between two builds of the same
 * character. Used only to order same-identity duplicates — see {@link buildIdMap}.
 *
 * Volatile keys are dropped wherever they appear (`_id` on the item and on every embedded effect,
 * `_stats` timestamps, `sort`, and the whole `flags` subtree, which carries advancement-origin ids),
 * and object keys are emitted in sorted order so two equal items always digest the same.
 */
function contentKey(value) {
  if ( Array.isArray(value) ) return `[${value.map(contentKey).join(",")}]`;
  if ( !value || (typeof value !== "object") ) return JSON.stringify(value) ?? "null";
  const drop = new Set(["_id", "_stats", "sort", "ownership", "folder", "flags"]);
  return `{${Object.keys(value).sort()
    .filter(k => !drop.has(k))
    .map(k => `${k}:${contentKey(value[k])}`)
    .join(",")}}`;
}

/**
 * Map every embedded item id to a stable identity, disambiguating repeats of the same source
 * with an occurrence suffix so two copies of one item stay distinguishable but comparable.
 *
 * The tie-break between duplicates is their **content**, not their position. A character can hold
 * two items with one compendium source and different data — a Shadow Sorcerer carries two copies of
 * Summon Beast, one of them enchantment-modified — and ordering those by array position pairs
 * `#1` with `#2` across the two builds whenever they happened to create them in opposite order. The
 * diff then reports every field of both copies as different when the pair is in fact identical.
 * @param {object[]} items
 * @returns {Map<string, string>}
 */
function buildIdMap(items) {
  const seen = new Map();
  const map = new Map();
  // Identity first so numbering does not depend on creation order, then content so a duplicate
  // always takes the same number as its counterpart in the other build.
  const ordered = [...items]
    .map(item => ({ item, identity: itemIdentity(item), content: contentKey(item) }))
    .sort((a, b) => a.identity.localeCompare(b.identity) || a.content.localeCompare(b.content));

  for ( const { item, identity } of ordered ) {
    const n = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, n);
    map.set(item._id, n > 1 ? `${identity}#${n}` : identity);
  }
  return map;
}

/**
 * Rewrite item ids in a string.
 *
 * Deliberately narrow: only a string that *is* an id, or a dot-separated reference whose every
 * segment is an id-or-advancement-id (`flags.dnd5e.advancementOrigin` is `"<itemId>.<advId>"`),
 * is rewritten. A blanket regex over all strings looks tempting but corrupts item descriptions —
 * PHB content is full of `@UUID[…Item.phbftrFighter000]` and `@Embed[…]` references whose
 * compendium ids are also 16 characters, and rewriting those invents differences that aren't there.
 */
function rewriteString(value, idMap) {
  if ( idMap.has(value) ) return idMap.get(value);
  if ( !value.includes(".") || (value.length > 80) ) return value;
  const parts = value.split(".");
  if ( parts.every(p => ID_RE.test(p) || (p === "")) ) {
    if ( !parts.some(p => idMap.has(p)) ) return value;
    return parts.map(p => idMap.get(p) ?? p).join(".");
  }
  return rewriteDocumentPath(parts, value, idMap);
}

/**
 * Rewrite the id halves of a Foundry relative-uuid path.
 *
 * `flags.core.originText` and `flags.dnd5e.cachedFor` carry `Actor.<id>.Item.<id>.Activity.<id>`,
 * which the plain rewrite above refuses because "Actor" and "Item" are not ids. Left alone they
 * differ on every single run — two builds mean two actors — and an effect-bearing spell reports
 * three differences that say nothing. Matching the *alternating type/id shape* is what keeps this
 * as narrow as the rule it extends: a description string never has that form, so nothing inside
 * `@UUID[…]` can be caught by it.
 *
 * An id keeps its identity where we know one: an embedded item still maps to its compendium source,
 * so two spells' `cachedFor` do not collapse into the same normalised string. The actor's own id and
 * a per-build activity id have no stable identity to map to, and become a `<type>` placeholder.
 * @param {string[]} parts        The dot-split string.
 * @param {string} value          The original, returned unchanged when the shape does not match.
 * @param {Map<string,string>} idMap
 */
function rewriteDocumentPath(parts, value, idMap) {
  // A leading "" is the relative form (`.Item.<id>.Activity.<id>`), which is equally valid.
  const start = (parts[0] === "") ? 1 : 0;
  if ( (parts.length - start) < 2 ) return value;
  for ( let i = start; i < parts.length; i += 2 ) {
    if ( !DOC_TYPES.has(parts[i]) || !ID_RE.test(parts[i + 1] ?? "") ) return value;
  }
  return parts
    .map((p, i) => (i > start - 1) && (i % 2 !== start % 2)
      ? (idMap.get(p) ?? `<${parts[i - 1].toLowerCase()}>`)
      : p)
    .join(".");
}

/**
 * Keys dropped wherever they appear, however deeply nested. `_stats` carries creation and
 * modification timestamps, which differ between two builds by exactly the wall-clock gap between
 * them — and it appears on embedded ActiveEffects as well as on items.
 */
const DROP_ANYWHERE = new Set(["_stats"]);

/**
 * Deep-copy a value, rewriting item ids in strings *and* in object keys, dropping the keys in
 * `drop` at the top level and those in {@link DROP_ANYWHERE} at every level.
 */
function rewrite(value, idMap, drop = null) {
  if ( typeof value === "string" ) return rewriteString(value, idMap);
  if ( Array.isArray(value) ) return value.map(v => rewrite(v, idMap));
  if ( value && (typeof value === "object") ) {
    const out = {};
    for ( const [key, val] of Object.entries(value) ) {
      if ( drop?.has(key) || DROP_ANYWHERE.has(key) ) continue;
      out[rewriteString(key, idMap)] = rewrite(val, idMap);
    }
    return out;
  }
  return value;
}

/**
 * Re-key an item's activities by what they are rather than by their random id.
 *
 * `system.activities` is a map keyed by a generated id, so an activity created at runtime — the
 * "(free casting)" forward activity a Magic Initiate spell gets, for instance — lands under a
 * different key on each build and reads as two unrelated differences instead of one match. Keying
 * on type and name (with an occurrence suffix for repeats) makes them comparable, and the id
 * itself is dropped for the same reason item `_id`s are.
 * @param {object} item   A rewritten item entry, mutated in place.
 */
function normaliseActivities(item) {
  const activities = item?.system?.activities;
  if ( !activities || (typeof activities !== "object") ) return;

  const identity = a => `${a?.type ?? "?"}:${a?.name ?? ""}`;
  const seen = new Map();
  const out = {};
  for ( const activity of Object.values(activities).sort((a, b) => identity(a).localeCompare(identity(b))) ) {
    const base = identity(activity);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const copy = { ...activity };
    delete copy._id;
    out[n > 1 ? `${base}#${n}` : base] = copy;
  }
  item.system.activities = out;
}

/**
 * Drop the generated `_id` on every entry of an effect's `system.changes`.
 *
 * dnd5e 6.0.0 gives each change its own `_id`, minted when the effect is created, so the two builds
 * mint different ones for identical content and every enchantment-carrying granted spell reports a
 * row per change. It is volatile identity, exactly like the activity `_id` above and the item `_id`
 * in `DROP_ITEM` — the change's own fields are what the comparison is about. Left in, it accounted
 * for 114 rows across 28 subclasses on the first 6.0.0 sweep, three of them failing on nothing else.
 * @param {object} item   A rewritten item entry, mutated in place.
 */
function normaliseEffectChanges(item) {
  for ( const effect of item?.effects ?? [] ) {
    for ( const change of effect?.system?.changes ?? [] ) delete change._id;
  }
}

/* -------------------------------------------- */

/**
 * The comparable source snapshot of a built character.
 * @param {Actor5e} actor
 * @returns {{actor: object, items: Record<string, object>}}
 */
export function sourceSnapshot(actor) {
  const src = actor.toObject();
  const idMap = buildIdMap(src.items ?? []);

  const items = {};
  for ( const item of src.items ?? [] ) {
    const entry = rewrite(item, idMap, DROP_ITEM);
    normaliseActivities(entry);
    normaliseEffectChanges(entry);
    // The module under test stamps its own flags; they are bookkeeping, not advancement output.
    if ( entry.flags ) delete entry.flags[MODULE_FLAG];

    // An *empty* rider list is bookkeeping too, and was the single noisiest thing in the whole
    // comparison: the pack ships `flags.dnd5e.riders`, the native walk drops it from every item it
    // writes to, and the difference appeared on 91 of 92 subclasses — enough that no scenario could
    // ever report identical and the pass/fail column meant nothing. Across a full level-20 sweep all
    // 242 rows held nothing on either side, so an empty list is dropped and a populated one reports.
    //
    // The driver now clears the flag itself wherever the system gives it an update to ride on, so
    // this matters only for a level-1 build, where every item is *created* and never updated —
    // `preUpdateActivities` has nothing to fire on, and native's items are cleaned purely because it
    // runs one manager per origin and each re-writes the last one's items. `--keep-riders` turns
    // this off to see what is left underneath.
    if ( !globalThis.__keepRiders ) stripEmptyRiders(entry.flags);
    items[idMap.get(item._id)] = entry;
  }

  const actorData = rewrite({ ...src, items: undefined }, idMap, DROP_ACTOR);
  delete actorData.items;
  if ( actorData.flags ) delete actorData.flags[MODULE_FLAG];
  for ( const key of DROP_DETAILS ) delete actorData.system?.details?.[key];

  // dnd5e 6.0.0 gives actors their own `system.identifier`, slugified from the actor name. The two
  // builds are deliberately named `…-native` and `…-creator` so they can be told apart in the
  // world, so this is a restatement of the name `DROP_ACTOR` already drops — it would otherwise
  // report one row on every scenario, saying nothing about advancement output.
  delete actorData.system?.identifier;

  return { actor: actorData, items };
}

/**
 * The derived snapshot: what the character can actually do once the system has prepared it.
 * A source diff alone can miss (or over-report) here, so both are compared.
 * @param {Actor5e} actor
 * @returns {object}
 */
export function derivedSnapshot(actor) {
  const sys = actor.system ?? {};
  const pick = (obj, fn) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, fn(v)]));

  return {
    level: sys.details?.level ?? null,
    hp: { max: sys.attributes?.hp?.max ?? null },
    abilities: pick(sys.abilities, a => ({ value: a.value, mod: a.mod, proficient: a.proficient })),
    skills: pick(sys.skills, s => ({ value: s.value, ability: s.ability })),
    tools: pick(sys.tools, t => ({ value: t.value })),
    traits: {
      size: sys.traits?.size ?? null,
      armorProf: [...(sys.traits?.armorProf?.value ?? [])].sort(),
      weaponProf: [...(sys.traits?.weaponProf?.value ?? [])].sort(),
      languages: [...(sys.traits?.languages?.value ?? [])].sort(),
      weaponMastery: [...(sys.traits?.weaponProf?.mastery?.value ?? [])].sort()
    },
    scale: JSON.parse(JSON.stringify(sys.scale ?? {})),
    spellcasting: {
      slots: pick(sys.spells, s => ({ max: s.max, level: s.level })),
      dc: sys.attributes?.spell?.dc ?? sys.attributes?.spelldc ?? null
    },
    // Item names by type — the cheapest readable signal that the same things were granted.
    itemsByType: [...actor.items].reduce((acc, i) => {
      (acc[i.type] ??= []).push(i.name);
      return acc;
    }, {})
  };
}

/** Both halves of a comparison snapshot. */
export function snapshot(actor) {
  const derived = derivedSnapshot(actor);
  for ( const list of Object.values(derived.itemsByType) ) list.sort();
  return { source: sourceSnapshot(actor), derived };
}

/* -------------------------------------------- */

/**
 * Recursively diff two snapshots into a flat list of `{ path, native, creator }` entries.
 *
 * Arrays of **primitives are compared as multisets** — what is present, not in what order. Nearly
 * every such array here is a `Set` in the dnd5e schema, serialised to JSON: `traits.languages.value`,
 * `traits.weaponProf.value`, an advancement's `value.chosen`. The two builds insert into them in
 * different orders, so a positional walk reported a character who knows Draconic, Dwarvish and
 * Thieves' Cant as three differences against a character who knows exactly the same three.
 *
 * It also stops one real difference from reading as many. A missing entry used to shift every later
 * index, so a single absent spell produced a row per spell after it — the diff's size tracked the
 * position of the problem rather than its size.
 *
 * Arrays of objects stay positional: there is no key to match members on, so "same contents,
 * different order" is not a question that can be answered cheaply, and none of the object arrays in
 * these snapshots reorder in practice.
 * @param {*} a          The native (reference) value.
 * @param {*} b          The creator value.
 * @param {string} path
 * @param {object[]} out
 * @returns {{path: string, native: *, creator: *}[]}
 */
export function diff(a, b, path = "", out = []) {
  if ( a === b ) return out;

  const aObj = a && (typeof a === "object");
  const bObj = b && (typeof b === "object");
  if ( !aObj || !bObj || (Array.isArray(a) !== Array.isArray(b)) ) {
    out.push({ path: path || "<root>", native: brief(a), creator: brief(b) });
    return out;
  }

  if ( Array.isArray(a) ) {
    if ( a.every(isPrimitive) && b.every(isPrimitive) ) return diffMultiset(a, b, path, out);
    const len = Math.max(a.length, b.length);
    for ( let i = 0; i < len; i++ ) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }

  for ( const key of new Set([...Object.keys(a), ...Object.keys(b)]) ) {
    diff(a[key], b[key], path ? `${path}.${key}` : key, out);
  }
  return out;
}

const isPrimitive = v => (v === null) || (typeof v !== "object");

/**
 * Compare two primitive arrays by membership, reporting one row per entry only one side has.
 * A pure reordering produces nothing.
 */
function diffMultiset(a, b, path, out) {
  const count = list => list.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map());
  const av = count(a);
  const bv = count(b);
  for ( const key of new Set([...av.keys(), ...bv.keys()]) ) {
    const an = av.get(key) ?? 0;
    const bn = bv.get(key) ?? 0;
    if ( an === bn ) continue;
    // Counts rather than bare presence, so a duplicated entry is not silently equal to a single one.
    out.push({
      path: `${path}[]`,
      native: an ? (an > 1 ? `${brief(key)} ×${an}` : brief(key)) : "<missing>",
      creator: bn ? (bn > 1 ? `${brief(key)} ×${bn}` : brief(key)) : "<missing>"
    });
  }
  return out;
}

/** Truncate a value for readable reporting — item descriptions run to thousands of characters. */
function brief(value) {
  if ( value === undefined ) return "<missing>";
  const text = (value && (typeof value === "object")) ? JSON.stringify(value) : String(value);
  return text.length > 160 ? `${text.slice(0, 160)}… (${text.length} chars)` : text;
}
