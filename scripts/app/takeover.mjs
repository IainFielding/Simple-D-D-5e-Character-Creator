import { log } from "../config.mjs";

/**
 * Keeping other people's windows visible over the fullscreen takeover.
 *
 * The creator and the level-up wizard run as a fixed, viewport-filling element sitting just under
 * Foundry's tooltip layer (~9998) — high enough that an open actor sheet behind them can't peek
 * through, which is the entire point of a takeover. The cost is that *every* Foundry window is
 * behind them too, including ones the player deliberately opened from inside our own UI: click a
 * content link on the Review screen and the item sheet renders faithfully, at a z-index in the
 * low hundreds, completely hidden underneath us.
 *
 * So the window that was opened is raised above us, and we stay where we are.
 *
 * This is the second design. The first lowered the takeover instead — a `.is-yielding` class
 * dropping it to z-index 90 — on the reasoning that changing our own element is more reliable than
 * out-specifying an inline z-index that Foundry rewrites on every render of a window whose class
 * names we don't control.
 *
 * Both halves of that were wrong. Lowering ourselves below Foundry's window layer does not reveal
 * *the* window, it reveals *every* window — and the fullscreen rule's own comment names the one
 * that matters: "an open app — e.g. the actor sheet a level-up launches from — can't peek through
 * the takeover". Clicking a single item on the Review screen therefore brought up the item sheet
 * and the character sheet sitting behind it, which is not what anyone asked for.
 *
 * And we do not have to name anyone else's class names. The render hook hands us the application,
 * so we can put *our own* class on its element, and `!important` beats the inline z-index Foundry
 * rewrites on render and on focus. That is not a new trick here: the same one already lifts the
 * dnd5e Compendium Browser over the takeover from creator.css, for exactly this reason.
 *
 * Raising rather than lowering also deletes the bookkeeping the old shape needed. There is no
 * reference count, because each window carries its own class; nothing has to be restored when a
 * window closes, because the class dies with the element it is on; and no `close` wrapper is
 * needed, so no exit path can strand us in the lowered state.
 *
 * Two things keep the raise honest, because the class sits on an element that is not ours and we
 * therefore cannot reliably take it off again:
 *
 *   - **Only on opening.** A window is raised on its *first* render, never on a re-render. What a
 *     re-render means is "this was already open behind us", and the level-up commit re-renders the
 *     character sheet mid-apply, which is precisely the window the takeover exists to cover.
 *   - **Only while a takeover is up.** The CSS gates on `body:has(.sogrom-creator-fullscreen)`, so
 *     the class goes inert when the wizard closes rather than leaving a sheet the player opened
 *     from the Review screen floating over everything for the rest of the session.
 *
 * One accepted limitation: raised windows all share one z-index, so clicking between two of them
 * cannot reorder them — they stack in DOM order. Two windows open over the takeover at once is
 * already the rare case, and it is a far smaller cost than burying either of them.
 */

/** The class that lifts someone else's window above the takeover. Styled in creator.css. */
const ABOVE_TAKEOVER = "sogrom-above-takeover";

/**
 * Every application seen render since the world loaded, so a *first* render can be told from a
 * re-render — the difference between a window opened from inside the takeover and one that was
 * already open behind it. Weak so it never holds a closed application alive.
 * @type {WeakSet<object>}
 */
const seen = new WeakSet();

/** The live fullscreen takeover element, or null in windowed mode (which stacks correctly already). */
function takeoverRoot() {
  return document.querySelector(".sogrom-creator-fullscreen");
}

/**
 * Whether a rendered application is someone else's window that the takeover would otherwise bury.
 *
 * Deliberately narrow. `renderApplicationV2` fires for *every* ApplicationV2 in the world (the hook
 * dispatcher walks the whole inheritance chain), so this filters down to framed windows that
 * actually represent a document — item, actor and journal sheets — and skips our own shells, which
 * would otherwise be asked to float above themselves.
 * @param {foundry.applications.api.ApplicationV2} application
 * @returns {boolean}
 */
export function isForeignWindow(application) {
  if ( !application?.document ) return false;                        // not a document sheet
  if ( application.hasFrame === false ) return false;                // unframed overlay, not a window
  // Our own shells are ApplicationV2 too. They carry `sogrom-creator` from DEFAULT_OPTIONS.
  return !application.element?.classList?.contains("sogrom-creator");
}

/**
 * Claim `application` as a window opened from inside the takeover, and lift it above.
 *
 * Safe to call repeatedly, and safe to call *before* the application has rendered — which is the
 * normal case for the image FilePicker, whose caller has to claim it before awaiting its render.
 * An application with no element yet is marked instead, and {@link watchForeignWindows} finishes
 * the job when it renders.
 *
 * This is the *explicit* claim, for a window we opened ourselves and therefore know the provenance
 * of. The mark it leaves outlives the current takeover, so it must never be applied speculatively —
 * {@link watchForeignWindows} calls the private `raise` for windows it merely recognises.
 *
 * @param {foundry.applications.api.ApplicationV2} application
 */
export function yieldTakeoverTo(application) {
  if ( !application ) return;
  // Marked on the application rather than tracked in a module-level set: it travels with the
  // object, so it cannot leak between sessions or outlive the window it describes.
  application.__sogromAboveTakeover = true;
  raise(application);
}

/**
 * Put the class on, if there is a takeover to clear and an element to put it on.
 * @param {foundry.applications.api.ApplicationV2} application
 */
function raise(application) {
  if ( !takeoverRoot() ) return;    // windowed mode already stacks correctly
  application.element?.classList.add(ABOVE_TAKEOVER);
}

/**
 * Raise any document sheet that opens while a fullscreen takeover is up.
 *
 * This exists for the content links our own screens render — the Review step's features, spells and
 * gear, the granted-item lists on a class page. Those are Foundry's `.content-link` anchors, handled
 * by a global listener inside the system, so the click never reaches us and there is no callback to
 * hang this on. Watching the render hook is the only seam that catches them.
 *
 * It is also what completes a claim made before the window existed — see {@link yieldTakeoverTo} —
 * and what re-applies the class if a re-render should ever replace the root element.
 */
export function watchForeignWindows() {
  Hooks.on("renderApplicationV2", application => {
    try {
      if ( !application ) return;
      // Whether this is the first time this window has rendered at all. Registered at `init`, so
      // this hook has seen every render since the world loaded.
      const opening = !seen.has(application);
      seen.add(application);

      // An explicit claim is honoured on whichever render lands first — that is the whole point of
      // being able to claim a window before it has an element (the Details step's file picker).
      if ( application.__sogromAboveTakeover ) return raise(application);

      // Only a window that *opened* while the takeover was up was opened from inside it. One that
      // merely re-renders underneath it was already there, and belongs where it is.
      //
      // The case that forces this: committing a level-up re-renders the character sheet mid-apply,
      // to surface the new level (see LevelUpDriver#commit). That sheet is the very thing the
      // takeover exists to cover, and raising it would throw it over the wizard for the moment
      // between Apply and close — turning a deliberate cover-up into a flash of the sheet on every
      // single level-up.
      if ( !opening || !isForeignWindow(application) ) return;
      // Deliberately `raise` and not `yieldTakeoverTo`: this path must leave no mark behind. A
      // window that renders with no takeover on screen has to stay a window with no claim on one,
      // or the next time a wizard opened it would jump over it — which is every window in the
      // world, since this hook sees them all.
      raise(application);
    } catch ( err ) {
      // Never let a stacking nicety break someone else's window opening.
      log("could not raise a foreign window over the takeover", err);
    }
  });
}
