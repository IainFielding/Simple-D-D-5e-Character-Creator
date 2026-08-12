import { t, log } from "../config.mjs";
import { advancementArray } from "./advancement-util.mjs";
import { matchesRules } from "./source-index.mjs";
import { getEnabledPacks, isUsableItemPack } from "./compendium-util.mjs";
import { toolCategoryKey, toolChoices } from "./tool-source.mjs";
import { phbWeaponIcon } from "./weapon-source.mjs";
import { bg3TraitIcon } from "./bg3-icons.mjs";
import { forEachLimit, WARM_CONCURRENCY } from "./concurrency.mjs";

/**
 * Resolves the player-facing advancement *choices* a set of origin items presents at
 * level ≤ 1 — skill/tool/language/weapon proficiency picks (with cross-source dedupe),
 * Expertise, Size, ItemChoice (choose N features), spellcasting-ability picks — into
 * flat descriptors the Choices step renders and the assembler applies.
 *
 * Stateless by design: it reads the selected origins and the player's recorded picks
 * (`state.advChoices`) and returns fresh requirements every call, so the step and the
 * build path share one source of truth with no cache to fall stale. It prunes picks
 * that another source now grants outright, mutating `state.advChoices` in place.
 *
 * ── For a junior dev: how to read this file ──
 * A dnd5e item (a class, species, background, or a feature it grants) carries "advancements":
 * typed rules like ItemGrant (give this item), Trait (give/choose a proficiency), ItemChoice
 * (choose N features), Size, and AbilityScoreImprovement. Some are automatic; some ask the player
 * to choose. This module turns the choice-bearing ones into "requirements" — plain, UI-agnostic
 * descriptors ({ title, options, count, complete, selKey, ... }) that the Choices step renders and
 * the assembler later applies. The pipeline top to bottom:
 *   resolveChoices(state)        entry point — loops the three origins
 *     └ prepareRequirements(doc) gathers the origin + its granted features (levelOneOwners)
 *         └ parseAdvancementChoice(adv)  one advancement -> zero or more requirements (by adv.type)
 *             └ buildChoiceReq(...)      assembles one requirement + merges the player's current picks
 * "selKey" is the stable id under which a requirement's picks are stored in state.advChoices.
 * "cross-source dedupe" = if two origins offer the same skill, picking it in one greys it out in the other.
 */

const ORIGIN_FIELDS = {
  class: "classUuid", background: "backgroundUuid", species: "speciesUuid"
};

/** Trait categories we surface, mapped to their i18n title keys. */
const TRAIT_TITLE = {
  ci: "traitChoice.ci", di: "traitChoice.di", dr: "traitChoice.dr",
  languages: "traitChoice.languages", weapon: "traitChoice.weapon",
  armor: "traitChoice.armor", saves: "traitChoice.saves",
  skills: "traitChoice.skills", tool: "traitChoice.tool"
};

/**
 * Memo for compendium scans backing `allowDrops` restrictions, keyed by restriction signature.
 *
 * Derived from the *enabled* pack set ({@link findRestrictedItems} skips anything the world's source
 * configuration switches off), so it is only valid while that set holds — see
 * {@link resetRestrictedCache}.
 */
const restrictedCache = new Map();

/**
 * Drop the `allowDrops` scan memo. Called from `invalidateSources()` when the world's enabled-source
 * set changes: this cache is built by scanning the enabled packs, so a GM switching one off must not
 * keep being offered its content (a disabled 2014 SRD's invocations reaching a 2024 Warlock) for the
 * rest of the session.
 */
export function resetRestrictedCache() {
  restrictedCache.clear();
}

/* -------------------------------------------- */
/*  Entry points                                */
/* -------------------------------------------- */

/**
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {import("./source-index.mjs").SourceIndex} source
 * @returns {Promise<{sources: object[], hasAny: boolean}>}
 */
export async function resolveChoices(state, source) {
  const defs = [];
  for ( const [key, field] of Object.entries(ORIGIN_FIELDS) ) {
    const uuid = state[field];
    defs.push({ key, uuid, doc: uuid ? await fromUuid(uuid).catch(() => null) : null });
  }

  // Walk each origin's level-≤1 owner tree ONCE and hang it off the def. Three consumers below need
  // it (the cross-source trait dedupe, the owned-identifier set, and the per-source requirement
  // build); the walk recursively resolves every granted/picked feature, so doing it per consumer
  // tripled the compendium reads behind every click. `sel` is the source's pick bucket, created
  // here because the requirement build writes pruned picks back into it.
  for ( const d of defs ) {
    if ( !d.doc ) continue;
    d.sel = state.advChoices[d.key] ?? (state.advChoices[d.key] = {});
    d.owners = await levelOneOwners(d.doc, d.sel);
  }

  // Acquired trait keys across every source, so each selector can grey out a proficiency
  // or language already granted/chosen elsewhere. Computed before the per-source loop.
  const crossTaken = collectTakenTraitKeys(defs);

  // Feat/feature identifiers the whole build grants. A feat or invocation whose selection is
  // gated behind an item prerequisite (a Warlock invocation needing Pact of the Blade, say) is
  // hidden when the build doesn't satisfy it, and promoted to a "recommended" panel when it does.
  const ownedIds = collectOwnedIdentifiers(defs);

  // The chosen class's spellcasting ability (and its display name). When a *granted* spell
  // from any origin (species/background) lets the player pick which ability casts it, the
  // class's ability is the recommended pick — so they can align innate casting with the
  // class. Computed once and shared across every source.
  const classDef = defs.find(d => d.key === "class");
  const classAbility = classDef?.doc?.system?.spellcasting?.ability || null;
  const spellAbilityHint = classAbility
    ? { ability: classAbility, className: source.card(classDef.uuid)?.name ?? classDef.doc.name }
    : null;

  // Everything computed across the whole build rather than per source. Expertise belongs here for
  // the same reason the two above do: the rules scope it to the character, not to the class that
  // offers it, so a skill from the species or background is a legitimate pick.
  const shared = {
    crossTaken, spellAbilityHint, ownedIds,
    // The build's rules edition, set by the chosen class — the same scoping the origin grids use,
    // needed here for pools that are scanned from the packs rather than authored on an advancement.
    rules: classDef?.doc?.system?.source?.rules ?? null,
    expertiseSkillPool: proficientSkillKeys(defs),
    // The index itself, for the one requirement whose options are documents rather than keys: a
    // level-1 Subclass choice needs the subclass cards, and `SourceIndex.subclasses()` memoises
    // that scan for the whole session.
    index: source
  };

  const sources = [];
  for ( const d of defs ) {
    if ( !d.doc ) continue;
    let requirements = [];
    try {
      requirements = await prepareRequirements(d, shared);
    } catch ( err ) {
      log(`failed to resolve choices for ${d.key}`, err);
    }
    if ( requirements.length ) {
      const card = source.card(d.uuid);
      sources.push({
        key: d.key,
        name: card?.name ?? d.doc.name,
        img: card?.img ?? d.doc.img,
        requirements
      });
    }
  }
  return { sources, hasAny: sources.length > 0 };
}

