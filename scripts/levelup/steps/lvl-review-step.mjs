import { ABILITIES, formatMod, t, log, storeConfig } from "../../config.mjs";
import { summarizeOption } from "../../data/equipment-source.mjs";
import { cartTotalCp, formatCp } from "../../data/store-source.mjs";

/**
 * Final review for a level-up, laid out like the creation review: the character portrait and
 * ability-score strip up top (with badges on scores this level-up raised), then one column per
 * origin — every class the actor has, plus the species/background when this level-up granted them
 * something. The levelled class's column carries the character-wide gains (hit points, proficiency
 * bonus, spell slots, weapon masteries) alongside its level jump — plus the spell picks staged on
 * the preceding spell step and any spell swapped out; every block lists its features with the new
 * ones badged, so a multiclass character can see exactly which part of the sheet moved and what
 * it brought. Read-only: everything is computed by diffing the driver's clone against the real
 * actor (staged spells from the state); the "Apply" control lives on the shell footer.
 */

/* -------------------------------------------- */
/*  Attribution                                 */
/* -------------------------------------------- */

/** The dnd5e advancement-origin flag on an embedded item: `"<grantingItemId>.<advancementId>"`. */
function originFlag(item) {
  return item?.flags?.dnd5e?.advancementRoot ?? item?.flags?.dnd5e?.advancementOrigin ?? null;
}

/**
 * The top-level item an embedded item ultimately came from, following the system's advancement
 * flags upward (a feat's sub-feature points at the feat, the feat at the class's ASI, …). The hop
 * limit guards against a malformed cycle; items with no flags return themselves.
 * @param {Actor5e} clone
 * @param {Item5e} item
 * @returns {Item5e}
 */
function topOwner(clone, item) {
  let current = item;
  for ( let hop = 0; hop < 5; hop++ ) {
    const flag = originFlag(current);
    const next = flag ? clone.items.get(String(flag).split(".")[0]) : null;
    if ( !next || next === current ) break;
    current = next;
  }
  return current;
}

/**
 * Which review block an item belongs to: a class item's id, `"species"`, `"background"`, or null
 * when the item has no advancement ancestry we can place (hand-added gear, loose feats). Subclass
 * items — and everything they grant — fold into their parent class's block. dnd5e strips the
 * origin flags from subclass items themselves ({@link SubclassAdvancement#apply}), so that mapping
 * goes through `system.classIdentifier` rather than the flags.
 */
function bucketOf(clone, item, classByIdentifier) {
  const owner = topOwner(clone, item);
  if ( owner.type === "class" ) return owner.id;
  if ( owner.type === "subclass" ) return classByIdentifier.get(owner.system?.classIdentifier)?.id ?? null;
  if ( owner.type === "race" ) return "species";
  if ( owner.type === "background" ) return "background";
  return null;
}

/** The clickable-chip shape for an embedded item (content link + New badge flag). */
function chip(item, gainedIds) {
  return {
    name: item.name,
    img: item.img,
    uuid: item._stats?.compendiumSource ?? item.uuid,
    isNew: gainedIds.has(item.id)
  };
}

/** New items first, then alphabetical — so a block leads with what this level-up brought. */
function byNewThenName(a, b) {
  return (Number(b.isNew) - Number(a.isNew)) || a.name.localeCompare(b.name, game.i18n.lang);
}

/* -------------------------------------------- */
/*  Character-wide diffs                        */
/* -------------------------------------------- */

/**
 * Spell-slot changes this level-up: each leveled slot rank whose maximum moved, plus Pact Magic,
 * diffed between the clone's and the actor's derived spellcasting data.
 *
 * Exported because the chat summary reports exactly the same diff (see
 * {@link module:build/chat-summary}); the review screen is simply its first consumer.
 * @returns {{label: string, change: string}[]}
 */
export function slotChanges(clone, actor) {
  const now = clone.system?.spells ?? {};
  const was = actor.system?.spells ?? {};
  const changes = [];
  for ( let l = 1; l <= 9; l++ ) {
    const to = now[`spell${l}`]?.max ?? 0;
    const from = was[`spell${l}`]?.max ?? 0;
    if ( to !== from ) changes.push({
      label: CONFIG.DND5E?.spellLevels?.[l] ?? String(l),
      change: `${from} → ${to}`
    });
  }
  // Pact Magic moves on two axes — slot count and slot level — so report either changing.
  const pactTo = now.pact ?? {};
  const pactFrom = was.pact ?? {};
  if ( ((pactTo.max ?? 0) !== (pactFrom.max ?? 0)) || ((pactTo.level ?? 0) !== (pactFrom.level ?? 0)) ) {
    const levelLabel = CONFIG.DND5E?.spellLevels?.[pactTo.level] ?? "";
    changes.push({
      label: t("levelup.step.review.pactSlots"),
      change: `${pactFrom.max ?? 0} → ${pactTo.max ?? 0}${levelLabel ? ` (${levelLabel})` : ""}`
    });
  }
  return changes;
}

