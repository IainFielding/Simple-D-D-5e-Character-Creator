import { ABILITIES, MODULE_ID, log, storeConfig } from "../config.mjs";
import { resolveChoices } from "../data/choice-resolver.mjs";
import { collectEquipment } from "../data/equipment-source.mjs";
import { cartTotalCp, purchasedItems, remainingCurrency } from "../data/store-source.mjs";
import { spellMethodFor } from "../data/spell-source.mjs";
import { resolveFeatSpells } from "../steps/feat-spells-step.mjs";
import { LevelUpDriver } from "../levelup/manager-driver.mjs";
import { buildCreationManager, CreationChoiceProvider } from "./creation-advancement.mjs";

/**
 * Turns a finished {@link CreatorState} into a real character.
 *
 * Everything the player chose is baked in directly, so they're never asked to confirm
 * anything again. The order is: write the base ability scores and the Details-step fields,
 * then add the origin items (class, background, species) by driving them through the shared
 * level-up advancement driver, which applies every advancement on a clone and answers each
 * choice from the picks the wizard already collected (see {@link module:build/creation-advancement}).
 * An origin's ability increase — the 2024 background's, or the 2014 species' — is applied by its
 * own advancement in that pass, not pre-baked.
 * Finally the chosen spells, then the starting equipment, are granted.
 *
 * For a junior dev: this is the ONLY place that writes to the world — every step before this just
 * mutated the in-memory CreatorState. Two Foundry APIs do the writing: actor.update(changes) sets
 * fields on the actor (using "dotted.path" keys), and actor.createEmbeddedDocuments("Item", [...])
 * adds items (class, spells, gear) onto the actor. The `render: false` option on those calls stops
 * the actor sheet redrawing after every single write, so the build doesn't flicker. Read the
 * numbered steps in assembleActor() top to bottom — that's the whole build sequence.
 *
 * @param {import("../state/creator-state.mjs").CreatorState} state
 * @param {import("../data/source-index.mjs").SourceIndex} source
 * @returns {Promise<Actor>} The built actor.
 */
export async function assembleActor(state, source, equipment) {
  const actor = state.actor;

  // Resolve the chosen origin documents and stage their item data (each keeps its
  // compendium id so the manager and the manual apply can address it consistently).
  const docs = {
    class: state.classUuid ? await fromUuid(state.classUuid) : null,
    background: state.backgroundUuid ? await fromUuid(state.backgroundUuid) : null,
    species: state.speciesUuid ? await fromUuid(state.speciesUuid) : null
  };

  const items = [];
  const detailLinks = {};
  const stage = (key, link, mutate) => {
    const doc = docs[key];
    if ( !doc ) { log(`origin item not found: ${key}`); return; }
    const data = doc.toObject();
    // Give the staged item its own id. `toObject()` hands back the compendium document's `_id`,
    // so without this every creator-built character carried the *pack's* id for its class,
    // species and background — colliding across characters and leaking into the
    // `flags.dnd5e.advancementOrigin` of everything those items grant
    // ("phbbgSage0000000.<advId>" instead of an actor-local id). The system does the same thing
    // for a dropped item (`AdvancementManager.forNewItem` assigns a fresh id before staging).
    data._id = foundry.utils.randomID();
    if ( data._stats ) data._stats.compendiumSource = doc.uuid;
    mutate?.(data);
    items.push(data);
    detailLinks[link] = data._id;
  };
  // Species → background → class, matching the order the manager expects to process.
  stage("species", "system.details.race");
  stage("background", "system.details.background");
  stage("class", "system.details.originalClass", data => { data.system.levels = 0; });

  // Write the actor-level update: identity/visuals, the base ability scores, and the detail→item
  // links. An origin's ability increase is NOT layered in here — its ASI advancement applies it in
  // the driver pass below, so it lands exactly once, the native way.
  const scores = state.resolvedScores();
  const update = { ...detailsUpdate(state), ...detailLinks };
  for ( const key of ABILITIES ) update[`system.abilities.${key}.value`] = scores[key];
  await actor.update(update);

  // Drive the origin advancements through the shared level-up driver on a clone, answering every
  // choice from the wizard's recorded picks, then commit once. This is the same engine a level-up
  // uses; the CreationChoiceProvider stands in for the interactive UI.
  const resolved = state.choiceCache ?? await resolveChoices(state, source);

  if ( items.length ) {
    const manager = buildCreationManager(actor, items);
    const driver = new LevelUpDriver(manager);
    await driver.prepare();
    await driver.autoResolve(new CreationChoiceProvider(resolved, state));
    await driver.commit();
    await actor.setFlag(MODULE_ID, "created", true);

    // Start at full health. dnd5e's HitPoints advancement writes *current* HP by adding the hit
    // die plus the Constitution modifier as it stands at the moment it applies — and in this walk
    // that moment is during prepare(), before the origin's ability increase has been allocated (the
    // ASI is only surfaced there and assigned later, in autoResolve). An origin that raises
    // Constitution — a 2024 background, or a 2014 species like the Hill Dwarf — therefore left the
    // character starting below its own maximum: max is derived and self-corrects, but the stored
    // current value does not. Re-applying the hit-point
    // decisions cannot fix it — reverse and apply both recompute from the *new* modifier, so the
    // round trip is a no-op — and a freshly created character is at full health by definition.
    const hp = actor.system.attributes?.hp;
    if ( hp?.max ) await actor.update({ "system.attributes.hp.value": hp.max }, { render: false });
  }

  // Add the spells chosen on the Spells step, as prepared class spells.
  await addSpells(actor, state);

  // Add the spells chosen on the Feat-Spells step (Magic Initiate), created directly on the actor —
  // the PHB feat carries no advancement to grant them, so we add them by hand.
  await applyFeatSpells(actor, state, source);

  // Grant the starting equipment and currency chosen on the Choices step.
  if ( equipment ) await grantEquipment(actor, state, source, equipment);

  return actor;
}