/**
 * Pre-resolve the advancement choices for every origin in isolation, so the compendium
 * scans they trigger — tool-category expansion ({@link expandToolPool}) and `allowDrops`
 * restriction scans ({@link findRestrictedItems}) — happen once behind the loading spinner
 * rather than on the click that selects a class (which runs {@link resolveChoices} afresh
 * every time). Each origin is resolved against a throwaway state holding only that origin,
 * populating the module-level memo caches the live resolver then reuses. Failures on one
 * origin are swallowed so a bad document can't abort the warm-up.
 * @param {import("./source-index.mjs").SourceIndex} source
 * @param {() => void} [onTick]  Invoked once per origin warmed, for progress reporting.
 */
export async function warmChoices(source, onTick) {
  const origins = [
    ...source.classes().map(c => ["class", c.uuid]),
    ...source.species().map(c => ["species", c.uuid]),
    ...source.backgrounds().map(c => ["background", c.uuid])
  ];
  await forEachLimit(origins, WARM_CONCURRENCY, async ([key, uuid]) => {
    const field = ORIGIN_FIELDS[key];
    const state = { classUuid: null, speciesUuid: null, backgroundUuid: null, advChoices: {}, [field]: uuid };
    try {
      await resolveChoices(state, source);
    } catch ( err ) {
      log(`failed to warm choices for ${uuid}`, err);
    }
    onTick?.();
  });
}

/**
 * True once every requirement across all sources has enough picks. Spell-type choices
 * (`spellStep`) are excluded — they gate the dedicated feat-spells step, not this one.
 */
export function choicesComplete(resolved) {
  for ( const src of resolved?.sources ?? [] ) {
    for ( const req of src.requirements ) if ( !req.spellStep && !req.complete ) return false;
  }
  return true;
}

/* -------------------------------------------- */
/*  Requirement preparation                     */
/* -------------------------------------------- */

/**
 * The origin item plus the level-≤1 features that hang off it, as `{item, ownerUuid}` pairs
 * (ownerUuid null for the origin itself). A feature counts as a nested owner whether it's
 * handed out unconditionally (ItemGrant) or *picked* by the player from an ItemChoice — e.g.
 * the Human "choose a feat" option, where the chosen feat (Crafter) carries its own tool
 * choice. Recurses through both, so a chosen feat's choices surface and feed the same dedupe
 * and apply paths as granted ones. `seen` guards against cycles; depth caps runaway nesting.
 *
 * A feature carrying no advancements of its own is still recorded — it just isn't recursed into.
 * Those leaves matter to {@link collectOwnedIdentifiers}: every PHB fighting style lists the
 * advancement-less "Fighting Style" *feature* as its item prerequisite, so dropping leaves left
 * that identifier out of the owned set, gated out all four styles, and made the whole
 * fighting-style choice vanish from a level-1 Fighter.
 * @param {Item} item
 * @param {object} sel  The source's recorded picks (`advChoices[source]`), to read ItemChoices.
 */
async function levelOneOwners(item, sel = {}, seen = new Set(), ownerUuid = null, depth = 0) {
  const owners = [{ item, ownerUuid }];
  if ( depth > 3 ) return owners;
  for ( const adv of advancementArray(item) ) {
    if ( (adv.level ?? 0) > 1 ) continue;
    let refs = null;
    if ( adv.type === "ItemGrant" ) {
      refs = Array.from(adv.configuration?.items ?? []).map(r => typeof r === "string" ? r : r?.uuid);
    } else if ( adv.type === "ItemChoice" ) {
      refs = itemChoicePicks(adv, sel);
    } else if ( adv.type === "Subclass" ) {
      // A 2014-rules Cleric, Sorcerer or Warlock chooses its subclass at level 1, so the subclass is
      // part of the level-≤1 build and its own advancements (domain spells, heavy armour, an extra
      // cantrip) are creation decisions. Recursing here is what surfaces them: without it the
      // subclass item would be granted with none of what it brings. 2024 classes take theirs at
      // level 3, where the `level > 1` guard above skips this entirely.
      refs = Array.from(sel?.[adv._id] ?? []).map(p => typeof p === "string" ? p : p?.uuid).filter(Boolean);
    } else continue;
    for ( const uuid of refs ) {
      if ( !uuid || seen.has(uuid) ) continue;
      seen.add(uuid);
      const doc = await fromUuid(uuid).catch(() => null);
      if ( !doc ) continue;
      // Recurse into a feature that brings advancements of its own; record one that doesn't as a
      // leaf. A leaf contributes no requirements (there is nothing to walk) but does contribute
      // its identifier — see the note above.
      if ( advancementArray(doc).length ) owners.push(...await levelOneOwners(doc, sel, seen, uuid, depth + 1));
      else owners.push({ item: doc, ownerUuid: uuid });
    }
  }
  return owners;
}

/** The UUIDs the player picked for an ItemChoice advancement (stored under its bare id). */
function itemChoicePicks(adv, sel) {
  return Array.from(sel?.[adv._id] ?? []).map(p => typeof p === "string" ? p : p?.uuid).filter(Boolean);
}

