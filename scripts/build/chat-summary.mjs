import {
  ABILITIES, MODULE_ID, formatMod, sourceUuid, t, tpl, log,
  creationSummaryMode, levelUpSummaryMode
} from "../config.mjs";
import { slotChanges } from "../levelup/steps/lvl-review-step.mjs";

/**
 * The chat cards this module posts when a character is finished and when a level-up is applied.
 *
 * Two shapes, one module, because they answer the same table-facing question — "what just happened
 * to this character?" — and share the whisper/permission plumbing below.
 *
 *   - {@link postCreationSummary} reads a *finished* actor. Everything on a new character is new,
 *     so there is nothing to diff: the card is a snapshot.
 *   - {@link captureLevelUpSummary} + {@link postLevelUpSummary} are a pair, and the split matters.
 *     A level-up's story is the difference between the driver's clone and the real actor, and that
 *     difference only exists *before* the commit — afterwards the two agree and there is nothing
 *     left to read. So the shell captures a plain-data snapshot first, commits, then posts it.
 *
 * Nothing here is allowed to break the flow that called it. A character that was built, or a level
 * that was applied, must not be undone by a chat card failing to render — so every entry point
 * swallows its own errors into the debug log and returns.
 *
 * For a junior dev: `capture…` runs BEFORE `driver.commit()`, `post…` runs AFTER. Swapping that
 * order silently produces an empty card, because a committed actor and its clone are identical.
 */

/* -------------------------------------------- */
/*  Posting                                     */
/* -------------------------------------------- */

/**
 * Render one of the card templates and drop it in the chat log, attributed to the character.
 *
 * `"gm"` resolves to a whisper at post time rather than at setting-read time, so a GM logging in
 * later is covered by the same call. An empty whisper array is Foundry's "everyone".
 * @param {Actor5e} actor              The character the card is about (the message's speaker).
 * @param {"creation"|"levelup"} kind  Which template to render, and the flag left on the message.
 * @param {"public"|"gm"} mode         Who should see it; `"off"` never reaches here.
 * @param {object} context             Template context.
 * @returns {Promise<void>}
 */
async function postCard(actor, kind, mode, context) {
  const render = foundry.applications.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  if ( typeof render !== "function" ) return;
  const content = await render(tpl(`chat/${kind}.hbs`), context);
  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: mode === "gm" ? ChatMessage.getWhisperRecipients("GM").map(u => u.id) : [],
    // Lets a GM (or another module) find and filter this module's cards without parsing the HTML.
    flags: { [MODULE_ID]: { summary: kind } }
  });
}

/* -------------------------------------------- */
/*  Shared pieces                               */
/* -------------------------------------------- */

/**
 * The six ability plates both cards carry, read off an actor.
 * @param {Actor5e} actor
 * @returns {{key: string, abbr: string, value: number, modifier: string}[]}
 */
function abilityPlates(actor) {
  return ABILITIES.map(key => {
    const value = actor.system?.abilities?.[key]?.value ?? 10;
    return {
      key,
      abbr: CONFIG.DND5E?.abilities?.[key]?.abbreviation ?? key.slice(0, 3).toUpperCase(),
      value,
      modifier: formatMod(value)
    };
  });
}

/**
 * Every class the character holds, in sheet order, as linkable segments: `[{label, uuid}]` reading
 * "Wizard 5", "Fighter 2". A list rather than one joined string because each segment is its own
 * link — joining them first would leave the template a sentence it cannot put anchors inside.
 * @param {Actor5e} actor
 */
function classSegments(actor) {
  return actor.items
    .filter(i => i.type === "class")
    .map(c => ({ label: `${c.name} ${c.system?.levels ?? 1}`, uuid: sourceUuid(c) }));
}

/**
 * Collapse a list of `{name, uuid}` to one entry per thing, in display order.
 *
 * Keyed on the uuid where there is one so two grants of the same feature collapse even if one
 * arrived without a name match, and on the name otherwise — which is what the plain `new Set` of
 * names did before these carried uuids at all.
 * @param {{name: string, uuid: string}[]} entries
 */
