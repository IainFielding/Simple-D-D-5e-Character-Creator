import { emberActive, log, storeConfig } from "../config.mjs";
import { collectEquipment } from "../data/equipment-source.mjs";
import { equipmentBudgetCp, applyCartToCurrency, cartTotalCp, purchasedItems } from "../data/store-source.mjs";
import { equipmentStep } from "../steps/equipment-step.mjs";
import { storeStep } from "../steps/store-step.mjs";
import { spellChanges, buildSpellItemData } from "./steps/lvl-spells-step.mjs";

/**
 * The Ember hand-off (§ Ember): taking over the level-1 questions Ember's character builder leaves
 * to the system.
 *
 * Ember owns creation — it picks the ancestry, the culture/path background, the class, the ability
 * scores and the attunement — and then, instead of writing the character itself, it borrows the
 * system's AdvancementManager purely as a question-asking UI:
 *
 *   1. it writes name/abilities/details/token/attunement to the real actor;
 *   2. it stages the ancestry, its synthesised background, the class (at level 0) and the attunement
 *      feature onto `manager.clone` — never onto the actor;
 *   3. it pushes the class's level 0→1 steps plus the other items' level-0/1 flows, then renders;
 *   4. it waits for `dnd5e.preAdvancementManagerComplete`, takes the updates and created items from
 *      the hook, **vetoes the system's own write** and applies them itself (with `keepId`, plus its
 *      own `flags.ember.characterCreation`);
 *   5. if the manager closes without completing, it resolves to null and abandons the advancements.
 *
 * Step 3 is where `dnd5e.preAdvancementManagerRender` fires, which is our existing takeover hook
 * ({@link module:levelup/intercept}), and step 4 is exactly what {@link LevelUpDriver#commit}
 * already does at the end of an ordinary level-up. So the hand-off needs no wrapper and no patching
 * of Ember: we claim the manager, drive its clone through our own wizard, and commit — Ember's
 * listener accepts the result as if the native manager had produced it.
 *
 * What this module adds on top of the ordinary level-up:
 *   - {@link isEmberCreationManager} — recognise the hand-off (and only ever that).
 *   - {@link foldOriginScreens} — the ancestry/background decisions arrive as *level 0* flows;
 *     without this they would earn a screen labelled "Level 0" of their own.
 *   - {@link emberEquipmentStep} — starting equipment, which is not part of any advancement.
 *   - {@link stageEmberGear} — gear, currency and spell picks folded onto the clone before the
 *     commit, so Ember's single write carries them (nothing races its `actor.update`).
 *   - {@link abandonEmberCreation} — release Ember's builder when the player cancels.
 *
 * Everything here reads Ember's *internals* (it exposes no API beyond an unrelated hook), so each
 * entry point is defensive: anything that doesn't match the shape above stands down and lets Ember's
 * own flow run exactly as it does without this module.
 */

/* -------------------------------------------- */
/*  Detection                                   */
/* -------------------------------------------- */

/**
 * Whether an advancement manager is Ember's creation hand-off rather than an ordinary level-up.
 *
 * The fingerprint is Ember's staging (step 2 above): a character the user owns which has **no class
 * of its own**, whose clone carries a class and a background that the actor doesn't, where that
 * background is one Ember synthesised. Anything short of that — including a normal level-up in an
 * Ember world — is not ours to claim here.
 * @param {AdvancementManager} manager
 * @returns {boolean}
 */
export function isEmberCreationManager(manager) {
  if ( !emberActive() ) return false;
  const actor = manager?.actor;
  const clone = manager?.clone;
  if ( !clone || (actor?.type !== "character") || !actor.isOwner ) return false;

  // Ember's builder hands off before the character has any class of its own; an actor that already
  // has one is levelling, not being created.
  if ( actor.items.some(i => i.type === "class") ) return false;

  const staged = type => clone.items.find(i => (i.type === type) && !actor.items.get(i.id)) ?? null;
  if ( !staged("class") ) return false;

  // Ember builds its background from a culture and a path (`EmberCharacterCreationSheet
  // .createBackground`), stamping both onto the item — which is also why it has no compendium entry.
  const background = staged("background");
  return !!background
    && ((background.system?.identifier === "emberBackground") || !!background.flags?.ember);
}

/* -------------------------------------------- */
/*  Screens                                     */
/* -------------------------------------------- */

/**
 * Move the origin decisions onto the level-1 screen. Ancestry and background advancements sit at
 * level 0 (they aren't levelled), so the wizard's one-screen-per-level rail would otherwise open on
 * a screen labelled "Level 0" holding the species and background choices, with the class's own
 * choices on a second screen. A character being created has exactly one level, so everything the
 * build grants belongs on it.
 *
 * Only the *screen* level moves: each decision still applies at its own `level`, which is what the
 * advancement's apply/reverse is keyed by.
 * @param {import("./manager-driver.mjs").LevelUpDriver} driver
 */
export function foldOriginScreens(driver) {
  const arrays = [driver.hpSteps, driver.asiSteps, driver.choiceSteps, driver.traitSteps,
    driver.subclassSteps, driver.grantSteps, driver.sizeSteps, driver.optionalGrantSteps];
  for ( const records of arrays ) {
    // A decision array is absent rather than empty on a driver assembled from partial state, so
    // adding one here must not break the folding of the others.
    for ( const record of records ?? [] ) record.screenLevel = Math.max(record.screenLevel ?? record.level, 1);
  }
}

/**
 * The starting-equipment step for the Ember rail — the creator's own step module, unchanged. It
 * reads `state.equipment` and the origins' `system.startingEquipment` trees, both of which the
 * hand-off supplies ({@link LevelUpState#equipmentDocs}).
 *
 * Two small differences from the creation rail: the level-up shell has no `onEnter`, so completion
 * can't be "has been visited" — and it needn't be, because there is always a default loadout, so
 * like the level-up spell step this never gates Apply.
 */