/**
 * Every feat/feature identifier the level-≤1 build grants across all origins — the origin items
 * themselves plus their granted/chosen features (the pre-walked `def.owners`). These are the slugs
 * a feat's `system.prerequisites.items` is matched against, so an option requiring a feature the
 * build hasn't taken (a Warlock invocation needing Pact of the Blade) can be gated out.
 *
 * Completeness matters more here than anywhere else the owner list is used: a *missing* identifier
 * doesn't merely hide one option, it can empty a whole pool and make the choice disappear (see the
 * fighting-style note on {@link levelOneOwners}).
 * @param {{owners?: {item: Item}[]}[]} defs  Origin defs carrying their walked owner list.
 */
function collectOwnedIdentifiers(defs) {
  const ids = new Set();
  for ( const d of defs ) {
    for ( const { item } of d.owners ?? [] ) {
      // `Item5e#identifier` falls back to a slug of the name, but a plain object read straight
      // from a pack index has no such getter — take the stored identifier in that case.
      const id = item?.identifier ?? item?.system?.identifier;
      if ( id ) ids.add(id);
    }
  }
  return ids;
}

/**
 * Gather every trait proficiency/language already acquired across all sources so a key
 * taken once can be greyed out elsewhere. Keys are namespaced `mode|key` so distinct
 * mechanics that reuse keys (weapon mastery vs proficiency) stay independent. Returns the
 * fixed grants and the player's picks keyed by `source:selKey`.
 * @param {{key: string, sel?: object, owners?: {item: Item}[]}[]} defs
 */
function collectTakenTraitKeys(defs) {
  const grants = new Set();
  const chosenBySelKey = new Map();
  for ( const d of defs ) {
    if ( !d.owners ) continue;
    const bucket = d.sel;
    for ( const { item: owner } of d.owners ) {
      for ( const adv of advancementArray(owner) ) {
        if ( adv.type !== "Trait" || (adv.level ?? 0) > 1 ) continue;
        const mode = adv.configuration?.mode || "default";
        for ( const g of Array.from(adv.configuration?.grants ?? []) ) grants.add(`${mode}|${g}`);
        const choices = Array.from(adv.configuration?.choices ?? []);
        for ( let ci = 0; ci < choices.length; ci++ ) {
          const picks = bucket[`${adv._id}#${ci}`];
          if ( !picks?.length ) continue;
          chosenBySelKey.set(`${d.key}:${adv._id}#${ci}`, new Set(picks.map(k => `${mode}|${k}`)));
        }
      }
    }
  }
  return { grants, chosenBySelKey };
}

/**
 * Parse one origin item's advancements (and its granted features') into requirements. Takes the
 * origin def prepared by {@link resolveChoices}, which already carries the source's pick bucket and
 * its walked owner list, plus the values {@link resolveChoices} computes across the whole build.
 * @param {{key: string, sel: object, owners: {item: Item, ownerUuid: string|null}[]}} def
 * @param {{crossTaken: object, spellAbilityHint: object|null, ownedIds: Set<string>,
 *          expertiseSkillPool: object[]}} shared
 */
async function prepareRequirements(def, shared) {
  const { key: source, sel, owners } = def;
  const { crossTaken, spellAbilityHint, ownedIds, expertiseSkillPool, index, rules } = shared;
  const reqs = [];

  for ( const { item: owner, ownerUuid } of owners ) {
    for ( const adv of advancementArray(owner) ) {
      await parseAdvancementChoice(adv, { source, ownerUuid, sel, reqs, expertiseSkillPool, crossTaken, spellAbilityHint, owned: ownedIds, index, ownerItem: owner, rules });
    }
  }

  // Expertise depends on the skill picks, so present it after them (stable sort).
  reqs.sort((a, b) => (a.isExpertise ? 1 : 0) - (b.isExpertise ? 1 : 0));

  // Hints carry enricher markup (e.g. "@UUID[…]{Sharp Eye}"); render to real links/text.
  await Promise.all(reqs.map(async req => { if ( req.hint ) req.hint = await enrichHTML(req.hint); }));
  return reqs;
}

/**
 * Every skill the build makes the character proficient in — the eligible Expertise options.
 *
 * Expertise is scoped to the *character*, not to the source that offers it: the Rogue's advancement
 * pools `skills:*` in `mode: "expertise"`, and dnd5e intersects that with the skills the actor
 * actually holds. So a Rogue with a Sage background may take Expertise in Arcana, which the
 * background granted. Reading only the offering source's own advancements (as this did) silently
 * dropped every skill from the species and background, and the character came out with plain
 * proficiency where the rules — and a natively-built character — give expertise.
 *
 * Walks all sources for the same reason {@link collectTakenTraitKeys} and
 * {@link collectOwnedIdentifiers} do, and is computed once beside them.
 *
 * Expertise-mode advancements are skipped: their picks upgrade a proficiency rather than granting
 * one, so they are not themselves candidates.
 * @param {{sel?: object, owners?: {item: Item}[]}[]} defs
 */
function proficientSkillKeys(defs) {
  // Skills *and* tools. The 2014 Rogue's Expertise is `count: 2` over a pool of
  // `[tool:thief, skills:*]` — thieves' tools are a legitimate expertise pick by the rules — so a
  // skills-only set cannot satisfy it. What keeps a 2024 Rogue (whose pool is `skills:*` alone) from
  // being offered a tool is the pool intersection at the call site, not this filter.
  const isProficiency = k => typeof k === "string"
    && (k.startsWith("skills:") || k.startsWith("tool:")) && !k.endsWith(":*");
  const keys = new Set();
  for ( const d of defs ) {
    const sel = d.sel ?? {};
    for ( const { item: owner } of d.owners ?? [] ) {
      for ( const adv of advancementArray(owner) ) {
        if ( adv.type !== "Trait" || (adv.level ?? 0) > 1 ) continue;
        if ( adv.classRestriction === "secondary" || adv.configuration?.mode === "expertise" ) continue;
        for ( const g of adv.configuration?.grants ?? [] ) if ( isProficiency(g) ) keys.add(g);
        const choices = Array.from(adv.configuration?.choices ?? []);
        for ( let ci = 0; ci < choices.length; ci++ ) {
          const pool = Array.from(choices[ci].pool ?? []);
          if ( !pool.some(k => typeof k === "string" && (k.startsWith("skills:") || k.startsWith("tool:"))) ) continue;
          for ( const k of sel[`${adv._id}#${ci}`] ?? [] ) if ( isProficiency(k) ) keys.add(k);
        }
      }
    }
  }
  return [...keys].map(k => ({ key: k, label: traitKeyLabel(k), img: traitKeyIcon(k) }));
}