/**
 * Create the spells the player chose for each Magic Initiate-style feat, linked to the granted feat
 * on the actor. Cantrips are added at-will; the level-1 spell is always prepared and gains the
 * feat's once-per-long-rest free casting, and all of them cast off the chosen ability. Mirrors the
 * dnd5e spell-configuration the advancement flow would apply, done manually because the compendium
 * feat has no advancement of its own.
 */
async function applyFeatSpells(actor, state, source) {
  const grants = await resolveFeatSpells(state, source);
  for ( const grant of grants ) {
    const picks = state.featSpells[grant.key];
    if ( !picks ) continue;
    const list = grant.classList.length === 1 ? grant.classList[0] : picks.list;
    if ( !list ) continue;
    const ability = (grant.abilityKeys.length === 1 ? grant.abilityKeys[0] : picks.ability)
      || grant.abilityKeys[0] || "int";

    // Find the granted feat item so the spells can be tagged to it (grouping + cleanup on the sheet).
    const feat = actor.items.find(i => i.type === "feat"
      && (i._stats?.compendiumSource === grant.featUuid || i.system?.identifier === grant.featIdentifier));
    const sourceTag = `feat:${grant.featIdentifier}`;

    const data = [];
    for ( const uuid of picks.cantrips ?? [] ) {
      data.push(await buildFeatSpell(uuid, {
        ability, cantrip: true, feat, sourceTag, spellConfig: grant.cantripSpellConfig
      }));
    }
    for ( const uuid of picks.spells ?? [] ) {
      data.push(await buildFeatSpell(uuid, {
        ability, cantrip: false, feat, sourceTag, spellConfig: grant.spellSpellConfig
      }));
    }
    const clean = data.filter(Boolean);
    if ( clean.length ) await actor.createEmbeddedDocuments("Item", clean, { render: false });
  }
}

/**
 * Build one feat spell's item data with the Magic Initiate casting configuration applied.
 *
 * When the feat carries its own spell `ItemChoice` advancements (the dnd5e copy does; the
 * PHB module's does not — see {@link module:steps/feat-spells-step}), the configuration is handed
 * to the system's own `applySpellChanges`, which is the same call the advancement would have made.
 * That matters for more than tidiness: as well as the ability, method and uses, it builds the
 * **"(free casting)" forward activity** that is how the once-per-long-rest free cast is actually
 * cast. Setting the uses counter by hand — as this used to — left the charge in place with no
 * activity to spend it with.
 *
 * The hand-rolled block below remains for the advancement-less feat, where there is no
 * configuration to borrow and the PHB's fixed Magic Initiate shape is all we have.
 */
async function buildFeatSpell(uuid, { ability, cantrip, feat, sourceTag, spellConfig }) {
  const doc = await fromUuid(uuid).catch(() => null);
  if ( !doc ) { log(`feat spell not found: ${uuid}`); return null; }
  const obj = doc.toObject();
  if ( obj._stats ) obj._stats.compendiumSource = uuid;
  if ( feat ) foundry.utils.setProperty(obj, "flags.dnd5e.advancementOrigin", `${feat.id}.`);

  if ( spellConfig?.applySpellChanges ) {
    spellConfig.applySpellChanges(obj, { ability });
    // `applySpellChanges` derives `sourceItem` from the advancement's own item, which is the feat
    // — the same tag this module uses to group the spells on the sheet. Only set it ourselves if
    // the config left it empty (a configuration with no method sets nothing).
    if ( !obj.system?.sourceItem ) foundry.utils.setProperty(obj, "system.sourceItem", sourceTag);
    return obj;
  }

  foundry.utils.setProperty(obj, "system.ability", ability);
  foundry.utils.setProperty(obj, "system.sourceItem", sourceTag);
  if ( !cantrip ) {
    // The level-1 spell is always prepared and castable once per long rest without a slot.
    foundry.utils.setProperty(obj, "system.method", "spell");
    foundry.utils.setProperty(obj, "system.prepared", 2);
    foundry.utils.setProperty(obj, "system.uses.max", "1");
    foundry.utils.setProperty(obj, "system.uses.spent", 0);
    const recovery = Array.isArray(obj.system?.uses?.recovery) ? obj.system.uses.recovery : [];
    recovery.push({ period: "lr", type: "recoverAll" });
    foundry.utils.setProperty(obj, "system.uses.recovery", recovery);
  }
  return obj;
}

