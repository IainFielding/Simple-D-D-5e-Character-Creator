import { t } from "../config.mjs";
import { advancementArray, advancementTitle} from "../data/advancement-util.mjs";
import { MAGIC_INITIATE_LISTS } from "../data/spell-source.mjs";

/**
 * The Feat Spells step: the spell picks a feat defers to the player — the Magic Initiate shape and
 * its single-class variants. It replicates the creation Spells page (a filtered spell browser with a
 * running tally), scoped to the class list the feat draws from.
 *
 * Detection is deliberately **not** advancement-based. The dnd5e *system* ships Magic Initiate with
 * spell `ItemChoice` advancements, but the D&D Player's Handbook module ships it with **no
 * advancements at all** (its own text says "the spells have to be added manually"). So we detect it
 * by identity — an origin that grants (or lets you pick) a feat whose identifier/name is Magic
 * Initiate — and read the spell list from the granting background's own description, e.g. Acolyte's
 * "Magic Initiate (Cleric)". The feat's fixed shape (2 cantrips + 1 level-1 spell, cast off
 * Int/Wis/Cha) is applied by {@link module:build/actor-assembler} creating the spells directly.
 *
 * Where the feat *does* carry spell `ItemChoice` advancements (the system copy), we read the counts,
 * list, and abilities from them instead — so both forms funnel through the same step and apply path.
 */

// Key term used throughout this file: a "grant" is our normalised description of one feat's spell
// choice — `{ key, source, featUuid, featName, classList, abilityKeys, cantripCount, spellCount,
// spellLevel, mode }`. resolveFeatSpells() produces one per applicable feat; every helper below
// takes a grant plus the state and reads/writes the player's picks in state.featSpells[grant.key].

/** Magic Initiate's identity and fixed shape, used when the feat carries no advancement data. */
const MI_IDENTIFIER = /magic-initiate/i;
const MI_NAME = /magic initiate/i;
const MI_DEFAULTS = { cantripCount: 2, spellCount: 1, spellLevel: 1, abilityKeys: ["int", "wis", "cha"] };
const CLASS_LISTS = MAGIC_INITIATE_LISTS;

/** The spellcasting ability each Magic Initiate class casts with — used to lock the casting ability
 *  when the class is fixed (a Wizard Magic Initiate always casts off Intelligence, not a choice). */
const MI_CLASS_ABILITY = { cleric: "wis", druid: "wis", wizard: "int" };

/**
 * How many of the feats' spells are chosen, against how many they ask for — the one tally the rail
 * summary and the blocked-Next hint both quote, so they can never disagree about what is left.
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @returns {{picked: number, total: number}}
 */
function spellCounts(state) {
  let picked = 0, total = 0;
  for ( const g of state.featSpellCache ?? [] ) {
    const b = state.featSpells[g.key];
    picked += (b?.cantrips.length ?? 0) + (b?.spells.length ?? 0);
    total += g.cantripCount + g.spellCount;
  }
  return { picked, total };
}