function dedupe(entries) {
  const byKey = new Map();
  for ( const entry of entries ) {
    const key = entry.uuid || entry.name;
    if ( !byKey.has(key) ) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/* -------------------------------------------- */
/*  Creation                                    */
/* -------------------------------------------- */

/**
 * Announce a finished character. Called once the actor is fully built — after the starting-level
 * chain when there is one, so the card shows the level the player actually asked for rather than
 * the level 1 the creator hands off at.
 *
 * Safe to call with a null actor (a build that failed part-way), and safe to call when the setting
 * is off; both are no-ops.
 * @param {Actor5e|null} actor
 * @returns {Promise<void>}
 */
export async function postCreationSummary(actor) {
  try {
    if ( !actor ) return;
    const mode = creationSummaryMode();
    if ( mode === "off" ) return;

    const sys = actor.system ?? {};
    const subclasses = actor.items
      .filter(i => i.type === "subclass")
      .map(i => ({ name: i.name, uuid: sourceUuid(i) }));

    // A row's value is either plain text (`value`) or a list of linkable things (`items`); the
    // template picks. Hit points and armour class are numbers and stay text — there is nothing
    // behind them to open.
    const rows = [];
    const species = actor.items.find(i => i.type === "race");
    const background = actor.items.find(i => i.type === "background");
    if ( species ) rows.push({
      label: t("chat.creation.species"),
      items: [{ name: species.name, uuid: sourceUuid(species) }]
    });
    if ( background ) rows.push({
      label: t("chat.creation.background"),
      items: [{ name: background.name, uuid: sourceUuid(background) }]
    });
    if ( subclasses.length ) rows.push({ label: t("chat.creation.subclass"), items: subclasses });
    rows.push({ label: t("chat.creation.hitPoints"), value: String(sys.attributes?.hp?.max ?? 0) });
    const ac = sys.attributes?.ac?.value;
    if ( ac ) rows.push({ label: t("chat.creation.armourClass"), value: String(ac) });

    await postCard(actor, "creation", mode, {
      heading: t("chat.creation.heading"),
      name: actor.name,
      img: actor.img || "icons/svg/mystery-man.svg",
      // The level and the classes are two pieces rather than one sentence, because each class is
      // its own link and a formatted string has nowhere to put an anchor.
      levelLabel: t("chat.creation.levelOnly", { level: sys.details?.level ?? 1 }),
      classes: classSegments(actor),
      abilities: abilityPlates(actor),
      rows
    });
  } catch ( err ) {
    // A card is never worth losing a built character over.
    log("creation chat summary failed", err);
  }
}

/* -------------------------------------------- */
/*  Level-up                                    */
/* -------------------------------------------- */

/**
 * Freeze what this level-up changes, as plain data, while the difference is still readable.
 *
 * Must be called *before* {@link LevelUpDriver#commit}: the whole summary is a diff of the driver's
 * clone against the real actor, and the commit is precisely the moment those stop differing. The
 * spell picks are the exception — they are staged on the state by the spell step and not written
 * until after the commit, so they are read from the state rather than diffed.
 * @param {import("../levelup/levelup-state.mjs").LevelUpState} state
 * @returns {object|null}   A snapshot for {@link postLevelUpSummary}, or null if there is nothing
 *                          to say (or the state is too incomplete to read).
 */
export function captureLevelUpSummary(state) {
  try {
    const clone = state?.driver?.clone;
    const actor = state?.actor;
    if ( !clone || !actor ) return null;

    // Everything on the clone that the actor doesn't have is this level-up's doing.
    const features = [];
    const spells = [];
    let subclass = null;
    for ( const item of clone.items ) {
      if ( actor.items.get(item.id) ) continue;
      if ( item.type === "subclass" ) { subclass = { name: item.name, uuid: sourceUuid(item) }; continue; }
      if ( ["class", "race", "background"].includes(item.type) ) continue;
      (item.type === "spell" ? spells : features).push({ name: item.name, uuid: sourceUuid(item) });
    }

    // Classes whose level moved — usually one, but a multiclass level adds a brand-new class with
    // no "before", which reads as "Fighter 1" rather than a nonsensical "0 → 1".
    const classes = [];
    for ( const cls of clone.items.filter(i => i.type === "class") ) {
      const existing = actor.items.get(cls.id);
      const from = existing?.system?.levels ?? 0;
      const to = cls.system?.levels ?? from;
      if ( to === from ) continue;
      classes.push({ name: cls.name, from, to, isNew: !existing, uuid: sourceUuid(cls) });
    }

    // Spells chosen on the pre-review spell step. They live on the state (not the clone) until the
    // shell writes them after the commit, so they have to be added by hand.
    try {
      const plan = state.spellPlan();
      if ( plan.isSpellcaster ) {
        // These already carry a compendium uuid — the spell step stored one when it built the pick
        // (see lvl-spells-step.mjs) — so take it rather than deriving one from a document that
        // does not exist on the clone yet.
        for ( const s of [...state.selectedCantrips, ...state.selectedSpells] ) {
          spells.push({ name: s.name, uuid: s.uuid ?? "" });
        }
      }
    } catch ( err ) {
      // A non-caster, or a state without a spell step at all: the rest of the card is still good.
      log("level-up chat summary: spell plan unavailable", err);
    }

    const hpMax = clone.system?.attributes?.hp?.max ?? 0;
    const prevHpMax = actor.system?.attributes?.hp?.max ?? 0;

    return {
      fromLevel: actor.system?.details?.level ?? 0,
      toLevel: clone.system?.details?.level ?? 0,
      classes,
      subclass,
      hpGain: Math.max(0, hpMax - prevHpMax),
      hpMax,
      profWas: actor.system?.attributes?.prof ?? 0,
      profNow: clone.system?.attributes?.prof ?? 0,
      slots: slotChanges(clone, actor),
      features: dedupe(features),
      spells: dedupe(spells)
    };
  } catch ( err ) {
    log("level-up chat summary capture failed", err);
    return null;
  }
}

/**
 * Post the snapshot {@link captureLevelUpSummary} took, once the level-up has actually landed.
 * A null snapshot (nothing changed, or the capture failed) posts nothing.
 * @param {Actor5e|null} actor
 * @param {object|null} snapshot
 * @returns {Promise<void>}
 */
export async function postLevelUpSummary(actor, snapshot) {
  try {
    if ( !actor || !snapshot ) return;
    const mode = levelUpSummaryMode();
    if ( mode === "off" ) return;

    const rows = [];
    if ( snapshot.hpGain ) rows.push({
      label: t("chat.levelup.hitPoints"),
      value: t("chat.levelup.hitPointsValue", { gain: snapshot.hpGain, max: snapshot.hpMax })
    });
    if ( snapshot.subclass ) rows.push({
      label: t("chat.levelup.subclass"),
      items: [snapshot.subclass]
    });
    if ( snapshot.profNow !== snapshot.profWas ) rows.push({
      label: t("chat.levelup.profBonus"),
      value: `+${snapshot.profWas} → +${snapshot.profNow}`
    });
    for ( const slot of snapshot.slots ) rows.push({
      label: t("chat.levelup.spellSlots"),
      value: `${slot.label} ${slot.change}`
    });

    // A level-up that moved no class, granted nothing and changed no number has no story worth a
    // card — bail rather than posting an empty one.
    if ( !rows.length && !snapshot.features.length && !snapshot.spells.length && !snapshot.classes.length ) return;

    // One formatted string per class ("Fighter 4 → 5"), so each is a whole label an anchor can wrap
    // — which is why linking these needs no change to the i18n strings themselves.
    const classes = snapshot.classes.map(c => ({
      label: c.isNew
        ? t("chat.levelup.classNew", { name: c.name, level: c.to })
        : t("chat.levelup.classLine", { name: c.name, from: c.from, to: c.to }),
      uuid: c.uuid ?? ""
    }));

    await postCard(actor, "levelup", mode, {
      heading: t("chat.levelup.heading"),
      name: actor.name,
      img: actor.img || "icons/svg/mystery-man.svg",
      classes,
      levelLine: t("chat.levelup.levelLine", { from: snapshot.fromLevel, to: snapshot.toLevel }),
      rows,
      features: snapshot.features,
      featuresLabel: t("chat.levelup.features"),
      spells: snapshot.spells,
      spellsLabel: t("chat.levelup.spells")
    });
  } catch ( err ) {
    log("level-up chat summary failed", err);
  }
}
