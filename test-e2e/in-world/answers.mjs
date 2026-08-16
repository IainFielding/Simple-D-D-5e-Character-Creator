/**
 * The answer book: one decision-answering strategy, consumed identically by both build adapters.
 *
 * A hand-written answer table (`scenarios.mjs`) works for a handful of characters and not at all for
 * a sweep — ninety-odd subclasses carried to level 20 raise thousands of choices, and every one of
 * them has to be answered the *same way* on both sides or the diff reports answer differences
 * dressed up as character differences.
 *
 * Two guarantees make that safe:
 *
 * **Memoised.** An answer is computed once, on the first ask, and keyed by `advId@level`. Whoever
 * asks second gets the identical value — not an equivalent one, the same one. That is the whole
 * contract: the two adapters walk the build at different times, off different clones, in different
 * orders, and none of that can make them disagree about what was chosen.
 *
 * **Preferably static.** Generation reads `advancement.configuration` wherever it can, so a pick is
 * stable across runs and across the two sides independently. Where a choice genuinely depends on the
 * character (an expertise pool is "skills you are already proficient in"; an invocation's item
 * prerequisites are "features you already hold") the first asker resolves it against its own clone
 * and the memo carries that to the second. If the second side then does not offer that key, it says
 * so loudly — `distribute()` on the creator side and `untilFound()` on the native side both refuse a
 * pick that was never offered — which is a real finding, not a false failure.
 *
 * Answers come out in the shapes `scenarios.mjs` documents and the adapters already consume, so a
 * generated scenario and a hand-written one are indistinguishable downstream:
 *
 *   HitPoints                 "avg"
 *   Size                      "med"
 *   Trait                     ["skills:ath", "skills:ins"]
 *   ItemChoice                { uuids: [...], ability: "int" }
 *   ItemGrant                 "int"
 *   AbilityScoreImprovement   { int: 2, con: 1 }   — the total per ability, fixed part included
 */

const MODULE = "/modules/sogrom-dnd5e-character-creator/scripts";
const { findRestrictedItems, evalItemPrereq } = await import(`${MODULE}/data/choice-resolver.mjs`);

/** Ability keys in the order points are spent, so an allocation is reproducible. */
const ABILITY_ORDER = ["str", "dex", "con", "int", "wis", "cha"];

/**
 * Whether an advancement's choice is deliberately routed around the driver rather than through it.
 *
 * Spell-type `ItemChoice`s (Magic Initiate and every variant of it) are owned by the creator's own
 * feat-spells step, which applies the spells straight to the actor after commit. The advancement
 * therefore records nothing on that side by design. Both adapters read this one predicate so they
 * agree on which choices are in that category.
 * @param {Advancement} adv
 * @returns {boolean}
 */
export function isDeferred(adv) {
  return (adv?.type === "ItemChoice") && (adv?.configuration?.type === "spell");
}

/* -------------------------------------------- */
/*  Per-type generation                          */
/* -------------------------------------------- */

/** Sorted copy — every pool is ordered by its own key before slicing, so picks never drift. */
const sorted = keys => [...keys].sort((a, b) => String(a).localeCompare(String(b)));

/** Whether an advancement can raise this ability, tolerating a plain-object stand-in. */
function canImprove(adv, key) {
  if ( typeof adv.canImprove === "function" ) return adv.canImprove(key);
  return CONFIG.DND5E.abilities[key]?.improvement !== false;
}

/**
 * The first configured size, in the system's own size order rather than the configuration's, so two
 * species offering {sm, med} in different orders still answer the same.
 */
function generateSize(adv) {
  const sizes = new Set(adv.configuration?.sizes ?? []);
  if ( !sizes.size ) return { missing: "the Size advancement configures no sizes" };

  // One configured size is not a decision — the 2014 SRD species are all plain Medium. Both paths
  // apply it without asking anyone, so answering would only make the ledger report a decision
  // neither side made: the native manager renders a step for an automatic advancement and therefore
  // still asks, while the driver applies it silently. The same false positive `generateAsi` avoids
  // for a forced increase and `generateTrait` for a grants-only Trait.
  if ( sizes.size === 1 ) return { answer: null, note: "a single fixed size, nothing to choose" };

  const order = Object.keys(CONFIG.DND5E.actorSizes ?? {});
  const pick = order.find(s => sizes.has(s)) ?? sorted(sizes)[0];
  return { answer: pick };
}