export const featSpellsStep = {
  id: "featSpells",
  icon: "fa-solid fa-hand-sparkles",
  labelKey: "step.featSpells.label",
  template: "steps/feat-spells",

  // Unlike the always-present steps, this one is dropped from the rail entirely (not just greyed)
  // until an origin grants a Magic Initiate-style feat — the shell reads this flag to hide/skip it.
  hideWhenInapplicable: true,

  // Applies once an origin grants a Magic Initiate-style feat.
  applicable(state) {
    return (state.featSpellCache ?? []).length > 0;
  },

  isComplete(state) {
    const grants = state.featSpellCache ?? [];
    if ( !grants.length ) return true;            // nothing to choose — never blocks the build
    return grants.every(g => grantComplete(state, g));
  },

  /** Why Next is blocked: how many feat spells are still to be chosen. */
  incompleteHint(state) {
    const { picked, total } = spellCounts(state);
    const remain = Math.max(0, total - picked);
    return remain ? t("step.featSpells.hint", { count: remain }) : null;
  },

  /** Rail summary: how many of the feats' spells are chosen in total. */
  summary(state) {
    const { picked, total } = spellCounts(state);
    return total ? t("step.featSpells.picked", { count: picked, total }) : "";
  },

  async handle(action, el, { state }) {
    if ( action === "switch-feat" ) {
      state.activeFeatKey = el.dataset.key;
      state.focusedFeatSpellUuid = null;
      state.featSpellTab = "cantrips";
      return;
    }
    if ( action === "choose-list" ) return chooseList(el, state);
    if ( action === "choose-ability" ) return chooseAbility(el, state);
    if ( action === "spell-tab" ) {
      state.featSpellTab = el.dataset.tab;
      state.focusedFeatSpellUuid = null;
      return;
    }
    if ( action === "focus-spell" ) {
      state.focusedFeatSpellUuid = el.dataset.uuid;
      return;
    }
    if ( action === "pick-spell" ) return pickSpell(el, state);
  },

  async context({ state, source, spells }) {
    // Refresh the grant cache so applicable/complete (which read it) and this render agree.
    const grants = await resolveFeatSpells(state, source);
    state.featSpellCache = grants;
    if ( !grants.length ) return { applicable: false, hint: t("step.featSpells.none") };

    // Resolve the active grant, surviving re-renders; a stale/absent key falls back to the first.
    if ( !grants.some(g => g.key === state.activeFeatKey) ) state.activeFeatKey = grants[0].key;
    const grant = grants.find(g => g.key === state.activeFeatKey);

    const cards = grants.map(g => ({
      key: g.key, featName: g.featName, featImg: g.featImg,
      active: g.key === grant.key, complete: grantComplete(state, g)
    }));

    // The recommended casting ability is the chosen class's — so feat magic can align with the class.
    const classDoc = state.classUuid ? await fromUuid(state.classUuid).catch(() => null) : null;
    const classAbility = classDoc?.system?.spellcasting?.ability || null;

    const listId = grantList(state, grant);
    const ctx = {
      applicable: true,
      grants: cards,
      hasMultipleGrants: cards.length > 1,
      featName: grant.featName,
      featImg: grant.featImg,
      intro: t("step.featSpells.intro", { feat: grant.featName }),

      setupNeeded: grant.classList.length > 1 || grant.abilityKeys.length > 1,
      showListPicker: grant.classList.length > 1,
      listOptions: grant.classList.map(id => {
        const card = source.classes().find(c => c.identifier === id);
        return { id, label: card?.name ?? capitalize(id), img: card?.img ?? "icons/svg/book.svg", selected: id === listId };
      }),
      listChosen: !!listId,

      showAbilityPicker: grant.abilityKeys.length > 1,
      abilityChosen: !!grantAbility(state, grant),
      abilityOptions: grant.abilityKeys.map(key => ({
        key,
        label: CONFIG.DND5E.abilities?.[key]?.label ?? key.toUpperCase(),
        selected: key === grantAbility(state, grant),
        recommended: key === classAbility
      })),
      abilityRecommendTip: classAbility ? t("step.featSpells.recommendAbility", { class: classDoc?.name ?? "" }) : ""
    };

    if ( !listId ) return { ...ctx, hasList: false };
    const owned = await knownSpellUuids(state, grant.key);
    return { ...ctx, hasList: true, ...await spellBrowser(state, grant, listId, spells, owned) };
  }
};

/* -------------------------------------------- */
/*  Detection                                   */
/* -------------------------------------------- */

/**
 * Scan the selected origins for granted (or player-picked) Magic Initiate-style feats and turn each
 * into a spell-choice *grant*. Detection is by feat identity (not advancement data), so it catches
 * the Player's Handbook module's advancement-less feat as well as the system's advancement-carrying
 * one. Keyed `${source}:${featUuid}` so a feat grantable from two origins stays distinct.
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {import("../data/source-index.mjs").SourceIndex} _source Unused; kept for call-site parity.
 * @returns {Promise<object[]>}
 */
