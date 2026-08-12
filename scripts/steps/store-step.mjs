import { t, storeConfig } from "../config.mjs";
import { cartTotalCp, equipmentBudgetCp, formatCp } from "../data/store-source.mjs";
import { summarizeOption } from "../data/equipment-source.mjs";

/**
 * The Store step: spend the starting gold the Equipment step yielded on gear from the
 * GM-configured shop. It sits after Equipment because the budget *is* that step's outcome —
 * the lettered "gold" option and any package/description currency — and like Equipment it's
 * optional: an empty cart is a valid choice, so the step never gates Create beyond having
 * been seen (and never letting the cart exceed the budget, which can only happen when the
 * player shops and then switches to a poorer equipment option).
 *
 * Visibility follows the GM's master toggle alone, so with the store enabled the step always
 * holds its numbered place in the rail and the flow's step count never shifts under the
 * player mid-build; switched off, the feature is absent and the step drops out. Note this is
 * deliberately *not* keyed to whether there's gold yet: an empty wallet is a transient
 * consequence of an equipment choice the player can still change (and the budget isn't even
 * resolved until the Equipment step renders), unlike the permanent "non-caster" that greys
 * the Spells step. Having no gold is instead reported inside the step body.
 *
 * Stock and prices come from {@link module:data/store-source}; the player's cart lives in
 * `state.store.purchases` as `uuid -> {qty, cp, name, img}` with the unit price cached at
 * add time.
 */

/**
 * The order the shelf sections appear in, and the icon each one gets.
 *
 * The goods used to be one alphabetical list under a single "Goods" heading, which put a
 * battleaxe between a bedroll and a bell. Alphabetical is the right order *within* a kind of
 * thing and the wrong one across kinds: nobody shops for "something beginning with B", they shop
 * for a weapon, or armour, or rope. The containers already had their own headed section — this is
 * the same treatment for everything else.
 *
 * Weapons and armour first because they are what a level-1 character is usually short of, then
 * the consumables, then the tools and sundries. Any item type not listed (a system or module adds
 * one) still gets a section; it sorts to the end by its localised label rather than being dropped.
 * Icons are FontAwesome 6 Free Solid, which is what Foundry ships.
 *
 * A section is keyed on the item type with one deliberate exception: armour. dnd5e files armour
 * and clothing and rings and wands all as `type: "equipment"`, so grouping on the type alone put
 * a suit of plate, a signet ring and a wand of wonder under one heading — which is the same
 * complaint as the original single "Goods" list, one level down. The armour subtypes are exactly
 * the keys of CONFIG.DND5E.armorTypes (light/medium/heavy/natural/shield), so they split out into
 * their own section and the remainder keeps the system's own "Equipment" label. See sectionKey().
 */
const STORE_SECTIONS = [
  { key: "weapon", icon: "fa-gavel" },
  { key: "armor", icon: "fa-shield-halved" },
  { key: "equipment", icon: "fa-shirt" },
  { key: "consumable", icon: "fa-flask" },
  { key: "tool", icon: "fa-screwdriver-wrench" },
  { key: "loot", icon: "fa-box" }
];
const STORE_SECTION_FALLBACK_ICON = "fa-boxes-stacked";

/**
 * Which shelf section a stock entry belongs in: its item type, except that `equipment` splits
 * into armour and everything else.
 *
 * Read from CONFIG rather than a hard-coded list of subtype keys, so a system update that adds an
 * armour kind files it correctly without a change here.
 * @param {object} entry  A stock entry (`type` plus dnd5e's `subtype`).
 * @returns {string}
 */
function sectionKey(entry) {
  if ( entry.type !== "equipment" ) return entry.type;
  return (entry.subtype in (CONFIG.DND5E?.armorTypes ?? {})) ? "armor" : "equipment";
}

/**
 * Split the shelf cards into headed sections, in {@link STORE_SECTIONS} order.
 * @param {object[]} cards            Cards from the goods stock, already filtered and sorted by name.
 * @param {(key: string) => string} label  The localiser for a section key.
 * @returns {object[]}  `{key, label, icon, cards}`, empty sections omitted.
 */