/**
 * The icon for a trait key (skills, tools, languages, …), or null. Prefers the Baldur's Gate 3
 * module's proficiency art when that module is enabled, else the system's generic key icon.
 */
const traitKeyIcon = k => bg3TraitIcon(k) ?? dnd5e.documents.Trait?.keyIcon?.(k) ?? null;

/**
 * Stamp each trait option with the icon the level-up trait screen uses — PHB weapon art where a
 * weapon key resolves to a ship item, else the system's generic key icon — so character-creation
 * choice cards render the same iconned grid. Options already carrying an `img` (tool picks) keep it.
 * @param {{key:string, label:string, img?:string}[]} options
 * @returns {Promise<object[]>}
 */
async function decorateTraitIcons(options) {
  return Promise.all(options.map(async o => o.img
    ? o
    : { ...o, img: (await phbWeaponIcon(o.key)) ?? traitKeyIcon(o.key) }));
}

/** Parse a single advancement into zero or more requirements, appended to `reqs`. */
async function parseAdvancementChoice(adv, ctx) {
  const { source, ownerUuid, sel, reqs, expertiseSkillPool, crossTaken, spellAbilityHint, index, ownerItem, rules } = ctx;
  let level = adv.level ?? 0;
  if ( level > 1 || adv.classRestriction === "secondary" ) return;

  // Subclass: only reachable for a class that unlocks one at level ≤1 — the 2014-rules Cleric,
  // Sorcerer and Warlock. Under the 2024 rules every class takes its subclass at level 3, so this
  // never fires and creation had no reason to handle it; in a world holding 2014 classes it does,
  // and without this the character was built with no subclass at all.
  if ( adv.type === "Subclass" ) {
    // From the owning item rather than `adv.item`: `advancementArray` also yields raw advancement
    // *data* (no back-reference) when a document arrives un-prepared.
    const identifier = ownerItem?.system?.identifier ?? ownerItem?.identifier;
    // Scoped to the class's own edition — a 2014 Cleric must not be offered the 2024 domains, which
    // grant their features on the 2024 progression. See `SourceIndex#subclasses`.
    const rules = ownerItem?.system?.source?.rules ?? null;
    const cards = identifier ? await index?.subclasses(identifier, { rules }) ?? [] : [];
    if ( !cards.length ) return;
    reqs.push(buildChoiceReq({
      advId: adv._id, source, ownerUuid, type: "Subclass", level,
      title: adv.title || t("advancement.subclass"), hint: adv.hint, count: 1,
      options: cards.map(c => ({ key: c.uuid, label: c.name, img: c.img })),
      sel, crossTaken
    }));
    return;
  }

  // Size: a species offering a choice of token size (e.g. Small or Medium). A single
  // fixed size is not a decision, so only pools of more than one size become a requirement.
  if ( adv.type === "Size" ) {
    const sizes = Array.from(adv.configuration?.sizes ?? []);
    if ( sizes.length > 1 ) {
      const options = sizes.map(s => ({ key: s, label: CONFIG.DND5E.actorSizes?.[s]?.label ?? s }));
      reqs.push(buildChoiceReq({
        advId: adv._id, source, ownerUuid, type: "Size", level,
        title: adv.title || t("advancement.size"), hint: adv.hint, count: 1, options, sel, crossTaken
      }));
    }
    return;
  }

  // Trait: proficiency / language / expertise picks. One advancement can hold several
  // independent "choose N from this pool" groups, so each `choices` entry becomes its own row.
  if ( adv.type === "Trait" ) {
    const mode = adv.configuration?.mode || "default";
    const isExpertise = mode === "expertise";
    const choices = Array.from(adv.configuration?.choices ?? []);
    const grants = new Set(adv.configuration?.grants ?? []);
    for ( let ci = 0; ci < choices.length; ci++ ) {
      const c = choices[ci];
      const pool = Array.from(c.pool ?? []);
      const count = c.count ?? 1;
      if ( !count ) continue;
      const selKey = `${adv._id}#${ci}`;

      if ( isExpertise ) {
        // dnd5e intersects an expertise pool with what the *character* is already proficient in, so
        // `expertiseSkillPool` is the character side — but the advancement's own pool still decides
        // what kind of proficiency is eligible. A 2024 Rogue pools `skills:*` and may take expertise
        // in skills alone; the 2014 Rogue pools `[tool:thief, skills:*]` and may take it in thieves'
        // tools too. Offering the character's whole proficiency set to both would hand a 2024 Rogue
        // a tool the rules do not allow; offering only skills to both left the 2014 Rogue's second
        // pick unfillable, and the resolver's fixed-point loop never settled.
        // The module's own expansion, so a tool key is shaped the same way it is everywhere else
        // (`expandToolPool` keeps the category prefix — see the tool-proficiency note in the e2e
        // README, where flattening it broke `unfulfilledChoices`).
        const expanded = new Set((await expandTraitPool(pool)).map(o => o.key));
        const options = expertiseSkillPool.filter(o => expanded.has(o.key));
        const valid = new Set(options.map(o => o.key));
        if ( sel[selKey] ) sel[selKey] = sel[selKey].filter(k => valid.has(k));
        const req = buildChoiceReq({
          advId: adv._id, choiceIndex: ci, source, ownerUuid, type: "Trait", level,
          title: adv.title || t("advancement.expertise"), hint: adv.hint, count, options, sel, crossTaken,
          mode
        });
        req.isExpertise = true;
        if ( !options.length ) req.emptyNote = t("choice.emptyNoteSkills");
        reqs.push(req);
        continue;
      }

      let options = await expandTraitPool(pool);
      options = options.filter(o => !grants.has(o.key));
      if ( !options.length ) continue;
      // Drop a pick another source now grants for free, reopening the slot.
      const allGrants = crossTaken?.grants;
      if ( allGrants?.size && sel[selKey]?.some(k => allGrants.has(`${mode}|${k}`)) ) {
        sel[selKey] = sel[selKey].filter(k => !allGrants.has(`${mode}|${k}`));
      }
      reqs.push(buildChoiceReq({
        advId: adv._id, choiceIndex: ci, source, ownerUuid, type: "Trait", level,
        title: adv.title || traitChoiceTitle(pool), hint: adv.hint,
        count, options, sel, crossDedupe: true, dedupeGroup: mode, crossTaken,
        mode, poolType: (pool[0] ?? "").split(":")[0]
      }));
    }
    return;
  }

  // ItemGrant: items handed out automatically (no pick to make) — except when a granted spell
  // lets the player choose which ability casts it, which is the only decision we surface here.
  if ( adv.type === "ItemGrant" ) {
    const abilities = Array.from(adv.configuration?.spell?.ability ?? []);
    if ( abilities.length > 1 ) {
      const options = abilities.map(a => {
        const opt = { key: a, label: CONFIG.DND5E.abilities?.[a]?.label ?? a };
        // Mark the class's configured spellcasting ability as the recommended pick.
        if ( spellAbilityHint && a === spellAbilityHint.ability ) {
          opt.recommended = true;
          opt.recommendTip = t("choice.recommendedAbility", { class: spellAbilityHint.className });
        }
        return opt;
      });
      // The advancement's own title is usually the trait name ("Otherworldly Presence"),
      // which doesn't read as an ability choice. Name it for the granted spell instead, so
      // it's plainly a spellcasting-ability pick and several from one source stay distinct.
      const spellNames = [];
      for ( const ref of Array.from(adv.configuration?.items ?? []) ) {
        const uuid = typeof ref === "string" ? ref : ref?.uuid;
        const spell = uuid ? await fromUuid(uuid).catch(() => null) : null;
        if ( spell ) spellNames.push(spell.name);
      }
      const title = spellNames.length
        ? t("advancement.spellAbilityFor", { spell: spellNames.join(", ") })
        : t("advancement.spellAbility");
      reqs.push(buildChoiceReq({
        advId: adv._id, source, ownerUuid, type: "SpellAbility", level,
        title, hint: adv.hint, count: 1, options, sel, crossTaken
      }));
    }
    return;
  }

  // ItemChoice: choose N items/features from a pool (e.g. a feat, or a fighting style).
  if ( adv.type === "ItemChoice" ) {
    const cfg = adv.configuration ?? {};
    // ItemChoice levels live in `choices` keyed by character level; take the lowest ≤ 1.
    const choiceLevel = Object.keys(cfg.choices ?? {})
      .map(Number).filter(l => Number.isFinite(l) && l <= 1).sort((a, b) => a - b)[0];
    if ( choiceLevel === undefined ) return;

    // Spell-type ItemChoice — the Magic Initiate shape (choose N cantrips/spells from a class
    // list). Surfaced as a lightweight `SpellChoice` requirement rather than an item pool: the
    // dedicated feat-spells step renders it (`spellStep`), and its `ownerUuid` makes the granting
    // feature a takeover target so the AdvancementManager never prompts for it (§7 of the plan).
    if ( cfg.type === "spell" ) {
      const count = Number(cfg.choices[choiceLevel]?.count ?? cfg.choices[choiceLevel] ?? 0);
      if ( !count ) return;
      const chosen = sel[adv._id] ?? [];
      reqs.push({
        advId: adv._id, selKey: adv._id, source, ownerUuid, type: "SpellChoice", spellStep: true,
        level: choiceLevel,
        spellLevel: Number(cfg.restriction?.level ?? 0),
        count,
        classList: Array.from(cfg.restriction?.list ?? []).map(k => String(k).replace(/^class:/, "")),
        abilityKeys: Array.from(cfg.spell?.ability ?? []),
        title: adv.title || t("advancement.chooseItems"),
        chosenCount: chosen.length,
        complete: chosen.length >= count
      });
      return;
    }
    level = choiceLevel;
    const levelChoices = cfg.choices[choiceLevel];
    const count = Number(levelChoices?.count ?? levelChoices ?? 0);
    if ( !count ) return;

    // Prerequisite gate: an option the character can't legitimately pick is dropped, whether the
    // bar is a `system.prerequisites.level` above the character's level (a Warlock's level-5
    // Eldritch Invocation offered at creation) or a `system.prerequisites.items` feature the build
    // hasn't taken (Improved Pact Weapon needing Pact of the Blade). Creation always builds a
    // level-1 character (a class-linked ItemChoice may key at level 0, so floor at 1). An option
    // whose *item* prerequisite the build satisfies is flagged `recommended` — the build unlocked
    // it, so it earns the "recommended" panel. The native ItemChoice flow skips all of this for its
    // static pool, which is why ineligible options otherwise leak in.
    const maxPrereqLevel = choiceLevel || 1;
    const owned = ctx.owned ?? new Set();
    // Returns null when the option is gated out; otherwise `{ recommended }` — true when the build
    // satisfies an item prerequisite the option carries.
    const gate = (prereq = {}) => {
      if ( Number(prereq.level ?? 0) > maxPrereqLevel ) return null;
      const { hasReq, met } = evalItemPrereq(prereq.items, owned);
      if ( hasReq && !met ) return null;
      return { recommended: hasReq && met };
    };

    const options = [];
    const seen = new Set();
    // Also track option names: `allowDrops` scans every enabled pack, so an item the pool
    // already lists (e.g. a PHB-module fighting style) can reappear as a same-named SRD copy
    // with a different UUID. Dedupe by name too so those don't double up.
    const seenNames = new Set();
    const nameKey = n => (n ?? "").trim().toLowerCase();
    for ( const p of Array.from(cfg.pool ?? []) ) {
      const uuid = typeof p === "string" ? p : p?.uuid;
      if ( !uuid || seen.has(uuid) ) continue;
      const doc = await fromUuid(uuid).catch(() => null);
      if ( !doc ) continue;
      const g = gate(doc.system?.prerequisites);
      if ( !g ) continue;
      seen.add(uuid);
      seenNames.add(nameKey(doc.name));
      options.push({ key: uuid, uuid, label: doc.name, img: doc.img, recommended: g.recommended });
    }
    if ( cfg.allowDrops && cfg.restriction?.subtype ) {
      for ( const opt of await findRestrictedItems(cfg, maxPrereqLevel, rules) ) {
        if ( seen.has(opt.key) || seenNames.has(nameKey(opt.label)) ) continue;
        const g = gate({ items: opt.prereqItems });   // level already filtered by the scan
        if ( !g ) continue;
        seen.add(opt.key);
        seenNames.add(nameKey(opt.label));
        options.push({ key: opt.key, uuid: opt.uuid, label: opt.label, img: opt.img, recommended: g.recommended });
      }
    }
    if ( !options.length ) return;
    options.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    const req = buildChoiceReq({
      advId: adv._id, source, ownerUuid, type: "ItemChoice", level,
      title: adv.title || t("advancement.chooseItems"), hint: adv.hint, count, options, sel, crossTaken
    });
    // Split into a "Recommended" + "Other" panel when the build unlocked any option (an item
    // prerequisite it satisfies); otherwise leaves the single ungrouped grid untouched.
    req.groups = groupRecommended(req.options) ?? req.groups;
    reqs.push(req);
  }
}