export async function resolveFeatSpells(state, _source) {
  const grants = [];
  const seen = new Set();
  for ( const [key, field] of [["class", "classUuid"], ["background", "backgroundUuid"], ["species", "speciesUuid"]] ) {
    const originUuid = state[field];
    if ( !originUuid ) continue;
    const originDoc = await fromUuid(originUuid).catch(() => null);
    if ( !originDoc ) continue;
    const sel = state.advChoices?.[key] ?? {};
    for ( const featUuid of grantedFeatUuids(originDoc, sel) ) {
      const gk = `${key}:${featUuid}`;
      if ( seen.has(gk) ) continue;
      const featDoc = await fromUuid(featUuid).catch(() => null);
      if ( !featDoc || featDoc.type !== "feat" ) continue;
      const grant = magicInitiateGrant(featDoc, originDoc, key, featUuid);
      if ( grant ) { seen.add(gk); grants.push(grant); }
    }
  }
  return grants;
}

/** UUIDs of the feats an origin grants outright or lets the player pick, at level ≤ 1. */
function grantedFeatUuids(doc, sel) {
  const out = [];
  for ( const adv of advancementArray(doc) ) {
    if ( (adv.level ?? 0) > 1 ) continue;
    if ( adv.type === "ItemGrant" ) {
      for ( const ref of Array.from(adv.configuration?.items ?? []) ) {
        const uuid = typeof ref === "string" ? ref : ref?.uuid;
        if ( uuid ) out.push(uuid);
      }
    } else if ( adv.type === "ItemChoice" ) {
      for ( const p of Array.from(sel[adv._id] ?? []) ) {
        const uuid = typeof p === "string" ? p : p?.uuid;
        if ( uuid ) out.push(uuid);
      }
    }
  }
  return out;
}

/** The feat's spell-type `ItemChoice` advancements (the system copy carries these; the PHB one doesn't). */
function spellItemChoiceAdvs(featDoc) {
  return advancementArray(featDoc).filter(a =>
    a.type === "ItemChoice" && (a.level ?? 0) <= 1 && a.configuration?.type === "spell");
}

/**
 * Build a grant for a Magic Initiate-style feat, or null if it isn't one. When the feat carries
 * spell advancements, its parameters are read from them; otherwise Magic Initiate's fixed shape is
 * assumed and the class list is parsed from the granting origin's (then the feat's) description.
 */
