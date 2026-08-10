import { ABILITIES, log } from "../config.mjs";
import { equipmentBudgetCp } from "./store-source.mjs";
import { QUICK_BUILD, MI_SPELL_SUGGESTIONS, FEATURE_PREFERENCES } from "./quick-build-data.mjs";
import { resolveChoices } from "./choice-resolver.mjs";
import { resolveFeatSpells } from "../steps/feat-spells-step.mjs";
import { spellInfoFor } from "../steps/spells-step.mjs";
import { generateName } from "./name-generator.mjs";

/**
 * The Quick Build engine: fill the whole CreatorState from the selected class's suggestion
 * profile ({@link module:data/quick-build-data}) so a brand-new player goes from class pick to
 * the review step in one click — recommended ability placement, a suggested background (with
 * its increase allocated), a random species, a rolled name, every advancement choice, the
 * class's spells, any feat spells, and the default equipment option.
 *
 * Everything is written through the same state fields the steps themselves write, so the
 * existing completion gates validate the result and every pick stays tweakable afterwards.
 * Nothing touches the world — like any other wizard input, it only becomes real at Create.
 *
 * Each area fills inside its own guard: one bad document or missing pack degrades that area
 * (recorded as a warning, leaving its step incomplete for the player) instead of aborting the
 * whole build.
 */

/**
 * @param {object} ctx  The shell's step context (minus `app`).
 * @param {import("../state/creator-state.mjs").CreatorState} ctx.state
 * @param {import("./source-index.mjs").SourceIndex} ctx.source
 * @param {import("./spell-source.mjs").SpellSource} ctx.spells
 * @param {import("./equipment-source.mjs").EquipmentSource} ctx.equipment
 * @param {object} [opts]
 * @param {() => number} [opts.rng]  Injectable RNG for the species pick (deterministic tests).
 * @returns {Promise<{ok: boolean, warnings: string[]}>}
 */
export async function applyQuickBuild({ state, source, spells, equipment }, { rng = Math.random } = {}) {
  if ( !state.classUuid ) return { ok: false, warnings: ["no-class"] };

  const warnings = [];
  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch ( err ) {
      warnings.push(label);
      log(`quick build: ${label} failed`, err);
    }
  };

  const identifier = source.card(state.classUuid)?.identifier ?? "";
  // Quick Build picks the origins for the player, so it has to respect the same edition scoping the
  // grids do — a 2014 class must not be handed a 2024 species. See `SourceIndex#matchesRules`.
  const rules = source.rulesOf(state.classUuid);
  const profile = QUICK_BUILD[identifier] ?? await genericProfile(state.classUuid);
  const classDoc = await fromUuid(state.classUuid).catch(() => null);

  // Start from a clean slate for everything the build derives, exactly as if the player had
  // changed each selection by hand — so a re-run never leaks picks from a previous fill.
  state.resetClassDependent();
  // Each of these also clears that origin's ability increase and allocation.
  state.resetSourceChoices("background");
  state.resetSourceChoices("species");
  state.backgroundUuid = null;
  state.speciesUuid = null;
  state.featSpellCache = [];
  state.equipmentVisited = false;
  state.store.purchases = {};
  state.storeVisited = false;

  // Ability scores: the standard array laid out in the class's priority order.
  assignStandardArray(state, profile.abilities);

  // Background: the suggested one when installed, else the best ability-aligned fit.
  await attempt("background", async () => {
    const card = await pickBackground(source, profile, { rules });
    if ( !card ) { warnings.push("no-backgrounds"); return; }
    state.backgroundUuid = card.uuid;
    state.originAsi.background = await source.abilityScoreIncrease(card.uuid);
    allocateOriginAsi(state, "background", profile.abilities);
  });

  // Species: random — every installed species is somebody's favourite. A 2014 species carries the
  // ability increase its edition's backgrounds don't, so it gets the same allocation pass.
  await attempt("species", async () => {
    const list = source.species({ rules });
    if ( !list.length ) { warnings.push("no-species"); return; }
    state.speciesUuid = list[Math.floor(rng() * list.length)]?.uuid ?? null;
    if ( !state.speciesUuid ) return;
    state.originAsi.species = await source.abilityScoreIncrease(state.speciesUuid);
    allocateOriginAsi(state, "species", profile.abilities);
  });

  // Name: rolled in the chosen species' style (the generator falls back to a generic pool).
  await attempt("name", () => {
    const name = generateName(source.card(state.speciesUuid)?.identifier);
    if ( name ) state.details.name = name;
  });

  // Advancement choices across all three origins (and the features/feats they grant).
  await attempt("choices", () => fillAdvancementChoices(state, source, profile));

  // The class's own cantrips and level-1 spells.
  await attempt("spells", async () => {
    state.spellInfo = await spellInfoFor(spells, state.classUuid);
    if ( !state.spellInfo?.isSpellcaster ) return;
    const data = await spells.forClass(state.classUuid);
    state.selectedCantrips = pickSpells(data.cantrips ?? [], profile.cantrips, data.maxCantrips ?? 0);
    state.selectedSpells = pickSpells(data.level1 ?? [], profile.spells, data.maxSpells ?? 0);
  });

  // Feat spells (Magic Initiate and friends) — after choices, since a picked feat can grant one.
  await attempt("featSpells", () => fillFeatSpells(state, source, spells, profile, classDoc));

  // Equipment: seed the default option's sub-choices, exactly as visiting the step would.
  // The store budget is refreshed alongside it (the Store step's gates read the cache) and
  // the empty cart is marked visited — Quick Build doesn't shop, but the optional step must
  // not block the jump to Review.
  await attempt("equipment", async () => {
    const loaded = await equipment.load(state, source);
    state.equipmentVisited = true;
    state.storeBudgetCp = await equipmentBudgetCp(loaded, state);
    state.storeVisited = true;
  });

  // Refresh the caches every synchronous completion gate reads, so the review jump (and the
  // rail ticks) see the finished state rather than a mid-fill snapshot.
  await attempt("refresh", async () => {
    state.choiceCache = await resolveChoices(state, source);
    state.featSpellCache = await resolveFeatSpells(state, source);
  });

  return { ok: !warnings.length, warnings };
}

