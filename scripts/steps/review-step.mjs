import { ABILITIES, formatMod, storeConfig, t } from "../config.mjs";
import { cartTotalCp, formatCp } from "../data/store-source.mjs";
import { DETAIL_FIELDS, DETAIL_TEXT_FIELDS } from "./details-step.mjs";
import { advancementArray, advancementTitle} from "../data/advancement-util.mjs";
import { resolveChoices, traitChoiceTitle, traitKeyLabel } from "../data/choice-resolver.mjs";
import { resolveFeatSpells, grantedSpellCards } from "./feat-spells-step.mjs";
import { summarizeOption } from "../data/equipment-source.mjs";
import { pdfExportContext } from "../build/pdf-export.mjs";

/*
 * The Review step (the step module itself is at the bottom of the file). It's read-only: it gathers
 * everything the player has chosen — abilities, biography, and per-origin grants/picks/spells/gear —
 * into one summary for a final look before Create. Most of this file is small `review…` helper
 * functions, each building one slice of that summary; reviewStep.context() stitches them together.
 * Nothing here mutates state or writes to the actor.
 */

// The three origin sections, in display order: each carries the state field holding its
// chosen UUID, the section heading (kind) label, and the placeholder when nothing is picked.
const ORIGIN_META = [
  { key: "class", field: "classUuid", labelKey: "step.class.label", emptyKey: "step.review.noClass" },
  { key: "background", field: "backgroundUuid", labelKey: "step.background.label", emptyKey: "step.review.noBackground" },
  { key: "species", field: "speciesUuid", labelKey: "step.species.label", emptyKey: "step.review.noSpecies" }
];

/**
 * The tooltip behind an ability's bonus pill, naming where the increase came from — "+2 from
 * species". Both origins can in principle contribute (nothing in the data model forbids it, even
 * though no single edition does it), so a multi-source bonus lists each part.
 * @param {{total: number, sources: Array<{source: string, bonus: number}>}} delta
 * @returns {string}
 */
function bonusTip(delta) {
  return delta.sources
    .map(({ source, bonus }) => t(`step.review.bonusFrom.${source}`, { bonus }))
    .join(", ");
}

/**
 * The filled identity/biography rows for the summary — only fields the player
 * actually wrote, so empty fields don't clutter the review. Short fields render as
 * label/value tags; the longer text fields render as their own paragraphs.
 */
function reviewDetails(state) {
  const d = state.details;
  // Alignment leads, and is named explicitly: it has its own control on the Details step (a list
  // the GM can restrict, plus an "Other" box) so it is no longer part of DETAIL_FIELDS' plain-text
  // grid — but it is still a detail the player set, and the summary must account for it.
  const tags = ["alignment", ...DETAIL_FIELDS]
    .filter(k => d[k]?.trim())
    .map(k => ({ label: t(`step.details.field.${k}`), value: d[k].trim() }));
  const texts = DETAIL_TEXT_FIELDS
    .filter(k => d[k]?.trim())
    .map(k => ({ label: t(`step.details.field.${k}`), value: d[k].trim() }));
  return { tags, texts, hasAny: tags.length > 0 || texts.length > 0 };
}

/** The chosen spells for the summary, split into cantrips and level-1. */
function reviewSpells(state) {
  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
  const map = s => ({ name: s.name, img: s.img, uuid: s.uuid });
  const cantrips = [...state.selectedCantrips].sort(byName).map(map);
  const level1 = [...state.selectedSpells].sort(byName).map(map);
  return { cantrips, level1, hasAny: cantrips.length > 0 || level1.length > 0 };
}

/**
 * The spells chosen for each Magic Initiate-style feat, grouped by the origin that grants the feat,
 * so they sit under that origin's heading in the same cantrips/level-1 pattern as the class spells.
 * @returns {Promise<Record<string, {featName:string, cantrips:object[], level1:object[]}[]>>}
 */
