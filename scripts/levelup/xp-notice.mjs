import { MODULE_ID, tpl, t, log, levelUpEnabled, levelUpReadyMode } from "../config.mjs";
import { canLevelUp, triggerLevelUp } from "./intercept.mjs";

/**
 * Telling the table when a character has earned enough XP to level up.
 *
 * Nothing else in the module notices this moment: the level-up flow has a front door on the sheet
 * and in the sidebar, but both need someone to already know it is time. This closes that gap with a
 * whispered chat card carrying a button straight into the flow.
 *
 * Eligibility is read entirely off dnd5e's own derived data — `xp.max` is "XP needed for the next
 * level" (`Actor5e#prepareDerivedData` sets it from `getLevelExp(currentLevel)`), so the test is a
 * plain `value >= max` rather than a threshold table of our own.
 */

/** Flag recording the threshold a card was last posted for. See {@link shouldNotify}. */
const NOTIFIED_FLAG = "xpNotifiedThreshold";

/**
 * Whether this actor update is the moment to post a card, and for which threshold.
 *
 * Kept as a pure function so the rules below are testable without a world: every input is passed
 * in rather than read from globals.
 * @param {object} opts
 * @param {object} opts.xp              The actor's `system.details.xp` ({value, max}).
 * @param {boolean} opts.xpChanged      Whether this update touched `system.details.xp.value`.
 * @param {boolean} opts.eligible       Whether the actor can actually be levelled ({@link canLevelUp}).
 * @param {boolean} opts.usesXp         Whether the world levels by XP at all.
 * @param {number|null} opts.notified   The threshold a card was already posted for, if any.
 * @returns {number|null}   The threshold to post for, or null to stay silent.
 */
export function shouldNotify({ xp, xpChanged, eligible, usesXp, notified }) {
  if ( !xpChanged || !eligible || !usesXp ) return null;
  const max = xp?.max;
  // `xp.max` is Infinity at the level cap — there is no next level to earn.
  if ( !Number.isFinite(max) || ((xp?.value ?? 0) < max) ) return null;
  // Once per threshold, not once per unrelated update afterwards. The flag stops matching on its
  // own as soon as the character actually levels, since `xp.max` then moves to the next threshold.
  return (notified === max) ? null : max;
}

/**
 * Who should receive the card, as user ids.
 *
 * `"gm"` reaches the GM alone; `"public"` adds the character's own owners so a player can act
 * without waiting to be noticed. Deliberately never an empty array — that is Foundry's "everyone",
 * and one character crossing a threshold is not something to interrupt the whole table with.
 * @param {Actor5e} actor
 * @param {"public"|"gm"} mode
 * @returns {string[]}
 */
export function noticeRecipients(actor, mode) {
  const ids = new Set(ChatMessage.getWhisperRecipients("GM").map(u => u.id));
  if ( mode === "public" ) {
    // Every owner, not only those currently connected — a whisper keeps, so a player who logs in
    // later still finds it waiting rather than having missed the moment entirely.
    for ( const user of game.users ?? [] ) {
      if ( !user.isGM && actor.testUserPermission?.(user, "OWNER") ) ids.add(user.id);
    }
  }
  return [...ids];
}

/**
 * Post the card for `actor`, and record the threshold so it is not posted again.
 *
 * The flag is written *before* the message, so a failure to render the card cannot leave the world
 * re-posting it on every subsequent actor update.
 * @param {Actor5e} actor
 * @param {number} threshold
 * @param {"public"|"gm"} mode
 */
async function postNotice(actor, threshold, mode) {
  await actor.setFlag(MODULE_ID, NOTIFIED_FLAG, threshold);
  const render = foundry.applications.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  if ( typeof render !== "function" ) return;

  const xp = actor.system?.details?.xp ?? {};
  const content = await render(tpl("chat/levelup-ready.hbs"), {
    actorId: actor.id,
    name: actor.name,
    img: actor.img,
    value: xp.value ?? 0,
    max: threshold,
    label: t("chat.levelUpReady.button")
  });
  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: noticeRecipients(actor, mode),
    // Lets a GM (or another module) find and filter this module's cards without parsing the HTML.
    flags: { [MODULE_ID]: { summary: "levelUpReady" } }
  });
}

/**
 * Wire the XP watcher and the card's button.
 *
 * The `updateActor` hook fires on **every** connected client, so the post is gated on
 * `isActiveGM` — the one client Foundry designates — rather than `isGM`, which would post one
 * duplicate card per game master who happened to be online.
 */
export function registerXpNotice() {
  Hooks.on("updateActor", async (actor, changes) => {
    try {
      if ( !game.user.isActiveGM || !levelUpEnabled() ) return;
      const mode = levelUpReadyMode();
      if ( mode === "off" ) return;

      const threshold = shouldNotify({
        xp: actor.system?.details?.xp,
        xpChanged: foundry.utils.hasProperty(changes, "system.details.xp.value"),
        eligible: canLevelUp(actor),
        usesXp: game.settings.get("dnd5e", "levelingMode") !== "noxp",
        notified: actor.getFlag(MODULE_ID, NOTIFIED_FLAG) ?? null
      });
      if ( threshold === null ) return;

      await postNotice(actor, threshold, mode);
    } catch ( err ) {
      // This runs on every actor update in the world; it must never be what stops one saving.
      log("could not post the level-up-ready notice", err);
    }
  });

  // The card's own button. Scoped to our selector so no other module's chat cards are touched.
  Hooks.on("renderChatMessageHTML", (_message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const button = root?.querySelector("[data-sogrom-levelup-actor]");
    if ( !button ) return;
    button.addEventListener("click", () => {
      const actor = game.actors.get(button.dataset.sogromLevelupActor);
      if ( !actor ) return ui.notifications.warn(t("chat.levelUpReady.missing"));
      // Opening is local, so anyone who received the whisper may click; Foundry's own ownership
      // checks still apply the moment the flow tries to write anything.
      triggerLevelUp(actor);
    });
  });
}
