import { t, log } from "../../config.mjs";
import { atLevel, advancementHint } from "../levelup-state.mjs";
import { choiceBlurb, findRestrictedItems, evalItemPrereq, groupRecommended } from "../../data/choice-resolver.mjs";

/**
 * Feature choices — the `ItemChoice` advancements a level grants (a Fighting Style, a Maneuver,
 * a Metamagic option, …). Each decision is a single selectable list. Picks apply straight to the
 * driver's clone via the advancement's own grant/ungrant, so Review and the committed actor
 * reflect exactly what is shown here.
 *
 * When the level allows replacement and the character already owns a pick, that pick appears in
 * the same list shown as selected: unticking it marks it for replacement (freeing a slot so the
 * other options enable), and ticking a different one swaps it in.
 */

/**
 * Build the unified option list for one decision: the configured pool, with any already-owned
 * pick folded in (and any owned pick that isn't in the pool appended), each flagged as a normal
 * choice or an owned/replaceable one.
 */
/**
 * The option entries for a **spell**-type ItemChoice, whose pickable spells are a named class spell
 * list rather than an authored pool — a Paladin's Blessed Warrior ("learn two Cleric cantrips"), a
 * Ranger's Druidic Warrior, a Magic Initiate variant. The native flow leaves this pool empty and
 * sends the player to the compendium browser instead (filtered by spell list + level), so building
 * the grid ourselves is what keeps the decision inside the wizard.
 *
 * `restriction.list` names the list(s) as `class:<id>`; `restriction.level` fixes the spell level —
 * 0 for cantrips, 1 for first-level spells, and on up: {@link SpellSource#forSpellList} indexes the
 * list by level, so a feature offering a choice of 2nd-level Cleric spells draws from the same
 * place a Blessed Warrior does. Anything the system allows that *isn't* a level ("available", or a
 * blank) has no bucket to draw from, so it yields nothing here and the block falls back to whatever
 * the authored pool and drop-scan provide.
 * @param {object} cfg                                          The advancement configuration.
 * @param {import("../../data/spell-source.mjs").SpellSource} spells
 * @returns {Promise<Map<string, {name: string, img: string}>>}  uuid -> option metadata.
 */
async function spellListOptions(cfg, spells) {
  const out = new Map();
  const raw = cfg.restriction?.level;
  const level = Number(raw);
  const lists = Array.from(cfg.restriction?.list ?? []).map(l => String(l).replace(/^class:/, ""));
  if ( !lists.length ) return out;
  if ( !spells ) {
    log("spell choice: no spell source on this session, so its class list can't be offered");
    return out;
  }
  if ( !Number.isInteger(level) || (level < 0) || (level > 9) ) {
    log(`spell choice: no list pool for restriction level "${raw}"`);
    return out;
  }
  // Fetch the level-≤1 payload whenever the restriction allows it, and pick the bucket out of it:
  // that is the key the session warm-up already fills for the Magic Initiate lists
  // (cleric/druid/wizard), so a Blessed Warrior or Druidic Warrior pick reads a warm cache instead
  // of opening a second, level-0-only one. Only a choice above 1st level pays for its own load.
  const fetchLevel = Math.max(1, level);
  for ( const listId of lists ) {
    try {
      const { byLevel } = await spells.forSpellList(listId, fetchLevel);
      for ( const spell of (byLevel?.[level] ?? []) ) {
        if ( spell?.uuid ) out.set(spell.uuid, { name: spell.name, img: spell.img });
      }
    } catch ( err ) {
      log(`spell choice: failed to load the "${listId}" list`, err);
    }
  }
  return out;
}