async function reviewFeatSpells(state, source) {
  const grants = state.featSpellCache?.length ? state.featSpellCache : await resolveFeatSpells(state, source);
  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
  const resolve = async uuids => (await Promise.all((uuids ?? []).map(async uuid => {
    const doc = await fromUuid(uuid).catch(() => null);
    return doc ? { name: doc.name, img: doc.img, uuid } : null;
  }))).filter(Boolean).sort(byName);

  const bySource = {};
  for ( const grant of grants ) {
    const picks = state.featSpells[grant.key];
    if ( !picks ) continue;
    const cantrips = await resolve(picks.cantrips);
    const level1 = await resolve(picks.spells);
    if ( !cantrips.length && !level1.length ) continue;
    (bySource[grant.source] ??= []).push({ featName: grant.featName, cantrips, level1 });
  }
  return bySource;
}

/**
 * Spells an origin grants outright (e.g. a species that hands out a cantrip), split cantrips/level-1.
 *
 * `sel` is the origin's recorded advancement picks, which is what lets the walk follow a level-1
 * subclass. Without it a 2014 Cleric's domain spells were granted to the character but appeared
 * nowhere on the Review, because they hang off the chosen subclass rather than the class itself.
 */
async function originGrantedSpells(doc, sel) {
  const cards = await grantedSpellCards(doc, sel);
  const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
  const map = s => ({ name: s.name, img: s.img, uuid: s.uuid });
  const cantrips = cards.filter(s => s.level === 0).sort(byName).map(map);
  const level1 = cards.filter(s => s.level > 0).sort(byName).map(map);
  return { cantrips, level1, hasAny: cantrips.length + level1.length > 0 };
}

/**
 * The chosen starting equipment for the summary, keyed by origin source so each
 * origin block can show its own gear. Empty sources are omitted.
 * @returns {Promise<Record<string, {items: object[], gold: string, hasAny: boolean}>>}
 */
async function reviewEquipment(state, source, equipment) {
  if ( !equipment ) return {};
  const loaded = await equipment.load(state, source);
  const out = {};
  for ( const key of ["class", "background"] ) {
    if ( !loaded[key] ) continue;
    const { items, gold } = summarizeOption(loaded[key], state.equipment[key]);
    if ( !items.length && !gold ) continue;
    out[key] = { items, gold, hasAny: true };
  }
  return out;
}

/**
 * The Store-step cart for the summary: each purchased item with its quantity, plus the
 * total deducted from starting gold. Null when the store is off or nothing was bought.
 * @returns {{items: object[], total: string}|null}
 */
function reviewPurchases(state) {
  if ( !storeConfig().enabled ) return null;
  const purchases = state.store?.purchases ?? {};
  const items = Object.entries(purchases)
    .filter(([, p]) => (Number(p?.qty) || 0) > 0)
    .map(([uuid, p]) => ({ uuid, name: p.name, img: p.img, count: p.qty > 1 ? p.qty : null }))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  if ( !items.length ) return null;
  return { items, total: formatCp(cartTotalCp(purchases)) };
}

/* -------------------------------------------- */
/*  Per-origin grants & picks                   */
/* -------------------------------------------- */

/**
 * The three origin sections (Class & Abilities, Species, Background) for the summary,
 * each headed by its kind label and the chosen option. Every section gathers what its
 * source confers — fixed grants, the player's interactive picks, and (for the class) the
 * chosen spells, plus its starting equipment — so everything a source brings lives under
 * its own heading. Unchosen origins still render as a placeholder card. Item-backed values
 * keep their uuid/img so the template can render clickable, tooltip-bearing content links.
 */