export const emberEquipmentStep = {
  ...equipmentStep,
  isComplete() { return true; }
};

/**
 * The starting-gold shop for the Ember rail — again the creator's own step, so the GM's curated
 * stock, prices and cart all behave identically. It follows Equipment because the budget *is* that
 * step's outcome, and appears only when the GM has the store switched on.
 *
 * Completion drops the creator's "has been seen" requirement (the level-up shell has no `onEnter`)
 * but keeps the one real error state: a cart that outgrew its budget, which can happen when the
 * player shops and then goes back and picks a poorer equipment option.
 */
export const emberStoreStep = {
  ...storeStep,
  isComplete(state) {
    if ( !storeConfig().enabled ) return true;
    return ((state.storeBudgetCp ?? 0) - cartTotalCp(state.store?.purchases)) >= 0;
  }
};

/** Whether the Ember rail should carry the store step at all. */
export function emberStoreEnabled(state) {
  return !!state.emberCreation && storeConfig().enabled;
}

/* -------------------------------------------- */
/*  Apply                                       */
/* -------------------------------------------- */

/**
 * Fold the starting equipment, its currency and the staged spell picks onto the driver's clone, so
 * the commit that follows carries them into the `toCreate` set Ember writes.
 *
 * An ordinary level-up writes its spell picks to the real actor just after the commit
 * ({@link module:levelup/levelup-shell}), which it can do because the commit has already landed.
 * Here the commit only *offers* the result to Ember — Ember's own `actor.update` and
 * `createEmbeddedDocuments` follow ours in its promise continuation — so a second write of our own
 * would race it. Staging on the clone keeps the whole build in Ember's single write.
 *
 * Uses the same `updateSource({items})` idiom the system's own ItemGrant advancement uses to add
 * items to a clone.
 * @param {import("./levelup-state.mjs").LevelUpState} state
 * @param {{equipment: import("../data/equipment-source.mjs").EquipmentSource,
 *          source: import("../data/source-index.mjs").SourceIndex}} ctx  The shell's step context.
 */
export async function stageEmberGear(state, { equipment, source }) {
  const clone = state.driver?.clone;
  if ( !clone ) return;

  const items = [];

  // Starting equipment: the class's own tree plus Ember's combined culture/path one.
  const loaded = await equipment.load(state, source);
  const { items: gear, currency } = await collectEquipment(loaded, state);
  items.push(...gear);

  // Anything bought on the Store step rides along, with its total deducted from the coin the
  // equipment choice yielded — literally the arithmetic the creation grant does, shared so the two
  // hand-offs can never disagree about what a cart costs.
  const { cartCp, currency: granted } = applyCartToCurrency(state.store?.purchases, currency);
  if ( cartCp > 0 ) items.push(...await purchasedItems(state.store.purchases));

  // Spell picks staged on the spell step. A swap-out can't arise at creation (there is nothing
  // owned to swap), so only the additions matter here.
  const { sourceTag, method, create } = spellChanges(state);
  if ( sourceTag && create.length ) items.push(...await buildSpellItemData(sourceTag, create, method));

  if ( items.length ) clone.updateSource({ items });

  // Coin from a "gold instead of gear" option (less anything spent in the shop), added to whatever
  // the build already carries.
  const updates = {};
  for ( const [denomination, amount] of Object.entries(granted) ) {
    if ( !amount ) continue;
    const held = clone.system?.currency?.[denomination] ?? 0;
    updates[`system.currency.${denomination}`] = held + amount;
  }
  if ( Object.keys(updates).length ) clone.updateSource(updates);

  // Keep the store step's budget honest for anyone reading it after the fact (the Ember rail has no
  // store step, but the equipment step's context sets this and the value is cheap to keep true).
  state.storeBudgetCp = await equipmentBudgetCp(loaded, state).catch(() => state.storeBudgetCp);
}

/* -------------------------------------------- */
/*  Cancel                                      */
/* -------------------------------------------- */

/**
 * Release Ember's builder after a cancelled hand-off, so it resolves the way it would if the player
 * had dismissed the native advancement manager: no advancement items, builder still open, Complete
 * ready to be clicked again.
 *
 * Ember waits on the manager's `"close"` event for that outcome — but our takeover suppressed the
 * manager's render, and `ApplicationV2#close` returns early on an application that has no element,
 * without firing it. So the event is dispatched here explicitly. (If some other module did force the
 * manager to render, `close()` fires it too; Ember's listener is a `Hooks.off` plus a settled
 * promise's `resolve`, so arriving twice is harmless.)
 * @param {AdvancementManager} manager
 */
export async function abandonEmberCreation(manager) {
  if ( !manager ) return;
  try {
    // `skipConfirmation`, because the player has already been asked. `AdvancementManager#close`
    // otherwise puts up dnd5e's own "Stop advancement / Continue" prompt, which is a second dialog
    // for a decision made in ours — and an orphaned one: the release below does not wait for it, so
    // Ember's builder is already back by the time it is answered and neither button can change that.
    // Every call site inside dnd5e passes the same flag for the same reason.
    await manager.close({ animate: false, skipConfirmation: true });
    // Released *after* the close settles, and by hand: the takeover suppressed the manager's render,
    // so `ApplicationV2#close` returns early on an element-less application without ever firing the
    // `close` event Ember's builder is waiting on.
    manager.dispatchEvent(new Event("close"));
  } catch ( err ) {
    log("failed to release Ember's character creation hand-off", err);
  }
}