/**
 * Trait picks: the first `count` keys of each choice group's expanded pool.
 *
 * Returned flat across every group, which is the shape the native flow's single select consumes and
 * which the creator adapter's `distribute()` splits back out per group. Keys an earlier group in the
 * same advancement already claimed are skipped so the two groups cannot both take one, and the
 * advancement's automatic `grants` are excluded — the driver and the native manager both seed those
 * before anyone is asked.
 *
 * The configured pool is never the whole story. What a character may actually pick is the pool minus
 * everything they already have — a Sage grants Arcana and History, so the Wizard's "choose 2 skills"
 * never offers those — and an **expertise** pool is not in the configuration at all, being "skills
 * this source already made you proficient in". So the asker's own rendered list, where it has one,
 * narrows each group; the memo then carries the result to the other side.
 */
async function generateTrait(adv, offered) {
  const Trait = dnd5e.documents.Trait;
  const cfg = adv.configuration ?? {};
  const groups = Array.from(cfg.choices ?? []);
  // Grants only — the commonest Trait there is (saving throws, armour training, a class's weapon
  // proficiencies). Both sides apply it from the same seed and neither has anything to decide.
  if ( !groups.length ) return { answer: null, note: "grants only, nothing to choose" };

  const granted = (await Trait.mixedChoices(new Set(cfg.grants ?? []))).asSet();
  const taken = new Set(adv.value?.chosen ?? []);
  const available = new Set((await offered?.()) ?? []);
  const picks = [];

  for ( const group of groups ) {
    const count = group.count ?? 1;
    if ( !count ) continue;

    // Expertise has no configured pool to start from, so the asker's list *is* the pool. Every other
    // mode starts from the configuration and is narrowed by it — keeping the groups distinct, which
    // a flat list would lose and which the creator's `distribute()` needs to split the picks back.
    let pool = (cfg.mode === "expertise")
      ? sorted(available)
      : sorted((await Trait.mixedChoices(group.pool)).asSet());
    if ( available.size && (cfg.mode !== "expertise") ) pool = pool.filter(k => available.has(k));

    let remaining = count;
    for ( const key of pool ) {
      if ( !remaining ) break;
      if ( granted.has(key) || taken.has(key) ) continue;
      picks.push(key);
      taken.add(key);
      remaining--;
    }
    if ( remaining ) {
      // A pool big enough for the choice, emptied by what the character already has, is *exhausted*
      // rather than too small — an Eberron background whose one offered proficiency it also grants
      // outright is the case in the wild. Neither side can pick anything, so both apply nothing and
      // the two agree; reporting it as unanswerable failed the scenario over a non-difference.
      //
      // A pool genuinely shorter than the choice is a different thing and still reported: that is
      // content the generator cannot satisfy, and silence would hide it.
      if ( pool.length >= count ) continue;
      // An *empty* pool is the same symmetry once more: neither side can pick anything, so both
      // apply nothing and agree. The 2024 Criminal background ships a "Background Proficiencies"
      // choice of 1 over no options at all. Recorded as a note so the oddity stays visible in the
      // report rather than failing a scenario over a non-difference.
      if ( !pool.length ) {
        return { answer: null, note: `"${adv.title}" offers no options for a choice of ${count}` };
      }
      return {
        missing: `"${adv.title}" offers ${pool.length} key(s) for a choice of ${count}`
          + `${available.size ? "" : " (the asker showed no pool, so this is the configured one)"}`
      };
    }
  }
  if ( !picks.length ) return { answer: null, note: "every choice group is already fulfilled" };
  return { answer: picks };
}

/**
 * Feature picks for an `ItemChoice`: the first `count` eligible uuids of the pool, plus the casting
 * ability when the choice grants spells.
 *
 * Eligibility mirrors the gate the level-up choices screen and the native flow both apply — an
 * option whose prerequisite level exceeds this feature's level, or whose item prerequisites the
 * build does not hold, is not pickable (a Warlock's Improved Pact Weapon before Pact of the Blade).
 * A drop-restricted pool (the Artificer's "Replicate Magic Item") carries no authored options at
 * all; those come from the same compendium scan the creator uses.
 */
