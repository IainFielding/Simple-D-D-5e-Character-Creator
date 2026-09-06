import { log } from "../config.mjs";
import { advancementArray, appliesToClass } from "./advancement-util.mjs";
import { forEachLimit, WARM_CONCURRENCY } from "./concurrency.mjs";
import { dedupeCards as dedupe } from "./dedupe.mjs";

/**
 * Reads the available origin items (classes, species, backgrounds) out of the
 * enabled compendiums, honouring the dnd5e Compendium Browser's own source
 * configuration. Produces lightweight "card" records for the grids and lazily
 * resolves full documents (with enriched descriptions) when a card is opened.
 *
 * One instance is created per builder session and loaded once.
 *
 * For a junior dev, two ideas run through this file:
 *   - "card" vs full document: a card is a tiny {uuid, name, img, identifier} record — cheap to
 *     list hundreds of in a grid. The full document (its description, advancements, etc.) is only
 *     loaded via fromUuid() when the player actually opens that card. A UUID is Foundry's global
 *     address for a document; fromUuid(uuid) fetches it (async), fromUuidSync(uuid) if already cached.
 *   - memoisation: the private #maps below cache each expensive resolution by UUID, so re-opening a
 *     card, or the warm-up touching it twice, never repeats the work. (Fields prefixed with # are
 *     JavaScript private fields — only reachable inside this class.)
 * "Advancement" is a dnd5e term: the rules an item applies as you gain it/level up (grant a feature,
 * a proficiency, an ability increase, etc.). Much of this module is about reading those.
 */
/**
 * Class identifiers that belong to Tasha's Cauldron sidekick classes. Sidekicks are DM-run
 * companion statblocks, not player options — they're published as real `class` items (in
 * `dnd-tashas-cauldron`'s `tcoe-character-options` pack, alongside the genuinely playable
 * Artificer), so nothing in the data distinguishes them and they'd otherwise show up in the
 * class grid. Matched on `system.identifier`, so any module republishing the same sidekicks
 * is caught too.
 */
const SIDEKICK_IDENTIFIERS = new Set(["expert", "warrior", "healer", "mage", "prodigy"]);

/**
 * Whether a card belongs in a grid scoped to one rules edition.
 *
 * A world can hold both editions side by side — the system still ships the 2014 classes, species and
 * backgrounds beside the 2024 ones — and mixing them builds a character neither edition describes:
 * a 2014 class advances on a different schedule than the 2024 content assumes.
 *
 * Content that declares **no** edition matches everything. Homebrew and third-party packs frequently
 * leave `source.rules` unset, and hiding those from every grid would be a far worse failure than
 * showing them in both.
 * @param {string|null} cardRules   The card's normalised edition, or null.
 * @param {string|null} want        The edition to scope to, or null for "no scoping".
 * @returns {boolean}
 */
export function matchesRules(cardRules, want) {
  if ( !want || !cardRules ) return true;
  return String(cardRules) === String(want);
}

/**
 * Package id -> `"system"` | `"module"` | `"world"`, built once from the live compendium list.
 *
 * {@link module:data/dedupe.rankPackage} asks this for every duplicate it weighs, and `dedupeCards`
 * runs over every card in the index, so the walk over `game.packs` is memoised rather than repeated
 * per comparison. Cleared by `invalidateSources()` alongside the other enabled-pack memos, since
 * enabling or disabling a module changes the answer.
 * @type {Map<string, string>|null}
 */
let packageTypes = null;

/** The injected lookup {@link module:data/dedupe} needs; null for a package no enabled pack claims. */
function packageTypeOf(packageId) {
  if ( !packageTypes ) {
    packageTypes = new Map();
    for ( const pack of game.packs ?? [] ) {
      const name = pack.metadata?.packageName ?? pack.collection?.split(".")[0];
      if ( name && !packageTypes.has(name) ) packageTypes.set(name, pack.metadata?.packageType ?? null);
    }
  }
  return packageTypes.get(packageId) ?? null;
}

/** Forget the memoised package types — see {@link packageTypes}. */
export function resetPackageTypes() {
  packageTypes = null;
}

/** {@link module:data/dedupe.dedupeCards} bound to this world's package types. */
const dedupeCards = cards => dedupe(cards, packageTypeOf);

export class SourceIndex {