/* -------------------------------------------- */
/*  Abilities                                   */
/* -------------------------------------------- */

/**
 * Lay the standard array [15, 14, 13, 12, 10, 8] onto the abilities in priority order —
 * pool index i is the i-th highest value, so priority position maps straight to it.
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {string[]} priorities  All six ability keys, highest first.
 */
export function assignStandardArray(state, priorities) {
  state.abilityMethod = "standard-array";
  state.assignment = { str: null, dex: null, con: null, int: null, wis: null, cha: null };
  priorities.forEach((key, i) => {
    if ( ABILITIES.includes(key) ) state.assignment[key] = i;
  });
}

/**
 * Spend one origin's increase budget down the class's ability priorities: each unlocked ability
 * takes as much as the per-ability cap allows until the points run out. With 2024 backgrounds
 * (3 points, cap 2) this is always +2 to the best unlocked priority, +1 to the next; with the 2014
 * Half-Elf (2 points, cap 1) it is +1 to each of the best two. An origin with no increase — a 2014
 * background, a 2024 species — or a purely fixed one (Hill Dwarf's +2 CON) is a no-op: there is no
 * budget to spend and the step is already complete.
 *
 * The cap counts the advancement's fixed bump alongside the allocation, matching both the panel's
 * `canIncrease` and dnd5e's own flow, so the Half-Elf's fixed +2 CHA cannot take a third point.
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {"species"|"background"} source
 * @param {string[]} priorities
 */
export function allocateOriginAsi(state, source, priorities) {
  const asi = state.originAsi[source];
  state.originAbilities[source] = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
  if ( !asi ) return;
  let remaining = asi.points;
  for ( const key of priorities ) {
    if ( remaining <= 0 ) break;
    if ( !ABILITIES.includes(key) || asi.locked.includes(key) ) continue;
    const headroom = asi.cap - Number(asi.fixed?.[key] ?? 0);
    const add = Math.min(headroom, remaining);
    if ( add <= 0 ) continue;
    state.originAbilities[source][key] = add;
    remaining -= add;
  }
}

/* -------------------------------------------- */
/*  Background pick                             */
/* -------------------------------------------- */

/**
 * The background card to build with: the first of the profile's suggestions that is actually
 * installed, else the available background whose increase abilities best align with the
 * class's top three priorities (+3/+2/+1, alphabetical tiebreak — deterministic either way).
 * @param {import("./source-index.mjs").SourceIndex} source
 * @param {object} profile
 * @param {object} [options]
 * @param {string|null} [options.rules]   Scope to the class's rules edition.
 * @returns {Promise<object|null>}  A background card, or null when none are installed.
 */
