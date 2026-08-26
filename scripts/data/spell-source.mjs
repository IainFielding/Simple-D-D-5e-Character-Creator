import { DEFAULT_CANTRIPS, DEFAULT_LEVEL1_SPELLS, log } from "../config.mjs";
import { advancementArray } from "./advancement-util.mjs";
import { getEnabledPacks, isUsableItemPack } from "./compendium-util.mjs";
import { forEachLimit, WARM_CONCURRENCY } from "./concurrency.mjs";

/** The class spell lists a Magic Initiate-style feat can draw from — warmed up front so the
 *  feat-spells step opens instantly. Kept in sync with feat-spells-step's CLASS_LISTS. */
export const MAGIC_INITIATE_LISTS = ["cleric", "druid", "wizard"];

/**
 * Class spell lists a spellcasting *subclass* borrows when dnd5e registers no list of its own,
 * keyed `<classIdentifier>:<subclassIdentifier>`. Most subclass casters (the domains, the Circles,
 * the Oaths) ship a `subclass:` spell list, but the third-casters don't: the Eldritch Knight and
 * the Arcane Trickster prepare from the Wizard list, and that fact lives only in the prose of their
 * Spellcasting feature. Without this their pool resolves to nothing at all.
 */
export const SUBCLASS_SPELL_LISTS = {
  "fighter:eldritch-knight": "wizard",
  "rogue:trickster": "wizard",       // the PHB Arcane Trickster's identifier is "trickster"
  "rogue:arcane-trickster": "wizard" // …but older/third-party data spells it out
};

/** Index fields fetched for spells, so cards can show components/range without the full doc. */
const SPELL_INDEX_FIELDS = new Set([
  "system.level", "system.school", "system.identifier", "system.properties",
  "system.activation.type", "system.activation.value", "system.range.units", "system.range.value"
]);

/**
 * Resolves the cantrips and level-1 spells a spellcasting class can learn at level 1,
 * and how many of each it knows. One instance per builder session; results are
 * memoised per class UUID so re-entering the Spells step is cheap.
 *
 * This is the spell counterpart of {@link SourceIndex}: it reads dnd5e's spell-list
 * registry (with pack-scan fallbacks) and presents lightweight spell cards. It never
 * touches state or the DOM.
 *
 * For a junior dev: dnd5e keeps a "spell-list registry" that maps each class to the spells on its
 * list. This class queries that (falling back to scanning packs if needed) and hands back small
 * spell "cards". As with SourceIndex, the private #maps memoise results so re-opening a step is
 * instant. Two distinct jobs: forClass() = the level-1 creation view; forClassAtLevel() = the wider
 * pool a mid-game level-up can pick from.
 */
export class SpellSource {

  // Every memo below stores the in-flight *promise*, not the resolved payload, so concurrent
  // callers (the ready warm-up, a level-up window's background warm, and the step that finally
  // renders) converge on a single load instead of racing duplicates. A failed load un-caches
  // itself so a later call can retry.

  /** classUuid -> spell-payload promise, memoised. */
  #byClass = new Map();

  /**
   * `${listType}:${classUuid}:${maxSpellLevel}` -> level-up spell-pool *promise*, memoised.
   * The promise (not the resolved payload) is stored so a background warm-up and the spell
   * step share a single in-flight load instead of racing two.
   */
  #byLevelUp = new Map();

  /** spell uuid -> enriched-description promise, memoised (loaded on focus). */
  #descriptions = new Map();   // uuid -> promise of { enriched, source }

  /** maxSpellLevel -> promise of Map(uuid -> browser index entry), one browse shared by all classes. */
  #spellFetches = new Map();