async function reviewSections(state, source, equipBySource, spells, featSpellsBySource) {
  // The resolved choice set comes straight off the cache every mutation path keeps current (the
  // origin/class/background steps and every pick on the Choices step re-resolve into it), so the
  // read-only review reuses that rather than paying for a full re-resolve on each render. The
  // fallback covers a review reached before anything populated the cache.
  const resolved = state.choiceCache ?? await resolveChoices(state, source);
  const out = [];
  for ( const { key, field, labelKey, emptyKey } of ORIGIN_META ) {
    const uuid = state[field];
    const card = uuid ? source.card(uuid) : null;
    const doc = uuid ? await fromUuid(uuid).catch(() => null) : null;
    const rows = doc ? [...await fixedGrants(doc), ...summaryPicks(resolved, key)] : [];
    const grantedSpells = doc ? await originGrantedSpells(doc, state.advChoices?.[key] ?? {}) : null;
    out.push({
      key,
      kind: t(labelKey),
      empty: t(emptyKey),
      chosen: !!(card || doc),
      name: card?.name ?? doc?.name ?? "",
      img: card?.img ?? doc?.img ?? "icons/svg/mystery-man.svg",
      rows,
      spells: (key === "class" && spells.hasAny) ? spells : null,
      // Spells an origin grants outright (e.g. a species cantrip), in the same cantrips/level-1 layout.
      grantedSpells: grantedSpells?.hasAny ? grantedSpells : null,
      // Feat spells (Magic Initiate) sit under whichever origin grants the feat.
      featSpells: featSpellsBySource[key] ?? null,
      equipment: equipBySource[key] ?? null
    });
  }
  return out;
}

/**
 * Interactive picks for one source: [{title, values, empty}]. Each value is an object
 * carrying its display name and, where the pick is a real item (ItemChoice features),
 * its uuid/img so it can render as a content link.
 */
function summaryPicks(resolved, key) {
  const src = (resolved?.sources ?? []).find(s => s.key === key);
  if ( !src ) return [];
  // Spell-choice requirements (Magic Initiate & variants) carry no `options` pool — they're
  // surfaced under the section's feat-spells block, not here — so skip them.
  return src.requirements.filter(req => !req.spellStep && Array.isArray(req.options)).map(req => {
    const values = req.options.filter(o => o.isSelected)
      .map(o => o.uuid ? { name: o.label, uuid: o.uuid, img: o.img } : { name: o.label });
    return { title: req.title, values, empty: values.length === 0 };
  });
}

/**
 * Fixed (non-choice) advancement grants for one origin: automatically granted features,
 * fixed trait proficiencies, hit die, a fixed size, and level-1 scale values. Collected
 * as [{title, values, empty}] rows that merge same-titled grants together.
 */
async function fixedGrants(doc) {
  const groups = [];
  // `value` is a plain string (proficiencies, hit die, size, scale values) or an
  // `{name, uuid, img}` object for real items (features, granted gear) so the template
  // can render the latter as a clickable content link.
  const add = (title, value) => {
    const entry = (typeof value === "string") ? { name: value } : value;
    if ( !entry?.name ) return;
    let g = groups.find(x => x.title === title);
    if ( !g ) { g = { title, values: [], empty: false }; groups.push(g); }
    if ( !g.values.some(v => v.name === entry.name) ) g.values.push(entry);
  };

  for ( const adv of advancementArray(doc) ) {
    if ( (adv.level ?? 0) > 1 ) continue;

    if ( adv.type === "HitPoints" ) {
      const raw = doc.system?.hd?.denomination ?? doc.system?.hitDice ?? adv.hitDie;
      if ( raw ) add(t("advancement.hitDie"), /^d/i.test(String(raw)) ? String(raw) : `d${raw}`);
      continue;
    }
    if ( adv.type === "Trait" ) {
      for ( const k of Array.from(adv.configuration?.grants ?? []) ) {
        let title = traitChoiceTitle([k]);
        if ( title === t("choice.fallback") ) title = t("advancement.proficiency");
        add(title, traitKeyLabel(k));
      }
      continue;
    }
    if ( adv.type === "Size" ) {
      const sizes = Array.from(adv.configuration?.sizes ?? []);
      if ( sizes.length === 1 ) add(t("advancement.size"), CONFIG.DND5E.actorSizes?.[sizes[0]]?.label ?? sizes[0]);
      continue;
    }
    if ( adv.type === "ItemGrant" ) {
      for ( const i of Array.from(adv.configuration?.items ?? []) ) {
        const uuid = (typeof i === "string") ? i : i?.uuid;
        if ( !uuid ) continue;
        const granted = await fromUuid(uuid).catch(() => null);
        // Granted spells are shown in their own cantrips/level-1 block (originGrantedSpells), not here.
        if ( granted && granted.type !== "spell" ) add(
          granted.type === "feat" ? t("advancement.features") : t("advancement.grantedItems"),
          { name: granted.name, uuid, img: granted.img }
        );
      }
      continue;
    }
    if ( adv.type === "ScaleValue" ) {
      const title = advancementTitle(adv) || adv.configuration?.identifier || t("advancement.scaleValue");
      let display;
      try { const v = adv.valueForLevel?.(1); display = v?.display ?? v?.value ?? v; } catch { /* fall through */ }
      if ( display == null ) {
        const val = adv.configuration?.scale?.[1] ?? adv.configuration?.scale?.["1"];
        display = (val && typeof val === "object") ? val.value : val;
      }
      if ( display != null && display !== "" ) add(title, String(display));
    }
  }
  return groups;
}