function magicInitiateGrant(featDoc, originDoc, sourceKey, featUuid) {
  const identifier = featDoc.system?.identifier ?? "";
  const spellAdvs = spellItemChoiceAdvs(featDoc);
  const isMI = MI_IDENTIFIER.test(identifier) || MI_NAME.test(featDoc.name ?? "") || spellAdvs.length > 0;
  if ( !isMI ) return null;

  const base = {
    key: `${sourceKey}:${featUuid}`, source: sourceKey, featUuid,
    featName: featDoc.name, featImg: featDoc.img || "icons/svg/upgrade.svg",
    featIdentifier: identifier || "magic-initiate"
  };

  if ( spellAdvs.length ) {
    // Advancement-carrying (system) feat — read the shape from its own ItemChoices.
    const classList = new Set(), abilityKeys = new Set();
    let cantripCount = 0, spellCount = 0, spellLevel = 1;
    // The advancement's own spell configuration, kept per slot type so the assembler can hand the
    // created spell to the system's `applySpellChanges` rather than re-deriving the casting setup.
    let cantripSpellConfig = null, spellSpellConfig = null;
    for ( const adv of spellAdvs ) {
      const cfg = adv.configuration;
      const choiceLevel = Object.keys(cfg.choices ?? {}).map(Number).filter(l => l <= 1).sort((a, b) => a - b)[0] ?? 0;
      const count = Number(cfg.choices?.[choiceLevel]?.count ?? cfg.choices?.[choiceLevel] ?? 0);
      const restrictLevel = Number(cfg.restriction?.level ?? 0);
      if ( restrictLevel === 0 ) { cantripCount = count; cantripSpellConfig = cfg.spell ?? null; }
      else { spellCount = count; spellLevel = restrictLevel; spellSpellConfig = cfg.spell ?? null; }
      for ( const c of Array.from(cfg.restriction?.list ?? []) ) classList.add(String(c).replace(/^class:/, ""));
      for ( const a of Array.from(cfg.spell?.ability ?? []) ) abilityKeys.add(a);
    }
    // The 2024 generic Magic Initiate feat allows cleric/druid/wizard, but a background grants a
    // *specific* variant (Sage → Wizard), naming the class in its prose. Honour that so the player
    // isn't asked to re-pick a list the background already fixed.
    const specified = originSpecifiedClasses(originDoc);
    const narrowed = specified.length ? [...classList].filter(c => specified.includes(c)) : [...classList];
    const finalList = narrowed.length ? narrowed : [...classList];
    const allowed = abilityKeys.size ? [...abilityKeys] : [...MI_DEFAULTS.abilityKeys];
    const locked = lockedAbility(finalList, allowed);
    return {
      ...base, mode: "advancement",
      classList: finalList,
      abilityKeys: locked ? [locked] : allowed,
      cantripCount, spellCount, spellLevel,
      cantripSpellConfig, spellSpellConfig
    };
  }

  // Advancement-less (PHB) feat — fixed Magic Initiate shape, class list from the descriptions.
  const classList = parseClassList(originDoc, featDoc);
  const locked = lockedAbility(classList, MI_DEFAULTS.abilityKeys);
  return {
    ...base, mode: "manual",
    classList,
    abilityKeys: locked ? [locked] : [...MI_DEFAULTS.abilityKeys],
    cantripCount: MI_DEFAULTS.cantripCount, spellCount: MI_DEFAULTS.spellCount, spellLevel: MI_DEFAULTS.spellLevel
  };
}

/**
 * The casting ability to lock a Magic Initiate to when its class is fixed to a single one — the
 * class's own spellcasting ability (Wizard → Int, Cleric/Druid → Wis), provided the feat permits
 * it. Returns null when the class list is still open (leave the player the ability picker) or the
 * class isn't one we map.
 * @param {string[]} classList   The (possibly narrowed) class list.
 * @param {string[]} allowed     The abilities the feat allows.
 * @returns {string|null}
 */
export function lockedAbility(classList, allowed) {
  if ( classList.length !== 1 ) return null;
  const ability = MI_CLASS_ABILITY[classList[0]];
  if ( !ability ) return null;
  return (!allowed?.length || allowed.includes(ability)) ? ability : null;
}

/** The class list a Magic Initiate feat draws from: the class the origin names (in its description
 *  parenthetical or a granting advancement's hint), then the feat's named lists, defaulting to all
 *  three. */
function parseClassList(originDoc, featDoc) {
  const specified = originSpecifiedClasses(originDoc);
  if ( specified.length ) return specified;
  const named = classesNamed(featDoc?.system?.description?.value ?? "");
  return named.length ? named : [...CLASS_LISTS];
}

const stripHtml = h => String(h).replace(/<[^>]+>/g, " ").replace(/[{}]/g, " ");

/**
 * The class(es) an origin explicitly ties its Magic Initiate to. The 2024 backgrounds each grant a
 * specific variant (Sage → Wizard) but reference the *generic* Magic Initiate feat, stating the
 * class only in prose — its description parenthetical ("Magic Initiate (Wizard)") and/or the
 * granting advancement's hint. We scan both. Returns the named classes (a de-duplicated subset of
 * cleric/druid/wizard), or [] when the origin doesn't pin one down.
 */