export async function pickBackground(source, profile, { rules = null } = {}) {
  const cards = source.backgrounds({ rules });
  if ( !cards.length ) return null;

  const slug = c => String(c.identifier || c.name || "").trim().toLowerCase().replace(/\s+/g, "-");
  for ( const id of profile.backgrounds ?? [] ) {
    const hit = cards.find(c => slug(c) === id);
    if ( hit ) return hit;
  }

  let best = null;
  let bestScore = -1;
  for ( const card of [...cards].sort((a, b) => a.name.localeCompare(b.name)) ) {
    let score = 0;
    const asi = await source.abilityScoreIncrease(card.uuid).catch(() => null);
    if ( asi ) {
      const open = k => !asi.locked.includes(k) || Number(asi.fixed?.[k] ?? 0) > 0;
      (profile.abilities ?? []).slice(0, 3).forEach((k, i) => { if ( open(k) ) score += 3 - i; });
    }
    if ( score > bestScore ) { best = card; bestScore = score; }
  }
  return best;
}

/* -------------------------------------------- */
/*  Advancement choices                         */
/* -------------------------------------------- */

/**
 * Fill every open advancement-choice requirement across class, background, and species.
 * Runs resolve→pick passes until nothing is open, because one pass's picks change the next
 * pass's requirements: the Expertise pool derives from the skill picks, cross-source dedupe
 * greys options as picks land, and an ItemChoice pick (an origin feat) surfaces the chosen
 * feature's own choices on the next resolve. The pass cap only guards against a pathological
 * document — a requirement that can't be filled stops the loop via the no-progress check.
 */
async function fillAdvancementChoices(state, source, profile) {
  for ( let pass = 0; pass < 8; pass++ ) {
    state.choiceCache = await resolveChoices(state, source);
    const open = [];
    for ( const src of state.choiceCache?.sources ?? [] ) {
      for ( const req of src.requirements ) if ( !req.spellStep && !req.complete ) open.push(req);
    }
    if ( !open.length ) return;

    // Skills chosen this pass, so two sources resolved together (whose `disabled` flags
    // can't yet see each other's new picks) never spend two choices on the same skill.
    const takenSkills = new Set();
    let progressed = false;
    for ( const req of open ) {
      const picks = choosePicks(req, profile, takenSkills);
      const current = state.advChoices[req.source]?.[req.selKey] ?? [];
      if ( picks.length && !sameKeys(picks, current) ) {
        state.advChoices[req.source][req.selKey] = picks;
        progressed = true;
      }
    }
    if ( !progressed ) return;
  }
}

/** Order-insensitive equality of two key arrays. */
function sameKeys(a, b) {
  return a.length === b.length && a.every(k => b.includes(k));
}

/**
 * Choose up to `req.count` option keys for one requirement: the profile's preferences first,
 * then a deterministic backfill from the top of the (already sorted) option list. Disabled
 * options (granted or chosen elsewhere) are never taken.
 * @param {object} req            A requirement from the choice resolver.
 * @param {object} profile        The class's quick-build profile.
 * @param {Set<string>} [taken]   Skill keys claimed by other requirements this pass.
 * @returns {string[]}
 */
export function choosePicks(req, profile, taken = new Set()) {
  const available = (req.options ?? []).filter(o => !o.disabled);
  if ( !available.length ) return [];

  const isSkill = k => typeof k === "string" && k.startsWith("skills:");
  // Expertise legitimately re-picks a proficient skill, so only plain picks honour `taken`.
  const claimed = k => !req.isExpertise && isSkill(k) && taken.has(k);

  const chosen = [];
  const push = key => {
    if ( chosen.length >= req.count || chosen.includes(key) || claimed(key) ) return;
    if ( !available.some(o => o.key === key) ) return;   // a preference the pool doesn't offer
    chosen.push(key);
  };
  for ( const key of preferenceKeys(req, profile, available) ) push(key);
  for ( const o of available ) push(o.key);

  if ( !req.isExpertise ) for ( const k of chosen ) if ( isSkill(k) ) taken.add(k);
  return chosen;
}

/** The profile's preferences for one requirement, resolved to actual option keys, in order. */
function preferenceKeys(req, profile, options) {
  const byLabel = name => options.find(o => String(o.label ?? "").toLowerCase() === String(name).toLowerCase());

  // A species offering a size choice: Medium is the classic default.
  if ( req.type === "Size" ) return options.some(o => o.key === "med") ? ["med"] : [];

  // A granted spell's casting ability: the resolver already flags the class's own as recommended.
  if ( req.type === "SpellAbility" ) return options.filter(o => o.recommended).map(o => o.key);

  // Choose-a-feature/feat pools (origin feats, fighting styles, invocations): by name.
  if ( req.type === "ItemChoice" ) {
    return [...(profile.features ?? []), ...FEATURE_PREFERENCES]
      .map(name => byLabel(name)?.key).filter(Boolean);
  }

  if ( req.type !== "Trait" ) return [];
  if ( req.isExpertise ) return (profile.expertise ?? profile.skills ?? []).map(c => `skills:${c}`);

  // Plain trait pools are recognised by their option keys: skills match by exact code, weapon
  // and tool preferences by the key's last segment (e.g. "greataxe" ↔ "weapon:mar:greataxe").
  const first = String(options[0]?.key ?? "");
  const bySuffix = prefs => (prefs ?? [])
    .map(p => options.find(o => String(o.key).split(":").pop() === p)?.key ?? byLabel(p)?.key)
    .filter(Boolean);
  if ( first.startsWith("skills:") ) return (profile.skills ?? []).map(c => `skills:${c}`);
  if ( first.startsWith("weapon:") ) return bySuffix(profile.masteries);
  if ( first.startsWith("tool:") ) return bySuffix(profile.tools);
  return [];
}