/**
 * Final review. It surfaces every pick and the resolved ability scores so the player can confirm
 * before the actor is built. The "Create" control lives on the shell (it closes the app and runs
 * the assembler); the one control this step owns is the sheet-PDF switch, which decides what
 * happens *after* Create rather than changing anything about the character.
 */
export const reviewStep = {
  id: "review",
  icon: "fa-solid fa-clipboard-check",
  labelKey: "step.review.label",
  template: "steps/review",

  // The review itself is never "incomplete"; the shell gates Create on the other steps.
  isComplete() { return true; },

  summary() { return ""; },

  /**
   * The export switch. Nothing is generated here — the character doesn't exist yet, and at a
   * higher starting level it isn't finished until the level-up wizard has climbed to it. All this
   * records is the answer; {@link module:app/creator-shell} acts on it once there is a finished
   * character to print.
   */
  handle(action, _el, { state }) {
    if ( action !== "toggle-pdf" ) return;
    state.exportPdf = !state.exportPdf;
  },

  async context({ state, source, equipment }) {
    const scores = state.resolvedScores();
    // Merged across both origins, with the contributing source(s) kept so the pill can name them:
    // under the 2024 rules the increase comes from the background, under 2014 from the species.
    const deltas = state.abilityDeltas();
    const equipBySource = await reviewEquipment(state, source, equipment);
    const spells = reviewSpells(state);
    const featSpellsBySource = await reviewFeatSpells(state, source);
    const methodKeys = {
      "point-buy": "step.abilities.pointBuy",
      "standard-array": "step.abilities.standardArray",
      "roll": "step.abilities.roll",
      "manual": "step.abilities.manual"
    };
    const name = state.details.name?.trim() || state.actor?.name || "";
    return {
      name,
      // The stage header reads `step.label`; returning one here (the shell spreads the
      // step context over its default) lets the heading become "Review {name}".
      label: name ? t("step.review.labelNamed", { name }) : t("step.review.label"),
      portrait: state.portrait || "icons/svg/mystery-man.svg",
      method: t(methodKeys[state.abilityMethod] ?? "step.abilities.label"),
      abilities: ABILITIES.map(key => {
        const delta = deltas[key];
        const bonus = delta?.total ?? 0;
        const total = scores[key] + bonus;
        return {
          key,
          abbr: CONFIG.DND5E?.abilities?.[key]?.abbreviation ?? key.slice(0, 3).toUpperCase(),
          value: total,
          modifier: formatMod(total),
          bonus: bonus ? `+${bonus}` : null,
          bonusTip: bonus ? bonusTip(delta) : null
        };
      }),
      details: reviewDetails(state),
      pdf: pdfExportContext(state.exportPdf, "pdfExport.noteCreation"),
      purchases: reviewPurchases(state),
      sections: await reviewSections(state, source, equipBySource, spells, featSpellsBySource)
    };
  }
};