export function originSpecifiedClasses(originDoc) {
  const texts = [originDoc?.system?.description?.value ?? ""];
  for ( const adv of advancementArray(originDoc) ) {
    if ( adv.hint ) texts.push(adv.hint);
    const advName = advancementTitle(adv);
    if ( advName ) texts.push(advName);
  }
  const found = new Set();
  for ( const text of texts ) {
    for ( const m of stripHtml(text).matchAll(/magic initiate\s*\((cleric|druid|wizard)\)/ig) ) {
      found.add(m[1].toLowerCase());
    }
  }
  return [...found];
}
/** Every class list the text names (base Magic Initiate names all three). */
function classesNamed(html) {
  const text = stripHtml(html);
  return CLASS_LISTS.filter(c => new RegExp(`\\b${c}\\b`, "i").test(text));
}

/**
 * The spells an origin grants outright at level ≤ 1 — a species handing out a cantrip, a class
 * granting a spell, a 2014 subclass's domain spells. Returned as lightweight cards for the review
 * summary, the "already known" marking on the feat browser, and the Spells step's own pool filter.
 * Shared with [review-step.mjs](scripts/steps/review-step.mjs).
 *
 * The walk recurses, because the grant is often not on the origin itself. A 2014 Cleric picks its
 * subclass during creation and the domain spells hang off *that*; other grants arrive through a
 * feature the origin granted first. Walking only the origin's own advancements missed both, which
 * left the domain spells absent from the Review and — worse — still offered on the Spells step, so
 * the player could pick a spell they were about to be given.
 *
 * `sel` carries the player's recorded picks for this origin (`state.advChoices[source]`), which is
 * the only way to know *which* subclass was chosen; without it the subclass branch is simply not
 * taken, and the walk degrades to what it did before.
 *
 * @param {Item5e|object} doc
 * @param {object} [sel]   The origin's recorded advancement picks, keyed by advancement id.
 * @returns {Promise<{uuid:string, name:string, img:string, level:number}[]>}
 */
export async function grantedSpellCards(doc, sel = {}, seen = new Set(), depth = 0) {
  const out = [];
  if ( !doc || depth > 3 ) return out;
  for ( const adv of advancementArray(doc) ) {
    if ( (adv.level ?? 0) > 1 ) continue;
    let refs = null;
    if ( adv.type === "ItemGrant" ) {
      refs = Array.from(adv.configuration?.items ?? []).map(r => typeof r === "string" ? r : r?.uuid);
    } else if ( adv.type === "Subclass" ) {
      // 2014-rules Clerics, Sorcerers and Warlocks choose at level 1, so the subclass is part of the
      // level-≤1 build and its grants are creation grants. 2024 classes take theirs at level 3,
      // where the guard above has already skipped this.
      refs = Array.from(sel?.[adv._id] ?? []).map(p => typeof p === "string" ? p : p?.uuid);
    } else continue;

    for ( const uuid of refs.filter(Boolean) ) {
      if ( seen.has(uuid) ) continue;
      seen.add(uuid);
      const d = await fromUuid(uuid).catch(() => null);
      if ( !d ) continue;
      if ( d.type === "spell" ) {
        out.push({ uuid, name: d.name, img: d.img || "icons/svg/daze.svg", level: d.system?.level ?? 0 });
      } else if ( advancementArray(d).length ) {
        out.push(...await grantedSpellCards(d, sel, seen, depth + 1));
      }
    }
  }
  return out;
}

/** Which `state.advChoices` bucket holds the picks for each origin uuid field. */
const ORIGIN_FIELDS = [["classUuid", "class"], ["backgroundUuid", "background"], ["speciesUuid", "species"]];

/**
 * Every spell the character's origins hand out at level ≤ 1 — across class (and its level-1
 * subclass), background and species — as cards.
 *
 * Serves three callers: the feat browser marks these as already known, the Spells step keeps them
 * out of the pool (picking one produced two documents on the finished character, only one of which
 * counted toward preparation, so the pick was silently wasted) — and, because hiding them outright
 * leaves a Cleric wondering where their domain spells went, the Spells step also *lists* them for
 * reference beside the picks.
 *
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @returns {Promise<{uuid:string, name:string, img:string, level:number}[]>}
 */