/**
 * Scale-value bumps for one class this level-up (Sneak Attack dice, Rage uses, Channel Divinity…):
 * every ScaleValue advancement on the class — and any subclass of it on the clone — whose display
 * changes between its old and new class level. A subclass added *this* level-up has no "before",
 * so only what it now grants is shown. A class whose level didn't move yields nothing.
 * @returns {{title: string, values: {name: string}[]}[]}
 */
function scaleRows(clone, actor, cloneClass) {
  const oldLevel = actor.items.get(cloneClass.id)?.system?.levels ?? 0;
  const newLevel = cloneClass.system?.levels ?? oldLevel;
  if ( oldLevel === newLevel ) return [];

  // Subclass scale values are keyed by the base class's level, so both diff over the same range.
  const items = [cloneClass, ...clone.items.filter(i =>
    (i.type === "subclass") && (i.system?.classIdentifier === cloneClass.system?.identifier))];

  const rows = [];
  for ( const item of items ) {
    const isNew = !actor.items.get(item.id);
    for ( const adv of Object.values(item.advancement?.byId ?? {}) ) {
      if ( adv.type !== "ScaleValue" ) continue;
      const before = isNew ? null : (adv.valueForLevel(oldLevel)?.display ?? null);
      const after = adv.valueForLevel(newLevel)?.display ?? null;
      if ( !after || before === after ) continue;
      rows.push({ title: adv.title, values: [{ name: before ? `${before} → ${after}` : after, isNew: !before }] });
    }
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title, game.i18n.lang));
}

/* -------------------------------------------- */
/*  Starting equipment (Ember hand-off only)    */
/* -------------------------------------------- */

/**
 * The chosen starting gear, keyed by the origin that granted it — the same summary the creation
 * review shows, since it is the same step and the same selection state. Only the Ember hand-off
 * carries an equipment step (an ordinary level-up grants no starting gear), so this is empty
 * otherwise, and a failure to resolve it costs the review a panel rather than the whole screen.
 * @returns {Promise<Record<string, {items: object[], gold: string, hasAny: boolean}>>}
 */
async function reviewEquipment(state, source, equipment) {
  if ( !state.emberCreation || !equipment ) return {};
  try {
    const loaded = await equipment.load(state, source);
    const out = {};
    for ( const key of ["class", "background"] ) {
      if ( !loaded[key] || !state.equipment[key] ) continue;
      const { items, gold } = summarizeOption(loaded[key], state.equipment[key]);
      if ( !items.length && !gold ) continue;
      out[key] = { items, gold, hasAny: true };
    }
    return out;
  } catch ( err ) {
    log("review equipment summary failed", err);
    return {};
  }
}

/**
 * What was bought on the Store step, with the total spent — a panel of its own below the origin
 * columns, exactly as the creation review shows it. Null when the store is off, the rail never
 * carried it, or the cart is empty.
 * @returns {{items: object[], total: string}|null}
 */
function reviewPurchases(state) {
  if ( !state.emberCreation || !storeConfig().enabled ) return null;
  const purchases = state.store?.purchases ?? {};
  const items = Object.entries(purchases)
    .filter(([, p]) => (Number(p?.qty) || 0) > 0)
    .map(([uuid, p]) => ({ uuid, name: p.name, img: p.img, count: p.qty > 1 ? p.qty : null }))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  if ( !items.length ) return null;
  return { items, total: formatCp(cartTotalCp(purchases)) };
}

/* -------------------------------------------- */
/*  Step                                        */
/* -------------------------------------------- */