  /** type id -> card[]. Note dnd5e's item type for "species" is historically "race". */
  #cards = { class: [], race: [], background: [] };

  // Every memo below stores the in-flight *promise*, not the resolved value, so concurrent
  // callers (the ready warm-up, a level-up window's background warm, and the step that finally
  // renders) share a single load instead of racing duplicates. A failed load un-caches itself
  // so a later call can retry.

  /** uuid -> promise of { name, img, enriched } resolved detail, memoised. */
  #details = new Map();

  /** uuid -> promise of ability-score-improvement config (or null), memoised. */
  #asi = new Map();

  /** uuid -> promise of categorized advancement groups (or null), memoised. */
  #groups = new Map();

  /** granted-item uuid -> promise of { name, img, type } metadata (or null), memoised. */
  #meta = new Map();

  /** Promise of all indexed subclass cards (across classes), fetched once on first request. */
  #subclasses = null;

  loaded = false;

  /**
   * Index every origin type. `onStep` is invoked with a human label before each
   * type so the shell can show progress.
   * @param {(label: string) => Promise<void>|void} [onStep]
   */
  async load(onStep) {
    for ( const type of ["class", "race", "background"] ) {
      await onStep?.(type);
      this.#cards[type] = await this.#index(type);
    }
    this.loaded = true;
    log(`indexed ${this.#cards.class.length} classes, ${this.#cards.race.length} species, ` +
      `${this.#cards.background.length} backgrounds`);
  }