  /**
   * Spell options for a class, or a non-caster marker. Memoised per class UUID.
   * @param {string} classUuid
   * @returns {Promise<{isSpellcaster:boolean, cantrips?:object[], level1?:object[],
   *   maxCantrips?:number, maxSpells?:number, classId?:string}>}
   */
  async forClass(classUuid) {
    if ( !classUuid ) return { isSpellcaster: false };
    if ( !this.#byClass.has(classUuid) ) {
      const promise = this.#resolve(classUuid)
        .catch(err => { this.#byClass.delete(classUuid); throw err; });
      this.#byClass.set(classUuid, promise);
    }
    return this.#byClass.get(classUuid);
  }

  /**
   * One Compendium Browser pass over every spell of level ≤ `maxLevel`, shared across classes:
   * the warm-up resolves a dozen class lists against the same pool instead of each paying its own
   * full-pack browse. Resolves null when the browser API is unavailable or the browse fails
   * (un-caching itself first), leaving callers to their direct-lookup fallback.
   * @param {number} maxLevel
   * @returns {Promise<Map<string, object>|null>}
   */
  #fetchSpellPool(maxLevel) {
    if ( !this.#spellFetches.has(maxLevel) ) {
      const promise = (async () => {
        const browser = dnd5e.applications?.CompendiumBrowser;
        if ( !browser?.fetch ) return null;
        const all = await browser.fetch(Item, {
          types: new Set(["spell"]),
          filters: [{ k: "system.level", o: "lte", v: maxLevel }],
          indexFields: SPELL_INDEX_FIELDS
        });
        const map = new Map();
        for ( const e of all ) if ( e.uuid ) map.set(e.uuid, e);
        return map;
      })().catch(err => {
        log("Compendium Browser spell fetch failed, using direct lookups", err);
        this.#spellFetches.delete(maxLevel);
        return null;
      });
      this.#spellFetches.set(maxLevel, promise);
    }
    return this.#spellFetches.get(maxLevel);
  }

  /**
   * The level-up spell pool for a class: every spell it can learn from cantrips up to
   * `maxSpellLevel`, grouped by spell level. Unlike {@link forClass} (which is level-1 only for
   * creation), this loads the class's whole castable range so a mid-game caster can pick the new
   * spells a level-up unlocked. The *counts* the player may add are computed by the level-up spell
   * step from the actor's derived data ({@link cantripsKnownAtLevel} / `preparation.max`); this only
   * supplies the options. Memoised per `${classUuid}:${maxSpellLevel}`.
   * @param {string} classUuid
   * @param {number} maxSpellLevel   Highest spell level the actor has slots for.
   * @param {"class"|"subclass"} [listType="class"]  Registry list type — "subclass" for a
   *   subclass caster (Eldritch Knight / Arcane Trickster), whose list is registered under it.
   * @returns {Promise<{isSpellcaster:boolean, byLevel?:Record<number,object[]>, classId?:string, maxSpellLevel?:number}>}
   */
  async forClassAtLevel(classUuid, maxSpellLevel, listType = "class", { doc = null } = {}) {
    if ( !classUuid && !doc ) return { isSpellcaster: false };
    // Key on the casting item's identifier when we have the document, since that — not the UUID it
    // was copied from — is what the spell list is actually looked up by; every character casting as
    // a sorcerer then shares one load. A UUID-only call keeps its old key.
    const key = `${listType}:${doc?.system?.identifier || classUuid}:${maxSpellLevel}`;
    // Memoise the in-flight promise so the level-up shell's background warm-up and the spell
    // step's own load converge on one fetch; a failed load un-caches itself so it can retry.
    if ( !this.#byLevelUp.has(key) ) {
      const promise = this.#resolveAtLevel(classUuid, maxSpellLevel, listType, doc)
        .catch(err => { this.#byLevelUp.delete(key); throw err; });
      this.#byLevelUp.set(key, promise);
    }
    return this.#byLevelUp.get(key);
  }

  /** classId -> spell-list payload promise for a feat's spell choice (Magic Initiate), memoised. */
  #byList = new Map();

  /**
   * The cantrips and level-1 spells of a single class's spell **list**, addressed by class
   * identifier rather than a class item's UUID. Backs the feat-spells step (Magic Initiate and its
   * single-class variants): the feat's `restriction.list` names a class id, and the player draws all
   * of the feat's spells from that one list. Unlike {@link forClass} there is no "known count" — the
   * counts come from the feat's own advancements — so this returns only the pools. Memoised per
   * `${classId}:${maxLevel}`.
   * @param {string} classId
   * @param {number} [maxLevel=1]
   * @returns {Promise<{cantrips: object[], level1: object[], byLevel: Record<number, object[]>}>}
   *   `cantrips`/`level1` are the two buckets every caller wanted before spell choices above 1st
   *   level had to be served; `byLevel` is the same spells indexed by their own level, for a
   *   restriction that names one (see {@link module:levelup/steps/choices-step}).
   */
  async forSpellList(classId, maxLevel = 1) {
    if ( !classId ) return { cantrips: [], level1: [], byLevel: {} };
    const key = `${classId}:${maxLevel}`;
    if ( !this.#byList.has(key) ) {
      const promise = this.#resolveList(classId, maxLevel)
        .catch(err => { this.#byList.delete(key); throw err; });
      this.#byList.set(key, promise);
    }
    return this.#byList.get(key);
  }

  async #resolveList(classId, maxLevel) {
    const all = deduplicateSpells(
      await loadSpellsForClass(classId, maxLevel, "class", this.#fetchSpellPool(maxLevel)));
    const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
    const byLevel = {};
    for ( let l = 0; l <= maxLevel; l++ ) byLevel[l] = all.filter(s => s.level === l).sort(byName);
    // The two named buckets are `byLevel`'s first two entries under their old names: every existing
    // caller asks for cantrips or 1st-level spells, and re-filtering for them would be the same
    // work twice.
    return { cantrips: byLevel[0] ?? [], level1: byLevel[1] ?? [], byLevel };
  }

  /**
   * @param {Item5e|null} [staged]  The casting item itself, when the caller already holds it. The
   *   level-up passes the actor's (or advancement clone's) own class/subclass item, which is the
   *   only way this resolves for a class that has no compendium entry to fetch — Ember stages its
   *   class onto the clone without a `compendiumSource`, so `fromUuid` yields nothing and the pool
   *   would come back empty.
   */
  async #resolveAtLevel(classUuid, maxSpellLevel, listType, staged = null) {
    const doc = staged ?? await fromUuid(classUuid);
    const progression = doc?.system?.spellcasting?.progression;
    if ( !doc || !progression || progression === "none" ) return { isSpellcaster: false };

    const classId = doc.system?.identifier ?? doc.name?.toLowerCase() ?? "";
    const list = spellListFor(doc, classId, listType);
    const all = deduplicateSpells(
      await loadSpellsForClass(list.id, maxSpellLevel, list.type, this.#fetchSpellPool(maxSpellLevel)));
    const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
    const byLevel = {};
    for ( let l = 0; l <= maxSpellLevel; l++ ) byLevel[l] = all.filter(s => s.level === l).sort(byName);

    const borrowed = list.id === classId ? "" : ` from the ${list.type} "${list.id}" list`;
    log(`level-up spells for "${classId}"${borrowed} (≤ lvl ${maxSpellLevel}): ${all.length} total`);
    return { isSpellcaster: true, byLevel, classId, maxSpellLevel };
  }

  /**
   * Pre-resolve the spell payload for each class up front, so reaching the Spells step
   * (and the class step's known-counts gate) is instant rather than loading the whole
   * spell list on the click that selects a class. Memoised per UUID via {@link forClass};
   * a single class's failure is swallowed so it can't abort the rest of the warm-up.
   * @param {string[]} classUuids
   * @param {() => void} [onTick]  Invoked once per class warmed, for progress reporting.
   */
  async warmClasses(classUuids, onTick) {
    await forEachLimit(classUuids, WARM_CONCURRENCY, async uuid => {
      try {
        await this.forClass(uuid);
      } catch ( err ) {
        log(`failed to warm spells for ${uuid}`, err);
      }
      onTick?.();
    });
  }

  /**
   * Pre-resolve the level-≤`maxLevel` spell **lists** the feat-spells step reads, so reaching the
   * Magic Initiate feat-spell picker is instant rather than loading each class list on the click
   * that opens it. This fills the `#byList` memo that {@link forSpellList} reads — a cache distinct
   * from the class payloads {@link warmClasses} fills — so the two must both be warmed. A single
   * list's failure is swallowed so it can't abort the rest of the warm-up.
   * @param {string[]} classIds
   * @param {number} [maxLevel=1]
   * @param {() => void} [onTick]  Invoked once per list warmed, for progress reporting.
   */
  async warmLists(classIds, maxLevel = 1, onTick) {
    await forEachLimit(classIds, WARM_CONCURRENCY, async id => {
      try {
        await this.forSpellList(id, maxLevel);
      } catch ( err ) {
        log(`failed to warm spell list for ${id}`, err);
      }
      onTick?.();
    });
  }

  async #resolve(classUuid) {
    const doc = await fromUuid(classUuid);
    const progression = doc?.system?.spellcasting?.progression;
    if ( !doc || !progression || progression === "none" ) return { isSpellcaster: false };

    const classId = doc.system?.identifier ?? doc.name?.toLowerCase() ?? "";
    const maxCantrips = scaleCount(doc, classId, "cantrip", DEFAULT_CANTRIPS);
    const maxSpells = scaleCount(doc, classId, "spell", DEFAULT_LEVEL1_SPELLS);

    const all = deduplicateSpells(await loadSpellsForClass(classId, 1, "class", this.#fetchSpellPool(1)));
    const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
    const cantrips = all.filter(s => s.level === 0).sort(byName);
    const level1 = all.filter(s => s.level === 1).sort(byName);

    log(`spells for "${classId}": ${cantrips.length} cantrips, ${level1.length} lvl-1 ` +
      `(know ${maxCantrips}/${maxSpells})`);
    return { isSpellcaster: true, cantrips, level1, maxCantrips, maxSpells, classId };
  }

  /** Enriched description html for the focused spell, memoised. */
  async description(uuid) {
    return (await this.#detail(uuid)).enriched;
  }

  /**
   * The sourcebook a spell came from (e.g. "Player's Handbook 2024"), for the detail panel's
   * provenance badge — the same one the class, species, background and subclass panels carry.
   * Empty when the spell declares no source.
   *
   * Shares {@link #detail}'s memo with {@link description}, so a focused spell resolves its document
   * once and both readings come off that.
   * @param {string} uuid
   * @returns {Promise<string>}
   */
  async sourceBook(uuid) {
    return (await this.#detail(uuid)).source;
  }

  /** Enriched description + sourcebook for one spell, resolved once and memoised. */
  #detail(uuid) {
    if ( !uuid ) return Promise.resolve({ enriched: "", source: "" });
    if ( !this.#descriptions.has(uuid) ) {
      const promise = (async () => {
        const doc = await fromUuid(uuid);
        const raw = doc?.system?.description?.value ?? "";
        const enriched = raw
          ? await foundry.applications.ux.TextEditor.implementation.enrichHTML(raw, { relativeTo: doc, secrets: false })
          : "";
        // dnd5e prepares `system.source.value` to the book name, falling back to the package title.
        return { enriched, source: doc?.system?.source?.value ?? "" };
      })().catch(err => { this.#descriptions.delete(uuid); throw err; });
      this.#descriptions.set(uuid, promise);
    }
    return this.#descriptions.get(uuid);
  }
}

/* -------------------------------------------- */
/*  Spell-count resolution                      */
/* -------------------------------------------- */

/**
 * The value of a class's cantrips-known / spells-known ScaleValue advancement at a given class
 * `level` (default 1 for creation), falling back to the supplied table when the class carries no
 * such scale. `kind` is "cantrip" (matches titles containing "cantrip") or "spell" (a spells-known
 * scale that is neither a cantrip nor a slot scale).
 */
function scaleCount(doc, classId, kind, fallback, level = 1) {
  for ( const adv of advancementArray(doc) ) {
    if ( (adv.type ?? adv.constructor?.typeName) !== "ScaleValue" ) continue;
    const title = (adv.title ?? adv.configuration?.identifier ?? "").toLowerCase();
    const isCantrip = title.includes("cantrip");
    // Match the scale to the count we want: a "cantrip" scale for cantrips; for spells, a
    // "spells known" scale that is neither the cantrip scale nor a spell-*slot* scale.
    if ( kind === "cantrip" && !isCantrip ) continue;
    if ( kind === "spell" && (isCantrip || !title.includes("spell") || title.includes("slot")) ) continue;
    // A ScaleValue table only carries entries at the levels it changes; take the highest entry
    // at or below the requested level so a mid-tier level reads the last increase, not a gap.
    const scale = adv.configuration?.scale ?? {};
    let val;
    for ( let l = level; l >= 1; l-- ) {
      const entry = scale[l] ?? scale[String(l)];
      if ( entry !== undefined ) { val = entry; break; }
    }
    if ( val !== undefined ) return Number(val.value ?? val) || 0;
  }
  return fallback[classId] ?? 0;
}

/**
 * The number of cantrips a spellcasting class knows at a given class `level`, read from its
 * "Cantrips Known" ScaleValue advancement (the level-up spell step's cantrip capacity). Falls back
 * to the level-1 table only when the class carries no cantrip scale, which no real caster does.
 * @param {Item5e|object} classDoc   The class item or document.
 * @param {number} level             The class's current level.
 * @returns {number}
 */
export function cantripsKnownAtLevel(classDoc, level) {
  const classId = classDoc?.system?.identifier ?? classDoc?.name?.toLowerCase() ?? "";
  return scaleCount(classDoc, classId, "cantrip", DEFAULT_CANTRIPS, level);
}

/* -------------------------------------------- */
/*  Spell-list loading                          */
/* -------------------------------------------- */

/**
 * Whether dnd5e's registry holds a non-empty spell list of this type and identifier.
 * @param {"class"|"subclass"} type
 * @param {string} identifier
 * @returns {boolean}
 */
function registeredList(type, identifier) {
  try {
    return !!dnd5e.registry?.spellLists?.forType?.(type, identifier)?.uuids?.size;
  } catch ( err ) {
    log("spell list registry lookup failed", err);
    return false;
  }
}

/**
 * The spell list a caster actually draws from. A subclass caster usually has a list registered
 * under its own identifier, but one that doesn't borrows a class list instead ({@link
 * SUBCLASS_SPELL_LISTS}, else its parent class's own list — right for a homebrew subclass of a
 * casting class). Falls back to the caster's own key when neither is registered, so the pack-scan
 * fallbacks in {@link loadSpellsForClass} still get their turn.
 * @param {Item5e} doc                   The casting class or subclass document.
 * @param {string} identifier            That document's own identifier.
 * @param {"class"|"subclass"} listType  Registry type of the caster itself.
 * @returns {{ id: string, type: "class"|"subclass" }}
 */
export function spellListFor(doc, identifier, listType) {
  if ( (listType !== "subclass") || registeredList("subclass", identifier) ) {
    return { id: identifier, type: listType };
  }
  const classIdentifier = doc.system?.classIdentifier ?? "";
  for ( const id of [SUBCLASS_SPELL_LISTS[`${classIdentifier}:${identifier}`], classIdentifier] ) {
    if ( id && registeredList("class", id) ) return { id, type: "class" };
  }
  return { id: identifier, type: listType };
}

/**
 * Cantrips and level-1 spells available to a class identifier. Prefers dnd5e's
 * SpellListRegistry, then a legacy spell-list pack scan, then a direct per-spell
 * class-tag scan — whichever first yields the class's spell UUIDs.
 *
 * Note we collect UUIDs from the registry rather than its synchronous `indexes`:
 * those are built via `fromUuidSync` and silently drop spells whose pack index
 * isn't resolvable yet, and they only carry `system.level` for packs that index
 * it — so the level filter would intermittently discard real spells depending on
 * which pack a spell happens to live in. {@link fetchSpellsByUuids} resolves the
 * level reliably instead.
 * @param {Promise<Map<string, object>|null>} [poolPromise]  The caller's shared browser fetch
 *   (see SpellSource##fetchSpellPool), so many classes resolve against one browse.
 */
async function loadSpellsForClass(classId, maxLevel = 1, listType = "class", poolPromise = null) {
  const uuids = new Set();

  try {
    const registry = dnd5e.registry?.spellLists;
    const list = registry?.forType?.(listType, classId);
    if ( list ) for ( const uuid of list.uuids ?? [] ) uuids.add(uuid);
  } catch ( err ) {
    log("spell list registry lookup failed", err);
  }

  if ( !uuids.size ) await scanSpellListPacks(classId, uuids);
  if ( uuids.size ) return fetchSpellsByUuids(uuids, maxLevel, poolPromise);

  return scanSpellsByClassTag(classId, maxLevel);
}

/** Legacy fallback: collect spell UUIDs from any `spellList` item matching the class. */
async function scanSpellListPacks(classId, uuids) {
  const enabled = getEnabledPacks();
  for ( const pack of game.packs ) {
    if ( !isUsableItemPack(pack, enabled) ) continue;
    try {
      const index = await pack.getIndex({ fields: ["type", "system.identifier"] });
      for ( const entry of index ) {
        if ( entry.type !== "spellList" || (entry.system?.identifier ?? "") !== classId ) continue;
        const doc = await pack.getDocument(entry._id);
        collectSpellUuids(doc, uuids);
      }
    } catch ( err ) {
      log(`spell-list pack scan failed for ${pack.collection}`, err);
    }
  }
}

/** Pull spell UUIDs out of a spellList document's `system.spells` collection. */
function collectSpellUuids(doc, uuids) {
  const raw = doc?.system?.spells ?? [];
  const list = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : Object.values(raw ?? {});
  for ( const entry of list ) {
    const uuid = typeof entry === "string" ? entry : entry?.uuid;
    if ( uuid ) uuids.add(uuid);
  }
}

/**
 * Resolve the class's spell UUIDs into level-≤`maxLevel` spell cards. The shared browser pool
 * (one bulk query per max level, reused by every class) supplies reliable `system.level` for
 * every browsable pack; any UUID it doesn't cover (pack not browsable, index not loaded, no
 * browser API) is reconciled with a direct `fromUuid` so the list is complete rather than
 * all-or-nothing.
 * @param {Set<string>} uuids
 * @param {number} [maxLevel=1]
 * @param {Promise<Map<string, object>|null>} [poolPromise]
 */
async function fetchSpellsByUuids(uuids, maxLevel = 1, poolPromise = null) {
  const found = new Map();
  const pool = poolPromise ? await poolPromise : null;
  if ( pool ) {
    for ( const uuid of uuids ) {
      const entry = pool.get(uuid);
      if ( entry ) found.set(uuid, buildSpellFromEntry(entry));
    }
  }
  // Reconcile the misses concurrently (capped) — sequential fromUuid awaits made this loop the
  // slowest part of a cold list load. Order doesn't matter: every caller sorts the result.
  const misses = [...uuids].filter(uuid => !found.has(uuid));
  await forEachLimit(misses, WARM_CONCURRENCY, async uuid => {
    const doc = await fromUuid(uuid).catch(() => null);
    if ( doc?.type === "spell" && (doc.system?.level ?? 99) <= maxLevel ) found.set(uuid, buildSpellFromEntry(doc));
  });
  return [...found.values()];
}

/** Last-resort scan: every level-≤1 spell tagged with the class identifier. */
async function scanSpellsByClassTag(classId, maxLevel = 1) {
  const enabled = getEnabledPacks();
  const out = [];
  const seen = new Set();
  for ( const pack of game.packs ) {
    if ( !isUsableItemPack(pack, enabled) ) continue;
    try {
      const index = await pack.getIndex({ fields: ["type", "system.level"] });
      for ( const entry of index ) {
        if ( entry.type !== "spell" || (entry.system?.level ?? 99) > maxLevel || seen.has(entry._id) ) continue;
        seen.add(entry._id);
        const doc = await pack.getDocument(entry._id);
        if ( !doc ) continue;
        const raw = doc.system?.source?.class ?? doc.system?.classes ?? [];
        const classes = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw
          : typeof raw === "string" ? [raw] : Object.keys(raw ?? {});
        if ( classes.some(c => (c?.identifier ?? c) === classId) ) out.push(buildSpellFromEntry(doc));
      }
    } catch ( err ) {
      log(`direct spell scan failed for ${pack.collection}`, err);
    }
  }
  return out;
}

/**
 * Drop duplicate spells (the same spell appearing in several packs), preferring the 2024
 * Player's Handbook then the system 2024 pack so a world with both shows one entry.
 *
 * Keyed on the spell's name — its true cross-pack identity. Spells carry no
 * `system.identifier`, and spell-list index entries can omit or share `_id`, so the old
 * id-based key silently collapsed (or skipped) genuinely distinct spells, leaving a class
 * like Cleric showing only one. Two spells never legitimately share a name, so name-keying
 * removes real duplicates without dropping anything.
 */
function deduplicateSpells(spells) {
  const PRIORITY = ["Compendium.dnd-players-handbook.spells.", "Compendium.dnd5e.spells24."];
  const rank = uuid => {
    const idx = PRIORITY.findIndex(p => (uuid ?? "").startsWith(p));
    return idx >= 0 ? idx : PRIORITY.length;
  };
  const byKey = new Map();
  for ( const spell of spells ) {
    const key = (spell.name || spell.uuid || "").toLowerCase();
    if ( !key ) continue;
    const existing = byKey.get(key);
    if ( !existing || rank(spell.uuid) < rank(existing.uuid) ) byKey.set(key, spell);
  }
  return [...byKey.values()];
}

/**
 * Casting time as a player reads it — "Action", "1 Minute", "10 Minutes" — from an index entry's
 * `system.activation`, plus the raw type key the filter matches on.
 *
 * A deliberately small mirror of dnd5e's own `ActivationField.prepareData`: that runs on a prepared
 * *document*, and a list of two hundred spells only ever holds index entries. The system's
 * formatters do the work, so an entry reads the same here as on the sheet.
 * @param {object} entry
 * @returns {{key: string, label: string}}
 */
function castingTimeOf(entry) {
  const activation = entry.system?.activation ?? {};
  const key = activation.type ?? "";
  if ( !key ) return { key: "", label: "" };
  const config = CONFIG.DND5E?.activityActivationTypes?.[key];
  const value = activation.value ?? 1;
  // A scalar type ("minute", "hour") reads as a duration and carries a count; everything else
  // ("action", "bonus", "reaction") is a flat label the count would only clutter.
  const label = (key in (CONFIG.DND5E?.timeUnits ?? {}))
    ? (dnd5e.utils?.formatTime?.(value, key) ?? `${value} ${config?.label ?? key}`)
    : (config?.label ?? key);
  return { key, label };
}

/**
 * Range as a player reads it — "60 ft", "Touch", "Self" — from an index entry's `system.range`,
 * plus the raw units key the filter matches on. The companion to {@link castingTimeOf}, mirroring
 * `RangeField.prepareData` for index entries.
 * @param {object} entry
 * @returns {{key: string, label: string}}
 */
function rangeOf(entry) {
  const range = entry.system?.range ?? {};
  const key = range.units ?? "";
  // No units at all is dnd5e's own reading of "Self", which is what its RangeField falls back to.
  if ( !key ) return { key: "self", label: CONFIG.DND5E?.distanceUnits?.self ?? "" };
  const scalar = key in (CONFIG.DND5E?.movementUnits ?? {});
  if ( scalar && range.value ) {
    return { key, label: dnd5e.utils?.formatLength?.(range.value, key) ?? `${range.value} ${key}` };
  }
  return { key, label: scalar ? "" : (CONFIG.DND5E?.distanceUnits?.[key] ?? key) };
}

/** A lightweight spell card from an index entry or full document; description loads on focus. */
export function buildSpellFromEntry(entry) {
  const level = entry.system?.level ?? 0;
  const schoolKey = entry.system?.school ?? "";
  const props = entry.system?.properties;
  const hasProp = p => props instanceof Set ? props.has(p) : Array.isArray(props) ? props.includes(p) : false;
  const casting = castingTimeOf(entry);
  const range = rangeOf(entry);
  return {
    // `||` (not `??`) so an empty identifier falls through to a usable unique id.
    id: entry.system?.identifier || entry._id || entry.id || entry.uuid,
    // The identifier on its own, unfudged — `id` above falls back to a document id, which must never
    // be mistaken for one. This is what {@link module:data/spell-identity.spellKey} matches a pool
    // row against the character's own spells by, so the same spell from two packages reads as one.
    identifier: entry.system?.identifier ?? "",
    uuid: entry.uuid,
    name: entry.name,
    img: entry.img || "icons/svg/daze.svg",
    level,
    school: CONFIG.DND5E?.spellSchools?.[schoolKey]?.label ?? schoolKey,
    components: [hasProp("vocal") && "V", hasProp("somatic") && "S", hasProp("material") && "M"]
      .filter(Boolean).join(", "),
    isConcentration: hasProp("concentration"),
    isRitual: hasProp("ritual"),
    // Every property the spell carries, space-joined, as the property filter's haystack. Kept raw
    // (`vocal`, `concentration`) rather than localised: it is matched against a filter value built
    // from the same CONFIG keys, and a translated string would break that on any non-English world.
    propertyKeys: [...(props instanceof Set ? props : Array.isArray(props) ? props : [])].join(" "),
    // Both of these come from index fields SPELL_INDEX_FIELDS has always requested. They back the
    // casting-time and range filters, and the meta line each row shows.
    castingTimeKey: casting.key,
    castingTime: casting.label,
    rangeKey: range.key,
    range: range.label
  };
}

/**
 * The filter dropdown options for a rendered spell list — level, school, property, casting time and
 * range — derived from the spells actually in the list, so a dropdown only ever offers values that
 * can match something.
 *
 * Built here rather than in either step because both steps want exactly the same five, and the
 * shapes they read (`school`, `castingTime`, `propertyKeys`) are this module's own card fields.
 *
 * The property list is the one set that isn't derived from the rows: it comes from
 * `CONFIG.DND5E.validProperties.spell`, so dnd5e supplies both the keys and their labels and a
 * sixth spell property would appear here for free. Each one yields two options — "only" and
 * "without" — which is how a single select covers both directions of a question a player actually
 * asks ("just the rituals", "nothing that needs concentration").
 *
 * @param {object[]} list                  The decorated rows about to be rendered.
 * @param {(key: string, data?: object) => string} translate  The module's `t()`, passed in so this
 *   stays free of the config import cycle and testable without i18n.
 * @returns {{levelOptions: object[], schoolOptions: object[], castingOptions: object[],
 *   rangeOptions: object[], propertyGroups: {label: string, options: object[]}[]}}
 */
export function spellFilterOptions(list, translate) {
  const lang = game.i18n?.lang;
  const byLabel = (a, b) => a.label.localeCompare(b.label, lang);

  // Only meaningful on a leveled tab — cantrips are all level 0 — but harmless to build either way:
  // the template decides whether to render the control.
  const levelOptions = [...new Set(list.filter(s => s.level > 0).map(s => s.level))]
    .sort((a, b) => a - b)
    .map(level => ({ value: level, label: translate("levelup.step.spells.levelTag", { level }) }));

  // The keys present in the list, labelled from CONFIG rather than from the first row that carried
  // them. The row labels are per-spell — "1 Minute" and "10 Minutes" share the key `minute`, "60 ft"
  // and "120 ft" share `ft` — so using one would put an arbitrary spell's wording on a filter that
  // matches all of them. The key's own name is what the option means.
  const distinct = (key, labels) => {
    const seen = new Set(list.map(s => s[key]).filter(Boolean));
    return [...seen]
      .map(value => ({ value, label: labels?.[value]?.label ?? labels?.[value] ?? value }))
      .sort(byLabel);
  };

  // Two <optgroup>s rather than a flat list: the same keys appear twice, once each way round, and
  // the headings are what stop that reading as a duplicated menu.
  const valid = CONFIG.DND5E?.validProperties?.spell ?? new Set();
  const present = new Set(list.flatMap(s => (s.propertyKeys ?? "").split(" ").filter(Boolean)));
  const propertyGroups = [
    { want: "yes", labelKey: "levelup.step.spells.filterPropOnly", groupKey: "levelup.step.spells.filterPropGroupOnly" },
    { want: "no", labelKey: "levelup.step.spells.filterPropWithout", groupKey: "levelup.step.spells.filterPropGroupWithout" }
  ].map(({ want, labelKey, groupKey }) => ({
    label: translate(groupKey),
    options: [...valid]
      // A property no spell in the list carries would filter to nothing ("only") or to everything
      // ("without"); neither is worth a row in the menu.
      .filter(key => present.has(key))
      .map(key => ({
        value: `${key}:${want}`,
        label: translate(labelKey, { property: CONFIG.DND5E?.itemProperties?.[key]?.label ?? key })
      }))
      .sort(byLabel)
  })).filter(group => group.options.length);

  // Schools are already localised labels on the card (there is no key to look up), so they are the
  // one axis whose values *are* their labels.
  const schools = [...new Set(list.map(s => s.school).filter(Boolean))]
    .map(school => ({ value: school, label: school })).sort(byLabel);

  return {
    levelOptions,
    schoolOptions: schools,
    propertyGroups,
    // Sorted by label, not by the underlying key, so the menu reads in the order a player scans it
    // rather than in CONFIG order.
    castingOptions: distinct("castingTimeKey", CONFIG.DND5E?.activityActivationTypes),
    rangeOptions: distinct("rangeKey", CONFIG.DND5E?.distanceUnits)
  };
}

/**
 * The spell casting `method` a class's spells should use, from its spellcasting progression:
 * "pact" for a Warlock (Pact Magic slots), "spell" for full/half/third-caster classes. Falls back
 * to "spell" for anything unrecognised. Shared by the creation spell grant and the level-up one, so
 * a Warlock's spells land in the pact section either way.
 * @param {Item5e|object|null} classDoc
 * @returns {string}
 */
export function spellMethodFor(classDoc) {
  const progression = classDoc?.system?.spellcasting?.progression;
  return CONFIG.DND5E?.spellProgression?.[progression]?.type || "spell";
}