/**
 * Grant the chosen starting equipment (items, equipped by default) and add any currency
 * — both the lettered "gold" option and currency embedded in an equipment package. Store
 * purchases ride the same grant: their items are appended and the cart total is deducted
 * from the currency before it is written, so a failed create still cleans everything up
 * via the existing delete-on-failure path.
 */
async function grantEquipment(actor, state, source, equipment) {
  const loaded = await equipment.load(state, source);
  if ( !loaded.class && !loaded.background ) return;

  const { items, currency } = await collectEquipment(loaded, state);

  // The cart only applies while it fits inside the currency the equipment choice yields —
  // the step's gates enforce that, so an overspent cart here means stale state; skip it
  // rather than write negative gold.
  let cartCp = storeConfig().enabled ? cartTotalCp(state.store?.purchases) : 0;
  const { spendable, remainder } = remainingCurrency(currency, cartCp);
  if ( cartCp > 0 && !spendable ) {
    log("store cart exceeds the starting currency; purchases skipped");
    cartCp = 0;
  }
  if ( cartCp > 0 ) items.push(...await purchasedItems(state.store.purchases));

  if ( items.length ) await actor.createEmbeddedDocuments("Item", items, { keepId: true, render: false });

  const grantedCurrency = cartCp > 0 ? remainder : currency;
  const update = {};
  for ( const [denom, amount] of Object.entries(grantedCurrency) ) {
    if ( amount > 0 ) update[`system.currency.${denom}`] = (actor.system?.currency?.[denom] ?? 0) + amount;
  }
  if ( Object.keys(update).length ) await actor.update(update, { render: false });
}

/* -------------------------------------------- */

/**
 * Create the player's chosen cantrips and level-1 spells on the actor as prepared
 * class spells. dnd5e 6.x marks a known class spell with `prepared:1`, a casting `method`,
 * and a `sourceItem` link back to the class identifier.
 *
 * The `method` selects which slot pool (and spellbook section) the spell uses: a pact caster
 * (Warlock) casts from Pact Magic slots, everyone else from ordinary spell slots. It's derived
 * from the class's spellcasting progression ("pact" → "pact"; "full"/"half"/"artificer"/… →
 * "spell"), so a Warlock's level-1 spells land in the pact section instead of leaking into the
 * standard slots. Cantrips still resolve to the shared "Cantrips" section regardless of method.
 */
async function addSpells(actor, state) {
  const picks = [...state.selectedCantrips, ...state.selectedSpells];
  if ( !picks.length ) return;

  let classId = "";
  let method = "spell";
  if ( state.classUuid ) {
    const classDoc = await fromUuid(state.classUuid).catch(() => null);
    classId = classDoc?.system?.identifier ?? "";
    method = spellMethodFor(classDoc);
  }

  const data = [];
  for ( const pick of picks ) {
    const doc = await fromUuid(pick.uuid).catch(() => null);
    if ( !doc ) { log(`selected spell not found: ${pick.uuid}`); continue; }
    const obj = doc.toObject();
    if ( obj._stats ) obj._stats.compendiumSource = pick.uuid;
    foundry.utils.setProperty(obj, "system.prepared", 1);
    foundry.utils.setProperty(obj, "system.method", method);
    if ( classId ) foundry.utils.setProperty(obj, "system.sourceItem", `class:${classId}`);
    data.push(obj);
  }
  if ( data.length ) await actor.createEmbeddedDocuments("Item", data, { render: false });
}

/**
 * Build the actor-update fragment carrying the Details step: name, portrait, the
 * prototype-token visuals, and the `system.details.*` identity/biography fields.
 * `ideals`/`bonds`/`flaws` map to the singular dnd5e keys; biography is rich text.
 */
function detailsUpdate(state) {
  const d = state.details;
  const name = d.name?.trim() || state.actor?.name || "";
  return {
    name,
    img: state.portrait,
    "prototypeToken.name": name,
    "prototypeToken.texture.src": state.tokenImg,
    "prototypeToken.ring.enabled": state.tokenRingEnabled,
    "prototypeToken.ring.subject.texture": state.tokenRingImg,
    "prototypeToken.lockRotation": state.tokenLockRotation,
    "system.details.alignment": d.alignment,
    "system.details.faith": d.faith,
    "system.details.gender": d.gender,
    "system.details.eyes": d.eyes,
    "system.details.hair": d.hair,
    "system.details.skin": d.skin,
    "system.details.height": d.height,
    "system.details.weight": d.weight,
    "system.details.age": d.age,
    "system.details.trait": d.trait,
    "system.details.ideal": d.ideals,
    "system.details.bond": d.bonds,
    "system.details.flaw": d.flaws,
    "system.details.appearance": d.appearance,
    "system.details.biography.value": d.biography
  };
}