/**
 * A plain-language explainer for a block: what the choice is and how many to pick. Used as the
 * block's guidance when the advancement carries no `hint` of its own, so every decision reads
 * with a sentence telling the player what it is and what's expected (e.g. weapon mastery).
 * Exported so the level-up trait/choices screens fall back to the same sentence.
 * @param {{type:string, mode?:string, poolType?:string, count:number}} descriptor
 */
export function choiceBlurb({ type, mode = "default", poolType = null, count = 1 }) {
  // Blocks that are inherently a single pick read as complete sentences on their own.
  if ( type === "Size" ) return t("choice.blurb.size");
  if ( type === "SpellAbility" ) return t("choice.blurb.spellAbility");
  if ( type === "Subclass" ) return t("choice.blurb.subclass");

  let desc;
  if ( type === "ItemChoice" ) desc = t("choice.blurb.itemChoice");
  else if ( mode === "expertise" ) desc = t("choice.blurb.expertise");
  else if ( mode === "mastery" ) desc = t("choice.blurb.mastery");
  else {
    const key = { weapon: "weapon", skills: "skills", tool: "tool", languages: "languages",
      armor: "armor", saves: "saves", ci: "resist", di: "resist", dr: "resist" }[poolType] ?? "trait";
    desc = t(`choice.blurb.${key}`);
  }
  const choose = count > 1 ? t("choice.chooseCount", { count }) : t("choice.chooseOne");
  return `${desc} ${choose}.`;
}