async function generateItemChoice(adv, level, offered) {
  const cfg = adv.configuration ?? {};
  const count = cfg.choices?.[level]?.count ?? 0;
  const ability = sorted(cfg.spell?.ability ?? [])[0] ?? null;
  // Nothing to pick at this level. A casting ability is still an answer; without one there is no
  // decision here at all.
  if ( !count ) {
    return ability ? { answer: { uuids: [], ability } } : { answer: null, note: "no picks at this level" };
  }

  const featureLevel = level || adv.actor?.system?.details?.level || null;
  const owned = new Set(adv.actor?.identifiedItems?.keys() ?? []);
  // Anything this advancement already granted at another level is not on offer again.
  const already = new Set(Object.values(adv.value?.added ?? {}).flatMap(m => Object.values(m ?? {})));

  // The asker's own pool, when it has one, is the authority: it has already been gated by the
  // prerequisites the compendium documents alone cannot decide (a Warlock's Improved Pact Weapon
  // needing Pact of the Blade). Falling back to the configuration and re-deriving the gate is for
  // the asker that has no rendered pool to read.
  let candidates = (await offered?.())?.filter(u => !already.has(u)) ?? [];

  if ( !candidates.length ) {
    for ( const entry of Array.from(cfg.pool ?? []) ) {
      const uuid = entry?.uuid ?? entry;
      if ( !uuid ) continue;
      const doc = await fromUuid(uuid).catch(() => null);
      if ( !doc ) continue;
      // The document's own uuid, not the configured one. Older content stores the pre-v10 form
      // (`Compendium.<pack>.<id>`, no `.Item.` segment) — the Ranger's "Hunter's Prey" is one — and
      // the rendered checkboxes are named with the modern form, so answering with the pool's string
      // verbatim names a control that does not exist. `fromUuid` resolves both; `doc.uuid` is
      // whichever one the rest of the world uses.
      const canonical = doc.uuid ?? uuid;
      if ( already.has(canonical) ) continue;
      const prereq = doc.system?.prerequisites ?? {};
      if ( (featureLevel != null) && (Number(prereq.level ?? 0) > featureLevel) ) continue;
      const { hasReq, met } = evalItemPrereq(prereq.items, owned);
      if ( hasReq && !met ) continue;
      candidates.push(canonical);
    }
  }

  // A restriction-driven pool has no authored entries at all; the compendium browser is the only
  // route natively, and this scan is what the creator's own screen lists.
  if ( !candidates.length && (cfg.restriction?.type || cfg.restriction?.subtype) ) {
    for ( const opt of await findRestrictedItems(cfg, featureLevel) ) {
      if ( already.has(opt.uuid) ) continue;
      const { hasReq, met } = evalItemPrereq(opt.prereqItems, owned);
      if ( hasReq && !met ) continue;
      candidates.push(opt.uuid);
    }
  }

  const uuids = sorted(candidates).slice(0, count);
  if ( uuids.length < count ) {
    return { missing: `"${adv.title}" has ${uuids.length} eligible option(s) for a choice of ${count} at level ${level}` };
  }
  return { answer: ability ? { uuids, ability } : uuids };
}

/**
 * The casting ability for a spell-granting ItemGrant: the first the configuration allows.
 *
 * Only a genuine choice counts. A grant that allows exactly one ability — which is most of them, a
 * subclass's "Cartographer Spells" being `["int"]` — has nothing to decide, and dnd5e's
 * `automaticApplicationValue` says so: both the native manager and our driver apply it without
 * asking anyone. Reporting a value for it would make every such grant look like a one-sided decision
 * on the sweep, because the native wizard still renders a step for an automatic advancement (and so
 * still asks the book) while the driver applies it silently. A prepared-caster subclass has one of
 * these at five levels; that is a lot of noise for nothing.
 */
function generateGrantAbility(adv) {
  const abilities = sorted(adv.configuration?.spell?.ability ?? []);
  if ( abilities.length < 2 ) {
    return { answer: null, note: `casting ability is fixed at ${abilities[0] ?? "n/a"}` };
  }
  return { answer: abilities[0] };
}