export const lvlReviewStep = {
  id: "review",
  icon: "fa-solid fa-clipboard-check",
  labelKey: "levelup.step.review.label",
  template: "levelup/review",

  isComplete() { return true; },

  summary() { return ""; },

  async context({ state, driver, source, equipment }) {
    // Starting gear is chosen on the Ember hand-off's equipment step but isn't folded onto the
    // clone until Apply, so — unlike features and spells — it has to be read back from the
    // selection rather than diffed off the clone.
    const equipBySource = await reviewEquipment(state, source, equipment);
    const clone = driver.clone;
    const actor = state.actor;
    const leveledId = state.classItem?.id ?? null;

    // Items present on the clone but not the real actor are this level-up's gains.
    const gainedIds = new Set(clone.items.filter(i => !actor.items.get(i.id)).map(i => i.id));

    const classes = clone.items.filter(i => i.type === "class");
    const classByIdentifier = new Map(classes.map(c => [c.system?.identifier, c]));

    // Sort every feature/spell into its origin's bucket. Existing items must carry an advancement
    // flag to be listed (hand-added gear and loose feats belong to no origin's story); a gained
    // item always lands somewhere — anything unplaceable goes to the levelled class, since this
    // level-up is what brought it in.
    const features = new Map();   // bucket -> chips (feats & any non-spell gains)
    const newSpells = new Map();  // bucket -> chips (spells gained this level-up)
    const push = (map, bucket, entry) => {
      if ( !map.has(bucket) ) map.set(bucket, []);
      map.get(bucket).push(entry);
    };
    for ( const item of clone.items ) {
      if ( ["class", "subclass", "race", "background"].includes(item.type) ) continue;
      const isNew = gainedIds.has(item.id);
      if ( !isNew && (item.type !== "feat" || !originFlag(item)) ) continue;
      const bucket = bucketOf(clone, item, classByIdentifier) ?? (isNew ? leveledId : null);
      if ( !bucket ) continue;
      if ( item.type === "spell" ) {
        if ( isNew ) push(newSpells, bucket, chip(item, gainedIds));
      } else {
        push(features, bucket, chip(item, gainedIds));
      }
    }

    // The casting-ability decisions (a species lineage spell) read back off the driver, shown as a
    // row on whichever origin granted the spell.
    const abilityRows = new Map();
    for ( const record of state.grantSteps ) {
      const st = driver.grantState(record);
      if ( !st.ability ) continue;
      const carrier = clone.items.get(record.item?.id) ?? record.item;
      const bucket = (carrier && bucketOf(clone, carrier, classByIdentifier)) ?? "species";
      push(abilityRows, bucket, {
        title: t("advancement.spellAbilityFor", { spell: st.spells[0]?.name ?? record.advancement.title }),
        values: [{ name: CONFIG.DND5E.abilities[st.ability]?.label ?? st.ability, isNew: true }]
      });
    }

    /* ---- character-wide diffs (shown inside the levelled class's block) ---- */

    const hpMax = clone.system?.attributes?.hp?.max ?? actor.system?.attributes?.hp?.max ?? 0;
    const prevHpMax = actor.system?.attributes?.hp?.max ?? 0;
    const profNow = clone.system?.attributes?.prof ?? 0;
    const profWas = actor.system?.attributes?.prof ?? 0;

    // Weapon masteries gained this level-up. They live on the actor (not as items), so diff the
    // mastery key set on the clone against the actor and label each new one.
    const masteryNow = new Set(clone.system?.traits?.weaponProf?.mastery?.value ?? []);
    const masteryWas = new Set(actor.system?.traits?.weaponProf?.mastery?.value ?? []);
    const masteries = [...masteryNow].filter(k => !masteryWas.has(k))
      .map(k => dnd5e.documents.Trait.keyLabel(`weapon:${k}`) || k)
      .sort((a, b) => a.localeCompare(b, game.i18n.lang));

    /* ---- staged spell picks (chosen on the spell step, not yet on the clone) ---- */

    const plan = state.spellPlan();
    const stagedSpells = plan.isSpellcaster
      ? [...state.selectedCantrips, ...state.selectedSpells]
        .map(s => ({ name: s.name, img: s.img, uuid: s.uuid, isNew: true }))
      : [];
    // A marked swap only takes effect when its freed slot was actually used (see spellChanges).
    const swappedOut = [];
    if ( plan.isSpellcaster ) {
      if ( state.swapCantrip && (state.selectedCantrips.length > plan.addCantrips) ) swappedOut.push(state.swapCantrip.name);
      if ( state.swapSpell && (state.selectedSpells.length > plan.addSpells) ) swappedOut.push(state.swapSpell.name);
    }

    /* ---- origin columns ---- */

    const sections = [];

    for ( const cls of classes ) {
      const existing = actor.items.get(cls.id);
      const fromLevel = existing?.system?.levels ?? 0;
      const toLevel = cls.system?.levels ?? fromLevel;
      const leveled = toLevel !== fromLevel;
      // A class with no "before" is this level-up's multiclass — badge it as new rather than
      // showing a nonsensical "Level 0 → 1".
      const isNewClass = !existing;
      const rows = [];

      const hd = cls.system?.hd?.denomination ?? cls.system?.hitDice;
      if ( hd ) rows.push({
        title: t("step.class.trait.hitDie"),
        values: [{ name: /^d/i.test(String(hd)) ? String(hd) : `d${hd}` }]
      });

      // The character-wide movement rides with the class whose level-up caused it, so the
      // levelled block tells the whole story: hit points, masteries, proficiency, slots.
      if ( leveled ) {
        rows.push({
          title: t("levelup.step.hp.label"),
          values: [{ name: t("levelup.step.review.hp", { gain: Math.max(0, hpMax - prevHpMax), max: hpMax }) }]
        });
      }

      const subclass = clone.items.find(i =>
        (i.type === "subclass") && (i.system?.classIdentifier === cls.system?.identifier));
      if ( subclass ) rows.push({ title: t("levelup.step.subclass.label"), values: [chip(subclass, gainedIds)] });

      rows.push(...scaleRows(clone, actor, cls));

      if ( leveled ) {
        // Specifically the weapon-mastery keys, not the trait block's generic heading.
        if ( masteries.length ) rows.push({
          title: t("levelup.step.review.masteries"),
          values: masteries.map(name => ({ name }))
        });
        if ( profNow !== profWas ) rows.push({
          title: t("levelup.step.review.profBonus"),
          values: [{ name: `+${profWas} → +${profNow}` }]
        });
        const slots = slotChanges(clone, actor);
        if ( slots.length ) rows.push({
          title: t("levelup.step.review.spellSlots"),
          values: slots.map(s => ({ name: `${s.label} ${s.change}` }))
        });
        if ( swappedOut.length ) rows.push({
          title: t("levelup.step.review.swappedOut"),
          values: swappedOut.map(name => ({ name }))
        });
      }

      rows.push(...(abilityRows.get(cls.id) ?? []));

      // The staged spell picks always belong to the levelled class's casting (its own list, or a
      // casting subclass of it — both fold into this block).
      const sectionSpells = (newSpells.get(cls.id) ?? []);
      if ( leveled ) sectionSpells.push(...stagedSpells);

      sections.push({
        kind: t("levelup.step.review.kindClass"),
        name: cls.name,
        img: cls.img,
        leveled,
        levelLabel: isNewClass
          ? t("levelup.step.review.levelNew", { level: toLevel })
          : leveled
            ? t("levelup.step.review.levelUp", { from: fromLevel, to: toLevel })
            : t("levelup.step.review.level", { level: toLevel }),
        rows,
        features: (features.get(cls.id) ?? []).sort(byNewThenName),
        spells: sectionSpells.sort(byNewThenName),
        // The class's starting gear rides with the class that granted it (levelled class only —
        // a multiclass level grants none, and only the hand-off has any at all).
        equipment: leveled ? (equipBySource.class ?? null) : null
      });
    }

    // The levelled class leads; the other classes follow, then species/background.
    sections.sort((a, b) => Number(b.leveled) - Number(a.leveled));

    // Species and background earn a column only when this level-up granted them something — a
    // lineage spell unlocking at a class level being the common case.
    for ( const [bucket, type, kindKey] of [["species", "race", "kindSpecies"], ["background", "background", "kindBackground"]] ) {
      const gainedFeatures = (features.get(bucket) ?? []).filter(f => f.isNew);
      const gainedSpells = (newSpells.get(bucket) ?? []).sort(byNewThenName);
      const rows = abilityRows.get(bucket) ?? [];
      // A background that granted only gear (Ember's culture/path bundles) still earns its column.
      const equip = equipBySource[bucket] ?? null;
      if ( !gainedFeatures.length && !gainedSpells.length && !rows.length && !equip ) continue;
      const item = clone.items.find(i => i.type === type);
      sections.push({
        kind: t(`levelup.step.review.${kindKey}`),
        name: item?.name ?? t(`levelup.step.review.${kindKey}`),
        img: item?.img ?? "icons/svg/mystery-man.svg",
        leveled: false,
        levelLabel: "",
        rows,
        features: gainedFeatures.sort(byNewThenName),
        spells: gainedSpells,
        equipment: equip
      });
    }

    return {
      portrait: actor.img || "icons/svg/mystery-man.svg",
      // Pills mark scores this session raised, so they can only ever reflect an *advancement* that
      // applied here. In the Ember hand-off the point-buy and the Path's ability increases are
      // Ember's own — it writes the finished totals to the actor before handing us the manager and
      // keeps no record of the split (`EmberCharacterCreationSheet#boostAbilityScore` holds the
      // boosts in a private field and stores only `base + boosts`) — so those show no pill, and any
      // that does appear came from an advancement on one of the origin items.
      abilities: ABILITIES.map(key => {
        const now = clone.system?.abilities?.[key]?.value ?? 10;
        const was = actor.system?.abilities?.[key]?.value ?? now;
        const delta = now - was;
        const tipKey = state.emberCreation ? "abilityTipCreation" : "abilityTip";
        return {
          key,
          abbr: CONFIG.DND5E?.abilities?.[key]?.abbreviation ?? key.slice(0, 3).toUpperCase(),
          value: now,
          modifier: formatMod(now),
          bonus: delta > 0 ? `+${delta}` : null,
          bonusTip: delta > 0 ? t(`levelup.step.review.${tipKey}`) : null
        };
      }),
      purchases: reviewPurchases(state),
      sections
    };
  }
};