/** Assemble one requirement descriptor and merge in the player's current picks. */
function buildChoiceReq({
  advId, choiceIndex = null, source, ownerUuid = null, type, level = 0, title, hint,
  count, options, sel, crossDedupe = false, dedupeGroup = "default", crossTaken,
  mode = "default", poolType = null
}) {
  const selKey = choiceIndex == null ? advId : `${advId}#${choiceIndex}`;
  const chosen = sel[selKey] ?? [];
  // Stamp the routing attributes onto every option so the template can wire its button
  // without reaching back up through nested `{{#each}}` scopes (flat vs grouped).
  const opts = options.map(o => ({ ...o, isSelected: chosen.includes(o.key), source, selKey, count }));

  // Grey out options granted/chosen elsewhere (never the option's own current selection).
  if ( crossDedupe && crossTaken ) {
    const { grants, chosenBySelKey } = crossTaken;
    const ownSelKey = `${source}:${selKey}`;
    for ( const o of opts ) {
      if ( o.isSelected ) continue;
      const nk = `${dedupeGroup}|${o.key}`;
      let taken = grants.has(nk);
      if ( !taken ) {
        for ( const [gsk, set] of chosenBySelKey ) {
          if ( gsk !== ownSelKey && set.has(nk) ) { taken = true; break; }
        }
      }
      if ( taken ) { o.disabled = true; o.disabledReason = t("choice.alreadyGained"); }
    }
  }

  return {
    advId, choiceIndex, selKey, source, ownerUuid, type, level,
    title, hint: hint || choiceBlurb({ type, mode, poolType, count }), count,
    countLabel: count > 1 ? t("choice.chooseCount", { count }) : t("choice.chooseOne"),
    showProgress: count > 1,
    chosenCount: chosen.length,
    complete: chosen.length >= count,
    options: opts,
    groups: groupOptions(opts)
  };
}

/* -------------------------------------------- */
/*  Option helpers                              */
/* -------------------------------------------- */

/**
 * Evaluate a feat/invocation's item prerequisites against the identifiers a build already owns.
 * dnd5e stores `system.prerequisites.items` as a set of identifiers, each optionally `type:identifier`;
 * the feature qualifies when the character holds at least one of them — mirroring the item check in
 * Item5e#validatePrerequisites. Shared by the creation resolver and the level-up choices step.
 * @param {{items?: Iterable<string>}} prereqItems  Source of the required identifiers (a doc's
 *   `system.prerequisites.items`, or a bare list passed through by the compendium scan).
 * @param {Set<string>} owned  Identifier slugs the build grants.
 * @returns {{hasReq: boolean, met: boolean}}  `hasReq` — an item prerequisite exists at all;
 *   `met` — the build satisfies it (always true when there's no item prerequisite).
 */