function groupCards(cards, label) {
  const bySection = new Map();
  for ( const card of cards ) {
    if ( !bySection.has(card.section) ) bySection.set(card.section, []);
    bySection.get(card.section).push(card);
  }
  const known = STORE_SECTIONS
    .filter(s => bySection.has(s.key))
    .map(s => ({ key: s.key, label: label(s.key), icon: s.icon, cards: bySection.get(s.key) }));
  const extra = [...bySection.keys()]
    .filter(key => !STORE_SECTIONS.some(s => s.key === key))
    .map(key => ({ key, label: label(key), icon: STORE_SECTION_FALLBACK_ICON, cards: bySection.get(key) }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
  return [...known, ...extra];
}

/** Whether the GM has switched the store on for this world. */
function storeEnabled() {
  return storeConfig().enabled;
}

/** Whether the player's current equipment choice actually leaves gold to spend. */
function hasBudget(state) {
  return (state.storeBudgetCp ?? 0) > 0;
}

/** The remaining budget in copper after the current cart. */
function remainingCp(state) {
  return (state.storeBudgetCp ?? 0) - cartTotalCp(state.store.purchases);
}

export const storeStep = {
  id: "store",
  icon: "fa-solid fa-shop",
  labelKey: "step.store.label",
  template: "steps/store",

  // A step is dropped from the flow only when it opts in here *and* reports itself
  // inapplicable — which for the store means the GM has switched it off. While it is on,
  // `applicable` stays true so the rail shows its ordinal rather than the greyed dash.
  hideWhenInapplicable: true,

  applicable() {
    return storeEnabled();
  },

  // Optional like Equipment: complete once seen — unless the cart has come to exceed the
  // budget (the player shopped, then picked a poorer equipment option), which must block.
  isComplete(state) {
    if ( !storeEnabled() ) return true;
    if ( remainingCp(state) < 0 ) return false;
    return !!state.storeVisited;
  },

  onEnter(state) {
    state.storeVisited = true;
  },

  incompleteHint(state) {
    if ( remainingCp(state) < 0 ) return t("step.store.overBudget");
    return null;
  },

  /** Rail summary: how many items are in the cart and what they total. */
  summary(state) {
    if ( !storeEnabled() ) return "";
    const purchases = state.store.purchases;
    const count = Object.values(purchases).reduce((n, p) => n + (Number(p?.qty) || 0), 0);
    if ( !count ) return "";
    return t("step.store.summary", { count, total: formatCp(cartTotalCp(purchases)) });
  },

  async handle(action, el, { state }) {
    const purchases = state.store.purchases;
    if ( action === "store-add" ) {
      const uuid = el.dataset.uuid;
      const cp = Number(el.dataset.cp) || 0;
      if ( cp <= 0 || cp > remainingCp(state) ) return;    // can't afford another one
      const entry = purchases[uuid] ??= { qty: 0, cp, name: el.dataset.name ?? "", img: el.dataset.img ?? "" };
      entry.qty += 1;
      entry.cp = cp;                                       // keep the cached price current
      return;
    }
    if ( action === "store-remove" ) {
      const entry = purchases[el.dataset.uuid];
      if ( !entry ) return;
      entry.qty -= 1;
      if ( entry.qty <= 0 ) delete purchases[el.dataset.uuid];
      return;
    }
    if ( action === "store-clear" ) {
      state.store.purchases = {};
      return;
    }
    if ( action === "store-category" ) {
      state.storeCategory = el.value ?? "";
      state.storeSubtype = "";   // subtype keys only mean anything inside their category
      return;
    }
    if ( action === "store-subtype" ) {
      state.storeSubtype = el.value ?? "";
    }
  },

  async context({ state, source, equipment, store }) {
    const config = storeConfig();
    // Refresh the cached budget from the live equipment selection, so the gates and this
    // render agree even when the player changed their gear since last visiting.
    const loaded = await equipment.load(state, source);
    state.storeBudgetCp = await equipmentBudgetCp(loaded, state);
    // The shop opens only once there's money to spend. The step keeps its numbered place in
    // the rail either way, so an empty wallet explains itself here rather than as a dash.
    if ( !storeEnabled() || !hasBudget(state) ) return { hasBudget: false, hint: t("step.store.none") };

    const stock = await store.stock(config);
    const purchases = state.store.purchases;
    const budgetCp = state.storeBudgetCp;
    const cartCp = cartTotalCp(purchases);
    const remaining = budgetCp - cartCp;

    // Containers (the adventuring packs and any other bundles the GM stocks) get their own
    // pinned shelf section, so they sit apart from the general goods and out of its filters.
    const packStock = stock.filter(e => e.type === "container");
    const goodsStock = stock.filter(e => e.type !== "container");

    // Category filter: only the types actually present in the general goods are offered.
    const category = state.storeCategory ?? "";
    const typeLabel = type => {
      const key = CONFIG.Item?.typeLabels?.[type];
      const label = key ? game.i18n.localize(key) : type;
      return label === key ? type : label;
    };
    const categories = [...new Set(goodsStock.map(e => e.type))].sort()
      .map(type => ({ value: type, label: typeLabel(type), selected: type === category }));

    // Subtype filter: with a category chosen, the dnd5e subtypes present within it
    // (simple/martial weapons, armor classes, potion vs ammo, …). The label maps are
    // pre-localised by the system; consumable/loot entries are objects with a `label`.
    const subtype = category ? (state.storeSubtype ?? "") : "";
    const subtypeLabel = key => {
      const map = {
        weapon: CONFIG.DND5E?.weaponTypes,
        equipment: CONFIG.DND5E?.equipmentTypes,
        consumable: CONFIG.DND5E?.consumableTypes,
        tool: CONFIG.DND5E?.toolTypes,
        loot: CONFIG.DND5E?.lootTypes
      }[category]?.[key];
      return (typeof map === "string" ? map : map?.label) || key;
    };
    const subtypes = !category ? [] : [...new Set(goodsStock.filter(e => e.type === category).map(e => e.subtype))]
      .filter(Boolean)
      .map(key => ({ value: key, label: subtypeLabel(key), selected: key === subtype }))
      .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));

    // Stock entries arrive priced final (override or multiplied base) from the source.
    const toCard = e => {
      const qty = purchases[e.uuid]?.qty ?? 0;
      return {
        uuid: e.uuid, name: e.name, img: e.img, cp: e.cp,
        price: formatCp(e.cp),
        // `section` for the grouping below; `typeLabel` for the line under the name, which stays
        // useful because the subtype (Martial, Heavy Armor…) is not in the heading.
        section: sectionKey(e),
        typeLabel: typeLabel(e.type),
        qty, inCart: qty > 0,
        canAfford: e.cp <= remaining
      };
    };
    const cards = goodsStock
      .filter(e => (!category || e.type === category) && (!subtype || e.subtype === subtype))
      .map(toCard);
    // The pack shelf steps aside while a category/kind filter narrows the general goods.
    const packCards = category ? [] : packStock.map(toCard);

    // What the class/background equipment choice already grants, shown greyed out at the
    // top of the cart so the full loadout is visible and nothing gets bought twice. These
    // come from the Equipment step's selection, so they aren't editable here — a gold-type
    // option grants no gear and contributes nothing. Cheap: the summary walks the already-
    // loaded trees without resolving any documents.
    const granted = [];
    for ( const key of ["class", "background"] ) {
      if ( !loaded[key] ) continue;
      const { items } = summarizeOption(loaded[key], state.equipment[key]);
      for ( const it of items ) {
        granted.push({
          name: it.name,
          img: it.img || "icons/svg/item-bag.svg",
          qty: (Number(it.count) || 1) > 1 ? it.count : null,
          uuid: it.uuid ?? null
        });
      }
    }

    // The cart, priced as added, for the sticky panel.
    const cart = Object.entries(purchases)
      .filter(([, p]) => (Number(p?.qty) || 0) > 0)
      .map(([uuid, p]) => ({
        uuid, name: p.name, img: p.img, qty: p.qty,
        line: formatCp(p.qty * p.cp)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    return {
      hasBudget: true,
      intro: t("step.store.intro"),
      // The goods, split into headed sections — see groupCards(). `cards` is kept alongside for
      // the count and for anything that wants the flat list.
      //
      // "armor" is our own section key rather than a dnd5e item type, so it needs its own string;
      // every other key is a real item type and takes the system's label, which keeps the headings
      // and the category dropdown speaking the same words.
      groups: groupCards(cards, key => key === "armor" ? t("step.store.armorHeading") : typeLabel(key)),
      cards,
      packCards,
      hasPacks: packCards.length > 0,
      hasGoods: cards.length > 0,
      count: cards.length + packCards.length,
      categories,
      hasCategories: categories.length > 1,
      subtypes,
      hasSubtypes: subtypes.length > 1,
      cart,
      hasCart: cart.length > 0,
      granted,
      hasGranted: granted.length > 0,
      budget: formatCp(budgetCp),
      cartTotal: formatCp(cartCp),
      remaining: formatCp(Math.max(0, remaining)),
      overBudget: remaining < 0,
      overBudgetBy: remaining < 0 ? formatCp(-remaining) : null
    };
  }
};