export async function originGrantedSpellCards(state) {
  const cards = [];
  for ( const [field, source] of ORIGIN_FIELDS ) {
    const uuid = state[field];
    if ( !uuid ) continue;
    const doc = await fromUuid(uuid).catch(() => null);
    if ( !doc ) continue;
    cards.push(...await grantedSpellCards(doc, state.advChoices?.[source] ?? {}));
  }
  return cards;
}

/** The same set, by uuid, for callers that only need the membership test. */
export async function originGrantedSpellUuids(state) {
  return new Set((await originGrantedSpellCards(state)).map(card => card.uuid));
}

/**
 * The spell uuids the character already knows from other sources, so the feat browser can show them
 * as already chosen rather than letting the player waste a pick re-learning one: the class Spells
 * step picks, any origin-granted spells, and the spells chosen for the character's *other* feats.
 */
async function knownSpellUuids(state, currentGrantKey) {
  const set = await originGrantedSpellUuids(state);
  for ( const s of state.selectedCantrips ) set.add(s.uuid);
  for ( const s of state.selectedSpells ) set.add(s.uuid);
  for ( const [key, b] of Object.entries(state.featSpells) ) {
    if ( key === currentGrantKey ) continue;
    for ( const u of [...(b.cantrips ?? []), ...(b.spells ?? [])] ) set.add(u);
  }
  return set;
}

/* -------------------------------------------- */
/*  Pick state                                  */
/* -------------------------------------------- */

/** The mutable pick bucket for a grant, created on first use. */
function bucket(state, grant) {
  return (state.featSpells[grant.key] ??= { list: null, ability: null, cantrips: [], spells: [] });
}

/** The chosen list id — implied when the feat names a single class, else the player's pick. */
function grantList(state, grant) {
  if ( grant.classList.length === 1 ) return grant.classList[0];
  return state.featSpells[grant.key]?.list ?? null;
}

/** The chosen casting ability (implied when the feat fixes a single one). */
function grantAbility(state, grant) {
  if ( grant.abilityKeys.length === 1 ) return grant.abilityKeys[0];
  return state.featSpells[grant.key]?.ability ?? null;
}

/** Picked spell uuids for a grant's cantrip (0) or spell (1) bucket. */
function picked(state, grant, spellLevel) {
  const b = state.featSpells[grant.key];
  if ( !b ) return [];
  return spellLevel === 0 ? b.cantrips : b.spells;
}

/** A grant is complete once its list, ability, and every cantrip/spell slot are chosen. */
function grantComplete(state, grant) {
  if ( !grantList(state, grant) ) return false;
  if ( grant.abilityKeys.length > 1 && !grantAbility(state, grant) ) return false;
  return picked(state, grant, 0).length >= grant.cantripCount
      && picked(state, grant, 1).length >= grant.spellCount;
}

/* -------------------------------------------- */
/*  Handlers                                    */
/* -------------------------------------------- */

/** The active grant from the cache, for a handler. */
function activeGrant(state) {
  const grants = state.featSpellCache ?? [];
  return grants.find(g => g.key === state.activeFeatKey) ?? grants[0] ?? null;
}

/** Pick a spell list; switching lists clears the now-invalid picks so nothing leaks across lists. */
function chooseList(el, state) {
  const grant = activeGrant(state);
  if ( !grant ) return;
  const b = bucket(state, grant);
  if ( b.list === el.dataset.id ) return;
  b.list = el.dataset.id;
  b.cantrips = [];
  b.spells = [];
  state.focusedFeatSpellUuid = null;
  state.featSpellTab = "cantrips";
}

/** Record the casting ability for the active grant. */
function chooseAbility(el, state) {
  const grant = activeGrant(state);
  if ( !grant ) return;
  bucket(state, grant).ability = el.dataset.ability;
}