  /**
   * Eagerly resolve every indexed card's detail panel, advancement groups, and ability
   * increase so opening (or switching to) a card later is instant rather than paying a
   * cold `fromUuid`/`enrichHTML` round-trip per click. Each resolved document also stays
   * in Foundry's compendium cache, which warms the choice resolver's `fromUuid` lookups
   * too. Memoised maps absorb the work, so this is safe to call once after {@link load}.
   * Cards are warmed in concurrent batches so their compendium reads overlap, and the
   * document is resolved once per card and shared across the three resolvers (rather than
   * each re-fetching it). Failures on a single card are swallowed so one bad document
   * can't abort the warm-up.
   * @param {() => void} [onTick]  Invoked once per card warmed, for progress reporting.
   */
  async warmAll(onTick) {
    const cards = [...this.#cards.class, ...this.#cards.race, ...this.#cards.background];
    await forEachLimit(cards, WARM_CONCURRENCY, async card => {
      try {
        const doc = await fromUuid(card.uuid);
        await this.detail(card.uuid, doc);
        await this.advancementGroups(card.uuid, doc);
        await this.abilityScoreIncrease(card.uuid, doc);
      } catch ( err ) {
        log(`failed to warm ${card.uuid}`, err);
      }
      onTick?.();
    });
  }

  classes() { return this.#cards.class; }

  /**
   * Species and background cards, optionally scoped to one rules edition.
   *
   * The creation wizard picks the class first, so by the time these grids render the character's
   * edition is known — and a 2014 class should not be offered the 2024 origins. Classes themselves
   * are never scoped: the class *is* the choice that sets the edition.
   * @param {object} [options]
   * @param {string|number|null} [options.rules]   Edition to scope to; unset returns everything.
   */
  species({ rules = null } = {}) {
    return this.#cards.race.filter(c => matchesRules(c.rules, rules));
  }

  backgrounds({ rules = null } = {}) {
    return this.#cards.background.filter(c => matchesRules(c.rules, rules));
  }

  /** The rules edition of a card, by uuid — how a step learns the chosen class's edition. */
  rulesOf(uuid) {
    return this.card(uuid)?.rules ?? null;
  }

  /**
   * The subclass cards belonging to one class, by its identifier. Fetched (and cached) lazily on
   * first request — independent of {@link load}, so the level-up flow can use it without warming
   * the full origin index. {@link detail} and {@link advancementGroups} work on these UUIDs too.
   *
   * **Scoped to the class's own rules edition.** A world can hold both editions of a class — the
   * system still ships the 2014 classes alongside the 2024 ones — and they share an identifier, so
   * matching on identifier alone offers a 2014 Cleric the 2024 domains and vice versa. They are not
   * interchangeable: a 2024 subclass grants its features at the levels the 2024 class advances on,
   * so pairing it with the 2014 progression produces a character neither edition describes.
   *
   * Content that declares no edition is offered to both, which is the right default for homebrew and
   * for third-party packs that never set `source.rules`.
   * @param {string} classIdentifier
   * @param {object} [options]
   * @param {string|number|null} [options.rules]   The class's `system.source.rules`; unset offers all.
   * @returns {Promise<object[]>}
   */
  async subclasses(classIdentifier, { rules = null } = {}) {
    if ( !this.#subclasses ) {
      this.#subclasses = this.#fetchSubclasses()
        .catch(err => { this.#subclasses = null; throw err; });
    }
    return (await this.#subclasses)
      .filter(c => c.classIdentifier === classIdentifier)
      .filter(c => matchesRules(c.rules, rules))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  }

  /** The world-wide subclass fetch behind {@link subclasses}: one browse, cached as cards. */
  async #fetchSubclasses() {
    const browser = dnd5e.applications?.CompendiumBrowser;
    let entries = [];
    if ( browser?.fetch ) {
      try {
        entries = await browser.fetch(Item, {
          types: new Set(["subclass"]),
          // The parent object, not `system.source.rules`. dnd5e 6.0.0 indexes `system.source`
          // itself, and Foundry builds the projection with `setProperty(spec, field, 1)` — so a
          // request for a sub-path of an already-indexed field tries to create a key on the
          // number 1 and throws for every pack. Asking for the parent reads the same on 5.3.x.
          indexFields: new Set(["system.classIdentifier", "system.source"])
        });
      } catch ( err ) {
        log("Compendium Browser fetch failed for subclasses, scanning packs directly", err);
      }
    }
    if ( !entries.length ) entries = await this.#scanPacks("subclass");
    return dedupeCards(entries.map(e => ({
      uuid: e.uuid,
      name: e.name,
      img: e.img || "icons/svg/item-bag.svg",
      classIdentifier: e.system?.classIdentifier ?? "",
      // Normalised to a string (packs store it as `'2014'`, but a number is legal) and left null
      // when absent, which {@link subclasses} treats as "offer to either edition".
      rules: e.system?.source?.rules != null ? String(e.system.source.rules) : null
    })));
  }

  /** Look up a single card across all types by its UUID. */
  card(uuid) {
    if ( !uuid ) return null;
    for ( const list of Object.values(this.#cards) ) {
      const hit = list.find(c => c.uuid === uuid);
      if ( hit ) return hit;
    }
    return null;
  }

  /* -------------------------------------------- */

  // Two ways to discover content: ask dnd5e's Compendium Browser (which already applies the world's
  // source filtering for us), or, if that API isn't there, scan the packs by hand. Every #index and
  // subclasses() call tries the browser first and falls back to #scanPacks.

  /**
   * Fetch the index for one document subtype via the dnd5e Compendium Browser,
   * which already filters by the world's enabled sources. Falls back to a direct
   * pack scan if the browser API is unavailable.
   * @param {string} type
   * @returns {Promise<object[]>}
   */
  async #index(type) {
    const browser = dnd5e.applications?.CompendiumBrowser;
    let entries = [];
    if ( browser?.fetch ) {
      try {
        entries = await browser.fetch(Item, {
          types: new Set([type]),
          indexFields: new Set(["system.identifier", "system.source"])
        });
      } catch ( err ) {
        log(`Compendium Browser fetch failed for "${type}", scanning packs directly`, err);
      }
    }
    if ( !entries.length ) entries = await this.#scanPacks(type);
    const cards = entries.map(e => this.#toCard(e));
    const offered = type === "class" ? cards.filter(c => !SIDEKICK_IDENTIFIERS.has(c.identifier)) : cards;
    return dedupeCards(offered);
  }

  /** Direct fallback scan when the Compendium Browser is unavailable. */
  async #scanPacks(type) {
    const out = [];
    for ( const pack of game.packs ) {
      if ( pack.metadata.type !== "Item" ) continue;
      try {
        const index = await pack.getIndex({
          fields: ["type", "system.identifier", "system.classIdentifier", "system.source"]
        });
        for ( const e of index ) if ( e.type === type ) out.push(e);
      } catch ( err ) {
        log(`pack scan failed for ${pack.collection}`, err);
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return out;
  }

  /** Map a raw index entry to the minimal shape the grids consume. */
  #toCard(entry) {
    return {
      uuid: entry.uuid,
      name: entry.name,
      img: entry.img || "icons/svg/item-bag.svg",
      identifier: entry.system?.identifier ?? "",
      // Normalised to a string (packs store `'2014'`, but a number is legal) and null when the
      // content declares nothing — see {@link matchesRules}.
      rules: entry.system?.source?.rules != null ? String(entry.system.source.rules) : null
    };
  }

  /**
   * Resolve the full document for a card and return its enriched description for
   * the detail panel. Memoised so repeated expand/collapse is cheap.
   * @param {string} uuid
   * @param {object} [doc]  Pre-resolved document, to skip a redundant `fromUuid` during warm-up.
   * @returns {Promise<{name: string, img: string, enriched: string, source: string}|null>}
   */
  async detail(uuid, doc) {
    if ( !uuid ) return null;
    if ( !this.#details.has(uuid) ) {
      const promise = this.#resolveDetail(uuid, doc)
        .catch(err => { this.#details.delete(uuid); throw err; });
      this.#details.set(uuid, promise);
    }
    return this.#details.get(uuid);
  }

  async #resolveDetail(uuid, doc) {
    doc ??= await fromUuid(uuid);
    if ( !doc ) return null;

    // Work on a clone, never the cached compendium document. `enrichHTML` prepares whatever it is
    // handed as `relativeTo`, and dnd5e's `SourceField.prepareData` back-fills an empty
    // `system.source.book` from the pack's `flags.dnd5e.sourceBook` when it does — writing a
    // *derived* value into shared state we do not own. Measured: enriching the cached document
    // flips `book` from "" to "SRD 5.2"; enriching a clone does not. `keepId` preserves the uuid,
    // so relative links inside the description still resolve.
    //
    // Hygiene, not a bug fix. This is **not** what puts `source.book` on a built character — a
    // full sweep with this in place reported the same rows. The warm's own writes are transient
    // (`warmAll`'s document load replaces the polluted cache entries), so the write that reaches
    // the actor happens during the build itself and is still open. Do not read this comment as
    // having closed that.
    const safe = doc.clone({}, { keepId: true });

    const raw = safe.system?.description?.value ?? "";
    const enriched = await foundry.applications.ux.TextEditor.implementation.enrichHTML(raw, {
      relativeTo: safe, secrets: false
    });
    // The originating sourcebook (e.g. "Player's Handbook 2024"), for a source badge in the UI.
    // dnd5e prepares `system.source.value` to the book name (falling back to the package title);
    // empty when the item declares no source.
    const source = safe.system?.source?.value ?? "";
    return { name: safe.name, img: safe.img, enriched, source };
  }

  /**
   * Resolve an origin item's level-0 Ability Score Improvement advancement into a plain config the
   * Species and Background steps use to drive their increase panel. Returns null when the item
   * grants no increase at all. Memoised per UUID.
   *
   * @param {string} uuid
   * @param {object} [doc]  Pre-resolved document, to skip a redundant `fromUuid` during warm-up.
   * @returns {Promise<{id: string, points: number, canAllocate: boolean, cap: number,
   *   fixed: Record<string, number>, locked: string[]}|null>}
   */
  async abilityScoreIncrease(uuid, doc) {
    if ( !uuid ) return null;
    if ( !this.#asi.has(uuid) ) {
      const promise = (async () => {
        doc ??= await fromUuid(uuid);
        return doc ? readAsi(doc) : null;
      })().catch(err => { this.#asi.delete(uuid); throw err; });
      this.#asi.set(uuid, promise);
    }
    return this.#asi.get(uuid);
  }

  /**
   * Resolve an origin item's advancements into the display blocks shown beneath its
   * description: a "Traits" block of proficiency/score tags, then "Features" and
   * "Spells" blocks of granted items (each with its icon, a clickable content-link,
   * and a level tag). Blocks with no content are omitted. Memoised per UUID.
   *
   * @param {string} uuid
   * @param {object} [doc]  Pre-resolved document, to skip a redundant `fromUuid` during warm-up.
   * @returns {Promise<object[]|null>}
   */
  async advancementGroups(uuid, doc) {
    if ( !uuid ) return null;
    if ( !this.#groups.has(uuid) ) {
      const promise = (async () => {
        doc ??= await fromUuid(uuid);
        return doc ? await this.#buildGroups(doc) : null;
      })().catch(err => { this.#groups.delete(uuid); throw err; });
      this.#groups.set(uuid, promise);
    }
    return this.#groups.get(uuid);
  }

  /** Walk an item's level-1 traits and every granted feature/spell into display blocks. */
  async #buildGroups(doc) {
    // Headings read from the step namespace matching the document type, so a class shows
    // "Class Traits" while a species/background shows its own wording; everything else
    // (trait sub-labels, the level tag) is generic and stays under step.class.
    const ns = { class: "step.class", race: "step.species", background: "step.background" }[doc.type]
      ?? "step.class";
    const head = key => game.i18n.localize(`sogrom-dnd5e-character-creator.${key}`);
    const traits = { key: "traits", order: 1, heading: head(`${ns}.traits`), tags: [], items: [] };
    const features = { key: "features", order: 2, heading: head(`${ns}.features`), tags: [], items: [] };
    const spells = { key: "spells", order: 3, heading: head(`${ns}.spells`), tags: [], items: [] };

    // Lead the Traits block with the class's headline numbers, like the PHB core table.
    // primaryAbility.value is a Set on the prepared model, so normalise via Array.from;
    // fall back to the raw source array in case the prepared field comes back empty.
    const sys = doc.system ?? {};
    const primaryRaw = sys.primaryAbility?.value ?? doc._source?.system?.primaryAbility?.value ?? [];
    const primary = Array.from(primaryRaw).map(a => CONFIG.DND5E.abilities?.[a]?.label ?? a);
    if ( primary.length ) traits.tags.push({ label: head("step.class.trait.primary"), value: primary.join(", ") });
    if ( sys.hd?.denomination ) traits.tags.push({ label: head("step.class.trait.hitDie"), value: sys.hd.denomination });

    for ( const adv of advancementArray(doc) ) {
      const type = adv.type ?? adv.constructor?.typeName;
      const level = Number(adv.level ?? adv._source?.level ?? 0);

      // The class summary table already lists higher-level proficiency grants; only the
      // level-1 traits describe what the class opens with. Skip multiclass-only entries.
      if ( type === "Trait" ) {
        if ( level > 1 || !appliesToClass(adv, doc) ) continue;
        traits.tags.push(...traitTags(adv));
        continue;
      }

      if ( type === "ItemGrant" ) {
        for ( const ref of adv.configuration?.items ?? [] ) {
          const meta = await this.#resolveMeta(ref.uuid ?? ref);
          if ( !meta ) continue;
          const bucket = meta.type === "spell" ? spells : features;
          bucket.items.push({ name: meta.name, img: meta.img, uuid: meta.uuid, level });
        }
      }
    }

    // Order each list by level then name; drop duplicate grants (same item at same level).
    for ( const block of [features, spells] ) {
      const seen = new Set();
      block.items = block.items
        .sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name, game.i18n.lang))
        .filter(i => { const k = `${i.uuid}:${i.level}`; return seen.has(k) ? false : seen.add(k); });
    }

    return [traits, features, spells]
      .filter(b => b.tags.length || b.items.length)
      .sort((a, b) => a.order - b.order);
  }

  /** Resolve a granted item's UUID to the metadata a feature row needs, memoised.
   *  The row carries the resolved document's *canonical* uuid (`doc.uuid`), not the
   *  raw grant reference: some packs (notably 2024 backgrounds) store legacy
   *  compendium uuids missing the `.Item.` segment, which `fromUuidSync` still
   *  resolves but the async `fromUuid` dnd5e's tooltip handler calls does not — so
   *  feeding the raw form to `data-uuid` leaves the hover tooltip permanently blank. */
  async #resolveMeta(uuid) {
    if ( !uuid ) return null;
    if ( !this.#meta.has(uuid) ) {
      const promise = (async () => {
        // Sync first (the pack is usually already cached), falling back to the async fetch — which
        // is also the only thing the old catch branch could do, so it duplicated this line rather
        // than adding a recovery path.
        const doc = fromUuidSync(uuid) ?? await fromUuid(uuid);
        if ( !doc ) return null;
        return { uuid: doc.uuid, name: doc.name, img: doc.img || "icons/svg/item-bag.svg", type: doc.type };
      })().catch(err => {
        // Un-cache so a transient failure isn't remembered for the session, but still resolve
        // `null` rather than rejecting: this memo's caller ({@link #buildGroups}) skips a row it
        // can't resolve, and the row's own failure must not take the whole advancement panel — and
        // so the class step's render — down with it.
        this.#meta.delete(uuid);
        log(`failed to resolve granted item ${uuid}`, err);
        return null;
      });
      this.#meta.set(uuid, promise);
    }
    return this.#meta.get(uuid);
  }
}

/** Trait categories surfaced in the class "Traits" block, mapped to their i18n keys. */
const TRAIT_LABELS = {
  saves: "step.class.trait.saves", skills: "step.class.trait.skills",
  weapon: "step.class.trait.weapon", armor: "step.class.trait.armor",
  tool: "step.class.trait.tool", languages: "step.class.trait.languages"
};
const traitLabel = type => game.i18n.localize(`sogrom-dnd5e-character-creator.${TRAIT_LABELS[type]}`);

/**
 * Flatten one Trait advancement into `{ label, value }` tags. Fixed `grants` become a
 * single comma-joined tag per category; a `choices` pool becomes a "Skills (2)"-style
 * tag listing the options. Categories outside {@link TRAIT_LABELS} (e.g. damage
 * resistances rarely seen on classes) are ignored.
 * @param {object} adv  A Trait advancement (prepared instance or raw data)
 * @returns {{label: string, value: string}[]}
 */
function traitTags(adv) {
  const out = [];
  const byType = key => key.split(":")[0];
  const label = key => dnd5e.documents.Trait?.keyLabel?.(key) ?? key;

  const grants = {};
  for ( const g of adv.configuration?.grants ?? [] ) {
    const type = byType(g);
    if ( !TRAIT_LABELS[type] ) continue;
    (grants[type] ??= []).push(label(g));
  }
  for ( const [type, values] of Object.entries(grants) ) {
    out.push({ label: traitLabel(type), value: values.join(", ") });
  }

  for ( const choice of adv.configuration?.choices ?? [] ) {
    const pool = choice.pool ?? [];
    const type = pool.length ? byType(pool[0]) : null;
    if ( !type || !TRAIT_LABELS[type] ) continue;
    const options = pool.map(g => g.endsWith(":*") ? game.i18n.localize("DND5E.Any") : label(g));
    const count = choice.count ? ` (${choice.count})` : "";
    out.push({ label: `${traitLabel(type)}${count}`, value: options.join(", ") });
  }
  return out;
}

/**
 * Pull the AbilityScoreImprovement advancement (preferring the level-0 one) off a
 * resolved origin document and flatten its configuration. Kept free of any state
 * or UI concern — just data extraction.
 *
 * Both shapes the origin packs use are returned. A 2024 background spends a point budget
 * (`points: 3, cap: 2`) with nothing fixed; a 2014 species usually fixes its increase outright
 * (Hill Dwarf's `+2 CON, +1 WIS`) with no budget at all, and the Half-Elf does both. Only an
 * advancement that raises nothing — no budget *and* no non-zero fixed entry — is dropped, so the
 * panel can show a fixed increase read-only rather than leaving the player to discover it on Review.
 */
function readAsi(doc) {
  const byType = doc.advancement?.byType?.AbilityScoreImprovement;
  let adv = byType?.length ? (byType.find(a => (a.level ?? 0) === 0) ?? byType[0]) : null;
  if ( !adv ) {
    const raw = Object.values(doc.system?.advancement ?? {});
    adv = raw.find(a => a.type === "AbilityScoreImprovement" && (a.level ?? 0) === 0)
      ?? raw.find(a => a.type === "AbilityScoreImprovement");
  }
  if ( !adv ) return null;

  const config = adv.configuration ?? {};
  const points = Math.max(0, Number(config.points ?? 0));
  const fixed = { ...(config.fixed ?? {}) };
  const anyFixed = Object.values(fixed).some(v => Number(v) > 0);
  if ( !points && !anyFixed ) return null;
  return {
    id: adv.id ?? adv._id,
    points,
    // Whether there is anything for the player to *decide*. False for a purely fixed increase,
    // which the panel renders read-only.
    canAllocate: points > 0,
    cap: Number(config.cap ?? 2),
    fixed,
    locked: [...(config.locked ?? [])]
  };
}