export function evalItemPrereq(prereqItems, owned) {
  const reqs = prereqItems ? Array.from(prereqItems) : [];
  if ( !reqs.length ) return { hasReq: false, met: true };
  // A prerequisite entry may be namespaced `type:identifier`; the actor map keys (and our owned
  // set) hold bare identifier slugs, so match on the portion after any single ":".
  const bare = id => { const s = String(id); const i = s.indexOf(":"); return i < 0 ? s : s.slice(i + 1); };
  return { hasReq: true, met: reqs.some(id => owned?.has(bare(id))) };
}

/**
 * Split feat/invocation options into a leading "Recommended" panel (those the build specifically
 * unlocks — an item prerequisite it satisfies) and an "Other" panel for the rest. Returns null when
 * nothing is recommended, so the choice renders as a single ungrouped grid as before.
 *
 * "Recommended" is a *comparative* signal: it means this build unlocked an option that another build
 * wouldn't have. A prerequisite every pickable option shares carries no such signal, so this first
 * clears the flag in that case — otherwise the whole pool lands in the panel and nothing lands in
 * "Other", which reads as a recommendation of everything. Every PHB fighting style, for instance,
 * lists the Fighting Style *feature* as its prerequisite — the very feature granting the choice — so
 * a Paladin's level-2 pick satisfies it for all twelve options by construction. Earlier picks
 * (`owned`) sit outside the comparison: they're shown locked, not offered.
 */
export function groupRecommended(opts) {
  const pickable = opts.filter(o => !o.owned);
  if ( pickable.length && pickable.every(o => o.recommended) ) {
    for ( const o of pickable ) o.recommended = false;
  }
  if ( !opts.some(o => o.recommended) ) return null;
  const groups = [{ label: t("choice.recommended"), options: opts.filter(o => o.recommended) }];
  const rest = opts.filter(o => !o.recommended);
  if ( rest.length ) groups.push({ label: t("choice.other"), options: rest });
  return groups;
}

/** Split weapon-choice options into Simple vs Martial sections; null when not weapons. */
function groupOptions(opts) {
  if ( !opts.length || !opts.every(o => typeof o.key === "string" && o.key.startsWith("weapon:")) ) return null;
  const LABELS = { sim: t("choice.simpleWeapons"), mar: t("choice.martialWeapons") };
  const buckets = new Map();
  for ( const o of opts ) {
    const cat = o.key.split(":")[1] || "other";
    if ( !buckets.has(cat) ) buckets.set(cat, []);
    buckets.get(cat).push(o);
  }
  if ( buckets.size < 2 ) return null;
  const groups = [];
  for ( const cat of ["sim", "mar"] ) {
    if ( buckets.has(cat) ) { groups.push({ label: LABELS[cat], options: buckets.get(cat) }); buckets.delete(cat); }
  }
  for ( const [cat, list] of buckets ) groups.push({ label: LABELS[cat] ?? t("choice.other"), options: list });
  return groups;
}

/** Human title for a trait choice with no advancement title, from its pool type. */
export function traitChoiceTitle(pool = []) {
  const type = (pool[0] ?? "").split(":")[0];
  return TRAIT_TITLE[type] ? t(TRAIT_TITLE[type]) : t("choice.fallback");
}

/**
 * Expand a Trait pool into concrete options, each iconned to match the level-up trait screen.
 * Tool pools already resolve with their own art; every other option is decorated here.
 */
async function expandTraitPool(pool = []) {
  const toolOpts = await expandToolPool(Array.from(pool ?? []));
  if ( toolOpts ) return toolOpts;               // tool picks ship their own compendium art
  return decorateTraitIcons(await expandTraitKeys(pool));
}

/** Expand a Trait pool (including `*` wildcards) into concrete `{key,label}` options. */
async function expandTraitKeys(pool = []) {
  const Trait = dnd5e.documents.Trait;
  pool = Array.from(pool ?? []);

  if ( !pool.some(k => k.includes("*")) ) return pool.map(k => ({ key: k, label: traitKeyLabel(k) }));

  const flatten = (sc, out = []) => {
    for ( const [key, entry] of Object.entries(sc ?? {}) ) {
      if ( entry?.children && Object.keys(entry.children).length ) flatten(entry.children, out);
      else out.push({ key, label: entry?.label ?? traitKeyLabel(key) });
    }
    return out;
  };

  try {
    if ( typeof Trait?.mixedChoices === "function" ) {
      const out = flatten(await Trait.mixedChoices(new Set(pool)));
      if ( out.length ) return out;
    }
  } catch ( err ) {
    log("Trait.mixedChoices failed; per-type expansion", err);
  }
  try {
    const out = [];
    for ( const entry of pool ) {
      if ( !entry.includes("*") ) { out.push({ key: entry, label: traitKeyLabel(entry) }); continue; }
      const type = entry.split(":")[0];
      const prefix = entry.replace(/\*+$/, "").replace(/:$/, "");
      const leaves = flatten(await Trait.choices(type, { prefixed: true }));
      for ( const leaf of leaves ) if ( leaf.key.startsWith(prefix) && leaf.key !== prefix ) out.push(leaf);
    }
    if ( out.length ) return out;
  } catch ( err ) {
    log("Trait per-type expansion failed; literal keys", err);
  }
  return pool.filter(k => !k.includes("*")).map(k => ({ key: k, label: traitKeyLabel(k) }));
}

/**
 * Expand a tool-only Trait pool into concrete pick options from the compendium, handling both
 * whole-category wildcards (e.g. "tool:art:*" -> every Artisan's Tool) and pools of specific
 * named tools (e.g. the Crafter feat's eight "tool:art:carpenter"… keys -> just those eight).
 * Returns null when the pool isn't a tool pool, so the generic expander handles it.
 *
 * Keys keep their category — `tool:art:alchemist`, not `tool:alchemist`. The bare id also *applies*
 * correctly (dnd5e's Trait apply pops the last `:` segment to reach `system.tools.<id>`), which is
 * why this used to flatten them, but applying is not the only thing the system does with a recorded
 * key. `Trait.actorValues` reports the character's existing tools in the prefixed form, and
 * `unfulfilledChoices` matches `value.chosen` against pools expanded by `Trait.mixedChoices`, which
 * is prefixed too — so a flattened key matches nothing, the fulfilled choice never gets spliced off
 * `available`, and the pick shows as neither owned nor made. A tool chosen at creation then
 * reappeared as pickable on a later level-up's tool screen.
 * @param {string[]} pool
 * @returns {Promise<{key:string,label:string,img?:string,uuid?:string}[]|null>}
 */