async function buildOptions(record, st, spells) {
  const cfg = record.advancement.configuration ?? {};
  const pool = Array.from(cfg.pool ?? []).map(p => p.uuid ?? p);
  const priorByUuid = new Map(st.priorEntries.map(e => [e.uuid, e]));
  const extraPriors = st.priorEntries.filter(e => !pool.includes(e.uuid)).map(e => e.uuid);

  // Feature level for the prerequisite gate below: the advancement's own level, falling back to the
  // character's total level for a class-linked granted feature whose ItemChoice keys at level 0
  // (otherwise the gate would filter out every option).
  const featureLevel = record.level || record.advancement.actor?.system?.details?.level || null;

  // Feat/feature identifiers the clone already holds, matched against a feat's item prerequisites
  // (a Warlock's Improved Pact Weapon needing Pact of the Blade). The map is keyed by identifier
  // slug, exactly what `evalItemPrereq` compares against.
  const owned = new Set(record.advancement.actor?.identifiedItems?.keys() ?? []);

  // Drop-restricted choices (e.g. the Artificer's "Replicate Magic Item") carry an empty static
  // pool; their options come from a compendium scan matching the restriction, gated to items the
  // character qualifies for by prerequisite level — mirroring the native ItemChoice flow. We carry
  // the scanned name/img (and item prerequisites) so those items don't each need a separate
  // `fromUuid` load.
  const meta = new Map();
  if ( cfg.allowDrops && (cfg.restriction?.subtype || cfg.restriction?.type) ) {
    for ( const opt of await findRestrictedItems(cfg, featureLevel) ) {
      meta.set(opt.uuid, { name: opt.label, img: opt.img, prereqItems: opt.prereqItems });
    }
  }
  // A spell choice draws on a class spell list, not the (empty) authored pool. Same `meta` channel:
  // the entries carry their own name/img, so no option needs a separate `fromUuid`.
  if ( cfg.type === "spell" ) {
    for ( const [uuid, entry] of await spellListOptions(cfg, spells) ) meta.set(uuid, entry);
  }

  const uuids = [...new Set([...pool, ...extraPriors, ...meta.keys()])];
  const docs = await Promise.all(uuids.map(u => meta.has(u) ? meta.get(u) : fromUuid(u).catch(() => null)));
  const options = [];
  // Collapse the same feature carried under different UUIDs (an invocation shared across edition
  // packs) to one card. Owned/prior picks always show and reserve their name; a fresh option whose
  // name is already taken is dropped. `findRestrictedItems` already name-dedupes the scanned pool,
  // so this guards the authored pool vs. scan overlap.
  const seenNames = new Set();
  const nameKey = n => (n ?? "").trim().toLowerCase();
  docs.forEach((doc, i) => {
    if ( !doc ) return;
    const uuid = uuids[i];
    const prior = priorByUuid.get(uuid);
    if ( prior ) {
      seenNames.add(nameKey(doc.name));
      // Owned: selected unless it's currently marked for replacement. Never disabled — unticking
      // it is how the player frees the slot to swap.
      options.push({ uuid, name: doc.name, img: doc.img, owned: true, originalId: prior.id, selected: st.replacing !== prior.id });
    } else {
      // Prerequisite gate for a fresh (non-owned) option. Owned picks are folded in above and never
      // gated. A static-pool option is gated by both its level and its item prerequisites; a scanned
      // (meta) option is already level-gated by the scan, so only its item prerequisites remain. An
      // option whose item prerequisite the build satisfies is flagged `recommended` — the build
      // unlocked it, so it earns the "recommended" panel.
      const prereq = meta.has(uuid)
        ? { items: doc.prereqItems }
        : (doc.system?.prerequisites ?? {});
      if ( !meta.has(uuid) && featureLevel != null && Number(prereq.level ?? 0) > featureLevel ) return;
      const { hasReq, met } = evalItemPrereq(prereq.items, owned);
      if ( hasReq && !met ) return;
      const nk = nameKey(doc.name);
      if ( seenNames.has(nk) ) return;   // a same-named copy already listed (another edition pack)
      seenNames.add(nk);
      const selected = st.selected.has(uuid);
      // Already held from another source (e.g. the base Fighting Style when picking a Champion's
      // extra one): show it enumerated but as taken, not a fresh pick — it can't be chosen twice.
      const taken = !selected && !!st.ownedElsewhere?.has(uuid);
      options.push({ uuid, name: doc.name, img: doc.img, owned: false, selected, taken,
        disabled: taken || (!selected && st.full), recommended: hasReq && met });
    }
  });
  // A scanned pool has no meaningful authored order, so sort it alphabetically for scanability;
  // a small static pool (fighting styles, maneuvers) keeps its authored order.
  if ( meta.size ) options.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  return options;
}

export const choicesStep = {
  id: "choices",
  icon: "fa-solid fa-list-check",
  labelKey: "levelup.step.choices.label",
  template: "levelup/choices",

  isCompleteAt(state, level) {
    // `exhausted` is the escape hatch for a quota the pool can no longer fill ("pick 2" with only
    // one option left because the rest are already owned): refreshed by sectionsAt each render —
    // the shell builds the active screen before it reads these flags — it counts as settled.
    return atLevel(state.choiceSteps, level).every(r => state.driver.choiceState(r).full || r.exhausted);
  },

  async sectionsAt({ state, driver, spells }, level) {
    const records = atLevel(state.choiceSteps, level);
    if ( !records.length ) return null;
    // One block per decision (see trait-step.mjs for why): each feature pick keeps its own
    // collapsible panel, titled and counted in its header.
    const blocks = [];
    for ( const record of records ) {
      const st = driver.choiceState(record);
      const hasOwned = st.replaceable && st.priorEntries.length > 0;
      const options = await buildOptions(record, st, spells);
      record.exhausted = !st.full && !options.some(o => !o.owned && !o.selected && !o.disabled);
      const section = {
        index: state.choiceSteps.indexOf(record),
        title: record.advancement.title || t("levelup.step.choices.choose"),
        count: t("levelup.step.choices.count", { current: st.current, max: st.max }),
        complete: st.full || record.exhausted,
        // The authored description when there is one; otherwise the creator's generated blurb, so
        // every decision reads with a sentence telling the player what the pick is.
        hint: (await advancementHint(record)) || choiceBlurb({ type: "ItemChoice", count: st.max }),
        replaceHint: hasOwned ? t("levelup.step.choices.replaceHint") : "",
        options,
        // A "Recommended" + "Other" split when the build unlocked any option (an item prerequisite
        // it satisfies, e.g. an invocation needing Pact of the Blade); null leaves the flat grid.
        groups: groupRecommended(options),
        // The block header carries the title and count, so the body never repeats them.
        collapsed: true
      };
      blocks.push({
        key: record.advancement.id ?? String(section.index),
        blockLabel: section.title,
        blockStatus: section.count,
        complete: section.complete,
        // A large pool (a long spell/feature list) packs into smaller cards; a short pick stays roomy.
        density: options.length >= 9 ? "compact" : "standard",
        sections: [section]
      });
    }
    return blocks;
  },

  async handle(action, el, { state, driver }) {
    const record = state.choiceSteps[Number(el.dataset.index)];
    if ( !record ) return;
    if ( action === "choiceToggle" && el.dataset.uuid ) await driver.toggleChoice(record, el.dataset.uuid);
    else if ( action === "choiceReplace" && el.dataset.original ) await driver.toggleReplacement(record, el.dataset.original);
  }
};