/**
 * An ability-score allocation: spend the whole point budget on the first improvable, unlocked
 * abilities in {@link ABILITY_ORDER}, respecting the per-ability cap.
 *
 * Reported as the *total* per ability with the configuration's fixed part folded in, which is the
 * shape the native form takes and the shape a hand-written scenario states.
 *
 * A feat is never taken in place of the points. Which feat a build can legally take depends on its
 * prerequisites and pulls a second advancement tree in behind it; that belongs in a scenario written
 * for it, not in a sweep whose subject is the subclass.
 */
/**
 * Every *general* feat in the world, uuid-sorted, memoised for the session.
 *
 * Only `subtype: "general"` — origin feats come from a background and epic boons and fighting styles
 * are taken through their own advancements, none of which is what an ASI offers. Feats carrying
 * `prerequisites.items` are excluded outright rather than evaluated: deciding whether the character
 * satisfies one is exactly the gating logic under test elsewhere, and a book that re-implemented it
 * would be marking its own homework. What is left is the large majority, and every one of them is
 * takeable by anyone of the right level.
 */
let generalFeats = null;
async function loadGeneralFeats() {
  if ( generalFeats ) return generalFeats;
  const out = [];
  for ( const pack of game.packs.filter(p => p.documentName === "Item") ) {
    const index = await pack.getIndex({ fields: ["system.type.value", "system.type.subtype",
      "system.prerequisites.level", "system.prerequisites.items", "system.prerequisites.repeatable"] });
    for ( const e of index ) {
      if ( (e.type !== "feat") || (e.system?.type?.value !== "feat") ) continue;
      if ( e.system?.type?.subtype !== "general" ) continue;
      if ( Array.from(e.system?.prerequisites?.items ?? []).length ) continue;
      out.push({
        uuid: e.uuid, name: e.name,
        level: e.system?.prerequisites?.level ?? 0,
        repeatable: !!e.system?.prerequisites?.repeatable
      });
    }
  }
  generalFeats = out.sort((a, b) => a.uuid.localeCompare(b.uuid));
  return generalFeats;
}

/**
 * Answer an ASI by taking a **feat** rather than allocating points — the `asiFeats` axis.
 *
 * The subclass sweep spends every ASI on ability scores, so across 122 level-20 characters not one
 * feat is ever taken and nothing a feat *brings* (its own ASI, its grants, its spell choices) is
 * compared. This answers each ASI with the first eligible general feat not already held, walking
 * further down one stable uuid-sorted list at each successive ASI so a character taking five of them
 * takes five different ones.
 * @param {Advancement} adv
 * @param {number} level   The character level the decision is raised at.
 */
async function generateAsiFeat(adv, level) {
  const cfg = adv.configuration ?? {};
  // Only a *class* ASI offers a feat. Ask the advancement rather than re-deriving the rule: the
  // system's own `allowFeat` getter is `(item.type === "class") && <the allowFeats setting> …`,
  // which also picks up the world's variant settings for free.
  //
  // This used to test `points > 0` on the reasoning that a background increase offers no feat. It
  // does not — a 2024 background's "+2/+1 to distribute" *has* points, so every origin increase
  // sailed through and was answered with a feat, and the native side then failed with "the ASI
  // screen … offers no feat browser". Invisible until the axis was first actually wired up
  // (2026-08-16), because this function had never executed.
  if ( !adv.allowFeat || ((cfg.points ?? 0) <= 0) ) return generateAsi(adv);

  const feats = await loadGeneralFeats();
  const held = new Set(adv.actor?.items?.map(i => i._stats?.compendiumSource ?? i.flags?.dnd5e?.sourceId) ?? []);
  const characterLevel = level || adv.actor?.system?.details?.level || 0;
  const pick = feats.find(f => (f.level <= characterLevel) && (f.repeatable || !held.has(f.uuid)));
  if ( !pick ) return { missing: `no general feat is takeable at level ${characterLevel}` };
  return { answer: { feat: pick.uuid } };
}