async function expandToolPool(pool) {
  if ( !pool.length || !pool.every(k => typeof k === "string" && k.startsWith("tool:")) ) return null;

  const out = [];
  const seen = new Set();
  const push = opt => { if ( !seen.has(opt.key) ) { seen.add(opt.key); out.push(opt); } };
  for ( const entry of pool ) {
    const parts = entry.split(":");
    const wildcard = parts[parts.length - 1] === "*";
    const category = toolPoolCategory(entry);
    if ( category && (wildcard || parts.length <= 2) ) {
      // Whole-category pick ("tool:art:*" or bare "tool:art") — every tool in the category.
      for ( const tool of await toolChoices(category) ) {
        if ( tool.baseItem ) {
          push({ key: `tool:${category}:${tool.baseItem}`, label: tool.name, img: tool.img, uuid: tool.uuid });
        }
      }
    } else if ( category ) {
      // A specific tool named within its category ("tool:art:carpenter") — just that one, keyed
      // exactly as the pool named it so it matches the category expansion above.
      const id = parts[parts.length - 1];
      const match = (await toolChoices(category)).find(to => to.baseItem === id);
      if ( match ) push({ key: entry, label: match.name, img: match.img, uuid: match.uuid });
      else push({ key: entry, label: traitKeyLabel(entry) });
    } else if ( wildcard ) {
      return null;                          // uncategorisable wildcard — defer to the generic expander
    } else {
      push({ key: entry, label: traitKeyLabel(entry) });
    }
  }
  return out.length ? out : null;
}

/** The pickable tool category in a pool entry ("tool:art:*" -> "art"), or null if specific. */
function toolPoolCategory(entry) {
  const parts = entry.split(":");
  parts.shift();                            // drop the "tool" prefix
  if ( parts[parts.length - 1] === "*" ) parts.pop();
  return parts.length ? toolCategoryKey(parts[0]) : null;
}

/**
 * Scan enabled compendiums for items matching an `allowDrops` restriction, memoised.
 * When `maxLevel` is given, items are filtered to those the character qualifies for by
 * `system.prerequisites.level` (matching the native ItemChoice flow's feature-level gate — used at
 * level-up so, e.g., a level-2 Artificer's "Replicate Magic Item" only lists level-2 infusions).
 * Only packs the player's Compendium Browser source configuration leaves enabled (and that are
 * visible to them) are scanned — matching dnd5e's own browser/ItemChoice flow — so content from a
 * switched-off pack (the 2014 SRD's level-0 "Devil's Sight" reaching a 2024 warlock, say) never
 * leaks in. Results are de-duplicated by name, collapsing the same feature carried across several
 * edition packs into one option. Each result also carries its `prereqItems` (the item prerequisites)
 * so a caller can gate on or recommend them against a specific build — a check too build-dependent to
 * bake into this memo.
 * @param {object} cfg              The ItemChoice advancement configuration.
 * @param {number|null} [maxLevel]  Highest prerequisite level to include; null disables the gate.
 */
export async function findRestrictedItems(cfg, maxLevel = null, rules = null) {
  const docType = cfg.type;
  const r = cfg.restriction ?? {};
  const sig = `${docType}|${r.type || ""}|${r.subtype || ""}|${maxLevel ?? ""}|${rules ?? ""}`;
  if ( restrictedCache.has(sig) ) return restrictedCache.get(sig);

  const enabled = getEnabledPacks();
  const results = [];
  const seenNames = new Set();
  const nameKey = n => (n ?? "").trim().toLowerCase();
  for ( const pack of game.packs ) {
    // `visible` is this scan's own extra bar: an `allowDrops` pool must never offer the player
    // something out of a pack their permissions hide from them.
    if ( !pack.visible || !isUsableItemPack(pack, enabled) ) continue;
    try {
      const index = await pack.getIndex({
        fields: ["type", "system.type.value", "system.type.subtype", "system.source.rules",
          "system.prerequisites.level", "system.prerequisites.items"]
      });
      for ( const e of index ) {
        if ( docType && e.type !== docType ) continue;
        const ty = e.system?.type ?? {};
        if ( r.type && ty.value !== r.type ) continue;
        if ( r.subtype && ty.subtype !== r.subtype ) continue;
        // Scoped to the build's rules edition. Without this a 2014 Ranger's fighting-style choice
        // offered every fighting style in the world, 2024 ones included — the pool is scanned from
        // the packs rather than authored on the advancement, so nothing else narrows it.
        if ( !matchesRules(e.system?.source?.rules, rules) ) continue;
        if ( (maxLevel != null) && (Number(e.system?.prerequisites?.level ?? 0) > maxLevel) ) continue;
        const nk = nameKey(e.name);
        if ( seenNames.has(nk) ) continue;   // same feature shared across edition packs — keep one
        seenNames.add(nk);
        // Carried through (not filtered here) so the caller can gate on / recommend by item
        // prerequisites against the specific build — that check is build-dependent, unlike this
        // memoised scan.
        const prereqItems = Array.from(e.system?.prerequisites?.items ?? []);
        results.push({ key: e.uuid, uuid: e.uuid, label: e.name, img: e.img, prereqItems });
      }
    } catch ( err ) {
      log(`restricted-item scan failed for ${pack.collection}`, err);
    }
  }
  restrictedCache.set(sig, results);
  return results;
}

/* -------------------------------------------- */
/*  Small utilities                             */
/* -------------------------------------------- */

export const traitKeyLabel = k => dnd5e.documents.Trait?.keyLabel?.(k) ?? k;

function enrichHTML(html) {
  return foundry.applications.ux.TextEditor.implementation.enrichHTML(html, { secrets: false });
}