/* -------------------------------------------- */
/*  Spells                                      */
/* -------------------------------------------- */

/**
 * Pick up to `max` spells from a pool: named preferences first (case-insensitive), then the
 * top of the (name-sorted) pool. Returned in the Spells step's pick shape.
 * @param {object[]} pool        Spell cards from the spell source.
 * @param {string[]} [names]     Preferred spell names, in order.
 * @param {number} max
 * @returns {{uuid: string, id: string, name: string, img: string, level: number}[]}
 */
export function pickSpells(pool, names = [], max = 0) {
  const picks = [];
  const seen = new Set();
  const add = s => {
    if ( !s || seen.has(s.uuid) || picks.length >= max ) return;
    seen.add(s.uuid);
    picks.push({ uuid: s.uuid, id: s.id, name: s.name, img: s.img, level: s.level });
  };
  for ( const name of names ?? [] ) {
    add(pool.find(s => s.name?.toLowerCase() === String(name).toLowerCase()));
  }
  for ( const s of pool ) add(s);
  return picks;
}

/**
 * Fill every Magic Initiate-style grant's picks the way the Feat Spells step would: choose a
 * list (the class-compatible one where offered), a casting ability (the class's own where
 * offered), and the suggested spells for that list — never re-learning a spell the character
 * already knows from the class picks or an earlier grant.
 */
async function fillFeatSpells(state, source, spells, profile, classDoc) {
  state.featSpellCache = await resolveFeatSpells(state, source);
  if ( !state.featSpellCache.length ) return;

  const known = new Set([...state.selectedCantrips, ...state.selectedSpells].map(s => s.uuid));
  const classAbility = classDoc?.system?.spellcasting?.ability || null;

  for ( const grant of state.featSpellCache ) {
    const list = grant.classList.length === 1
      ? grant.classList[0]
      : (grant.classList.includes(profile.miList) ? profile.miList : grant.classList[0]);
    const ability = grant.abilityKeys.length === 1
      ? grant.abilityKeys[0]
      : (grant.abilityKeys.includes(classAbility) ? classAbility : grant.abilityKeys[0]);
    if ( !list ) continue;

    const { cantrips, level1 } = await spells.forSpellList(list, Math.max(1, grant.spellLevel));
    const suggestions = MI_SPELL_SUGGESTIONS[list] ?? {};
    const pickUuids = (pool, names, max) => {
      const out = [];
      const add = s => {
        if ( s && !known.has(s.uuid) && out.length < max ) { known.add(s.uuid); out.push(s.uuid); }
      };
      for ( const n of names ?? [] ) add(pool.find(x => x.name?.toLowerCase() === String(n).toLowerCase()));
      for ( const s of pool ) add(s);
      return out;
    };

    state.featSpells[grant.key] = {
      list,
      ability,
      cantrips: pickUuids(cantrips ?? [], suggestions.cantrips, grant.cantripCount),
      spells: pickUuids(level1 ?? [], suggestions.spells, grant.spellCount)
    };
  }
}

/* -------------------------------------------- */
/*  Generic profile                             */
/* -------------------------------------------- */

/**
 * A minimal profile for a class the table doesn't know (homebrew, 2014 content): its own
 * `primaryAbility` first, then a sensible generic order. No skill/spell preferences — the
 * engine's deterministic backfill covers those.
 * @param {string} classUuid
 * @returns {Promise<object>}
 */
async function genericProfile(classUuid) {
  const doc = await fromUuid(classUuid).catch(() => null);
  const primaries = Array.from(
    doc?.system?.primaryAbility?.value ?? doc?._source?.system?.primaryAbility?.value ?? []
  ).filter(k => ABILITIES.includes(k));
  const abilities = [...primaries];
  for ( const k of ["con", "dex", "wis", "int", "cha", "str"] ) {
    if ( !abilities.includes(k) ) abilities.push(k);
  }
  return { abilities, backgrounds: [], skills: [] };
}