function generateAsi(adv) {
  const cfg = adv.configuration ?? {};
  const fixed = cfg.fixed ?? {};
  const cap = cfg.cap ?? Infinity;
  const budget = cfg.points ?? 0;

  const open = ABILITY_ORDER.filter(k => canImprove(adv, k) && !cfg.locked?.has?.(k));

  // Nothing to decide: a capstone's fixed `+4` (Primal Champion, Body and Mind), a half-feat's `+1`,
  // or a budget with a single legal target. Both sides apply these without asking anyone — the
  // driver holds them back and applies them in level order, the native manager's pre-render seed
  // lands them — so answering would only make the ledger report a decision neither side made.
  if ( (budget <= 0) || (open.length <= 1) ) {
    return { answer: null, note: "a forced increase, not an allocation" };
  }

  const totals = {};
  for ( const [key, value] of Object.entries(fixed) ) if ( value ) totals[key] = Number(value);
  let points = budget;
  for ( const key of open ) {
    if ( !points ) break;
    const spend = Math.min(points, cap);
    totals[key] = (totals[key] ?? 0) + spend;
    points -= spend;
  }
  if ( points ) return { missing: `"${adv.title}" has ${points} unspendable point(s) — every ability is locked or capped` };
  return { answer: totals };
}

/* -------------------------------------------- */

/**
 * Generate one answer.
 * @param {Advancement} adv
 * @param {number} level
 * @param {object} [options]
 * @param {Function} [options.offered]   The asker's own option list, for the choices that only exist
 *                                       against a character (see {@link generateTrait}).
 * @returns {Promise<{answer?: *, missing?: string, note?: string}>}
 */
async function generate(adv, level, { offered, asiFeats = false } = {}) {
  if ( isDeferred(adv) ) return { answer: null, note: "deferred to the creator's feat-spells step" };
  switch ( adv?.type ) {
    case "HitPoints": return { answer: "avg" };   // never "roll" — a die is not an equivalence test
    case "Size": return generateSize(adv);
    case "Trait": return generateTrait(adv, offered);
    case "ItemChoice": return generateItemChoice(adv, level, offered);
    case "ItemGrant": return generateGrantAbility(adv);
    case "AbilityScoreImprovement": return asiFeats ? generateAsiFeat(adv, level) : generateAsi(adv);
    case "Subclass":
      // The subclass is the variable a sweep is sweeping. Generating one would defeat the point, so
      // a scenario that raises this decision must state it.
      return { missing: "a Subclass decision has to be stated by the scenario" };
    default:
      // ScaleValue and anything third-party: no answer is needed, both sides auto-apply. Recorded so
      // the report can show what a run walked past rather than leaving it invisible.
      return { answer: null, note: `${adv?.type ?? "unknown"} needs no answer` };
  }
}

/* -------------------------------------------- */

export class AnswerBook {

  /** @type {object} Hand-written answers keyed by advancement id; they win over generation. */
  #overrides;

  /** @type {boolean} Whether unanswered decisions are generated or simply left alone. */
  #generate;

  /**
   * @type {boolean} Whether a generated ASI takes a feat instead of allocating points. The axis that
   * exists because the subclass sweep never takes a feat at all.
   *
   * **This was stored and never read until 2026-08-16, so the axis did nothing.** The flag
   * travelled correctly as far as here — `sweep.mjs` sets `asiFeats: true`, `harness.mjs` passes it
   * to the constructor — but the generate call in {@link answer} read
   * `generate(adv, level, { offered })` without it, so the parameter fell back to its `false`
   * default and `generateAsiFeat` was unreachable. Every ASI on the background axis allocated
   * ability points instead of taking a feat, which is exactly the gap the axis was added to close
   * (see the README's "Feats: never taken"). Found by `no-unused-private-class-members` when the
   * harness was first brought into the lint scope — the field being unread *was* the bug, so the
   * rule that flagged it is the one worth keeping enabled here.
   *
   * **Consequence for baselines:** every archived `sweep-results-background-*.jsonl` predates the
   * fix and was recorded without feats, so it is not comparable with a run taken after it. Re-take
   * the baseline rather than diffing across the change.
   */
  #asiFeats;

  /** @type {Map<string, object>} `advId@level` → the ledger entry holding the settled answer. */
  #memo = new Map();

  /**
   * @param {object} [options]
   * @param {object} [options.overrides]   The scenario's `answers` table.
   * @param {boolean} [options.generate]   Generate an answer for anything the table does not cover.
   */
  constructor({ overrides = {}, generate = false, asiFeats = false } = {}) {
    this.#overrides = overrides ?? {};
    this.#generate = generate;
    this.#asiFeats = asiFeats;
  }