/** Toggle a spell into/out of its bucket, capped at the feat's per-bucket count. */
function pickSpell(el, state) {
  const grant = activeGrant(state);
  if ( !grant ) return;
  const b = bucket(state, grant);
  const isCantrip = Number(el.dataset.level) === 0;
  const list = isCantrip ? b.cantrips : b.spells;
  const uuid = el.dataset.uuid;
  const idx = list.indexOf(uuid);
  if ( idx >= 0 ) { list.splice(idx, 1); return; }
  const max = isCantrip ? grant.cantripCount : grant.spellCount;
  if ( list.length >= max ) return;               // ignore the click once the bucket is full
  list.push(uuid);
}

/* -------------------------------------------- */
/*  Spell browser                               */
/* -------------------------------------------- */

/** Build the filtered spell-browser context for the active grant's chosen list. */
async function spellBrowser(state, grant, listId, spells, owned = new Set()) {
  const { cantrips, level1 } = await spells.forSpellList(listId, Math.max(1, grant.spellLevel));

  let tab = state.featSpellTab;
  if ( tab === "cantrips" && grant.cantripCount === 0 ) tab = "spells";
  if ( tab === "spells" && grant.spellCount === 0 ) tab = "cantrips";
  const isCantrips = tab === "cantrips";

  const pool = isCantrips ? cantrips : level1;
  const budget = isCantrips ? grant.cantripCount : grant.spellCount;
  const chosen = picked(state, grant, isCantrips ? 0 : 1);
  const chosenSet = new Set(chosen);
  const atLimit = chosen.length >= budget;

  const list = pool.map(s => {
    // A spell already known from the class Spells step or a granted origin can't be re-learnt here.
    const isOwned = owned.has(s.uuid) && !chosenSet.has(s.uuid);
    return {
      ...s,
      active: chosenSet.has(s.uuid),
      owned: isOwned,
      focused: state.focusedFeatSpellUuid === s.uuid,
      disabled: isOwned || (atLimit && !chosenSet.has(s.uuid))
    };
  });

  let focused = null;
  const focus = list.find(s => s.uuid === state.focusedFeatSpellUuid);
  if ( focus ) {
    focused = {
      ...focus,
      description: await spells.description(focus.uuid),
      source: await spells.sourceBook(focus.uuid)
    };
  }

  const levelOptions = [...new Set(list.filter(s => s.level > 0).map(s => s.level))]
    .sort((a, b) => a - b)
    .map(level => ({ value: level, label: t("levelup.step.spells.levelTag", { level }) }));
  const schoolOptions = [...new Set(list.map(s => s.school).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, game.i18n.lang))
    .map(school => ({ value: school, label: school }));

  const toChip = async uuids => Promise.all(uuids.map(async uuid => {
    const doc = await fromUuid(uuid).catch(() => null);
    return { uuid, name: doc?.name ?? "", img: doc?.img ?? "icons/svg/daze.svg" };
  }));
  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
  const selectedCantrips = (await toChip(picked(state, grant, 0))).sort(byName);
  const selectedSpells = (await toChip(picked(state, grant, 1))).sort(byName);

  return {
    hasCantrips: grant.cantripCount > 0,
    hasSpells: grant.spellCount > 0,
    isCantripsTab: isCantrips,
    isSpellsTab: !isCantrips,
    cantripCount: grant.cantripCount,
    spellCount: grant.spellCount,
    cantripHave: picked(state, grant, 0).length,
    spellHave: picked(state, grant, 1).length,
    cantripsFull: grant.cantripCount > 0 && picked(state, grant, 0).length >= grant.cantripCount,
    spellsFull: grant.spellCount > 0 && picked(state, grant, 1).length >= grant.spellCount,
    needLabel: t("levelup.step.spells.need", { count: Math.max(0, budget - chosen.length) }),
    atLimit,
    list,
    count: list.length,
    levelOptions,
    schoolOptions,
    focused,
    selectedCantrips,
    selectedSpells,
    hasSelected: selectedCantrips.length + selectedSpells.length > 0
  };
}

const capitalize = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