  /* -------------------------------------------- */

  /**
   * Resolve an override for one decision.
   *
   * A per-level map (`{ 2: "avg", 3: "max" }`) selects by the decision's level — one advancement can
   * raise a decision at several levels, hit points being the obvious case. A scalar applies at every
   * level. Both adapters used to do this themselves, in two places that had to be kept in step.
   */
  #override(advId, level) {
    const value = this.#overrides[advId];
    if ( value === undefined ) return undefined;
    const isMap = value && (typeof value === "object") && !Array.isArray(value);
    return (isMap && (level in value)) ? value[level] : value;
  }

  /* -------------------------------------------- */

  /**
   * The answer for one decision, computed once and shared by every asker afterwards.
   * @param {Advancement} adv
   * @param {number} level
   * @param {object} [options]
   * @param {string} [options.asker]      "native" or "creator" — recorded, never used to decide.
   * @param {Function} [options.offered]  The asker's own option list, where generation needs one.
   * @returns {Promise<*>}  The answer, or `undefined` when there is none.
   */
  async answer(adv, level, { asker, offered } = {}) {
    if ( !adv?.id ) return undefined;
    const key = `${adv.id}@${level}`;

    let entry = this.#memo.get(key);
    if ( !entry ) {
      entry = {
        advId: adv.id, level, type: adv.type, title: adv.title ?? null,
        item: adv.item?.name ?? null, source: null, answer: undefined,
        missing: null, note: null, askedBy: []
      };
      this.#memo.set(key, entry);

      const override = this.#override(adv.id, level);
      if ( override !== undefined ) {
        entry.answer = override;
        entry.source = "override";
      } else if ( this.#generate ) {
        const result = await generate(adv, level, { offered, asiFeats: this.#asiFeats });
        entry.answer = result.answer;
        entry.missing = result.missing ?? null;
        entry.note = result.note ?? null;
        entry.source = result.missing ? "missing" : "generated";
      } else {
        // Not a generating scenario and the table says nothing: both sides fall through to the seed
        // the manager (and now the driver) applies, which is the same on either path.
        entry.source = "unanswered";
      }
    }

    if ( asker && !entry.askedBy.includes(asker) ) entry.askedBy.push(asker);
    return entry.answer;
  }

  /**
   * The already-settled answer for a decision, without computing one.
   *
   * `LevelUpDriver#autoResolve` reads its provider synchronously, so the creator adapter warms every
   * decision the driver surfaced before resolving and the provider reads the memo through this. A
   * miss means the warm did not cover that decision, which is a harness bug rather than an
   * unanswered choice — it surfaces as `undefined`, exactly as an unanswered one would.
   * @param {Advancement} adv
   * @param {number} level
   * @param {string} [asker]
   */
  peek(adv, level, asker) {
    const entry = this.#memo.get(`${adv?.id}@${level}`);
    if ( !entry ) return undefined;
    if ( asker && !entry.askedBy.includes(asker) ) entry.askedBy.push(asker);
    return entry.answer;
  }

  /** @see {isDeferred} — exposed here so an adapter needs only the book. */
  isDeferred(adv) {
    return isDeferred(adv);
  }

  /* -------------------------------------------- */

  /** Every decision either adapter asked about, in the order it was first raised. */
  get entries() {
    return [...this.#memo.values()];
  }

  /**
   * Decisions the book should have answered and could not — a content shape the generator does not
   * understand. Worth failing one scenario over: left alone it produces an inexplicable difference
   * in every scenario that touches the same content.
   */
  get missing() {
    return this.entries.filter(e => e.missing);
  }

  /**
   * Decisions raised by only one adapter. A choice the native wizard offers and our driver never
   * surfaces (or the reverse) is a real divergence, and one the character diff shows only
   * indirectly — as a missing item, or not at all.
   * @param {string[]} askers   The adapters that ran, e.g. `["native", "creator"]`.
   */
  asymmetric(askers = ["native", "creator"]) {
    return this.entries.filter(e => e.askedBy.length && (e.askedBy.length < askers.length));
  }
}
