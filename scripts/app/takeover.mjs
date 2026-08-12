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
 * The obvious fix — raise the other window — does not hold, and the file-picker case proved it:
 * Foundry rewrites an ApplicationV2's inline z-index on every render, so a window that re-renders
 * (a FilePicker changing folder, a sheet switching tab) drops straight back under us. Beating that
 * from CSS means naming someone else's window in a selector and depending on class names that are
 * not ours across Foundry versions.
 *
 * So we lower ourselves instead. `.is-yielding` drops the takeover to z-index 90 — just below
 * Foundry's window layer — which leaves it full-screen and perfectly visible while letting floating
 * windows come over it. It is our element, so it survives any number of re-renders of theirs.
 *
 * Two things this module adds over the single-use version that lived in details-step.mjs:
 *
 *   - **Counting.** More than one foreign window can be open at once (two item sheets from two
 *     content links). A plain add/remove restores the takeover when the *first* one closes and
 *     buries the rest. The count lives on the takeover element rather than in a module-level set,
 *     so it cannot leak: a new takeover is a new element and starts at zero however the last
 *     session ended.
 *
 *   - **Automatic yielding.** Nothing has to remember to call this. Content links are handled by
 *     Foundry's own global listener, so we never see the click and never get a handle on the sheet
 *     it opens — {@link watchForeignWindows} picks them up from the render hook instead.
 */

/** The live fullscreen takeover element, or null in windowed mode (which stacks correctly already). */
function takeoverRoot() {
  return document.querySelector(".sogrom-creator-fullscreen");
}

/**
 * Move the yield count on the takeover and apply/remove the class to match.
 * @param {HTMLElement|null} root
 * @param {number} delta
 */
function countYield(root, delta) {
  if ( !root ) return;
  const next = Math.max(0, (Number(root.dataset.yieldCount) || 0) + delta);
  root.dataset.yieldCount = String(next);
  root.classList.toggle("is-yielding", next > 0);
}

/**
 * Step the fullscreen takeover below Foundry's window layer for as long as `application` is open.
 *
 * Safe to call repeatedly for the same application — a re-render must not count twice, so the first
 * call marks it and later ones return. `close()` is wrapped rather than hooked so that every exit
 * path restores us: choosing a file, cancelling, pressing Escape, or the window being closed by
 * something else entirely.
 *
 * @param {foundry.applications.api.ApplicationV2} application
 */
export function yieldTakeoverTo(application) {
  const root = takeoverRoot();
  if ( !root || !application ) return;     // windowed mode already stacks correctly
  if ( application.__sogromYielded ) return;
  application.__sogromYielded = true;

  countYield(root, 1);
  const close = application.close.bind(application);
  application.close = async (...args) => {
    try {
      return await close(...args);
    } finally {
      application.__sogromYielded = false;
      // Re-query rather than closing over `root`: the takeover may have been torn down and rebuilt
      // while this window was open, and decrementing a detached element would strand the live one.
      countYield(takeoverRoot(), -1);
    }
  };
}

/**
 * Yield to any document sheet that opens while a fullscreen takeover is up.
 *
 * This exists for the content links our own screens render — the Review step's features, spells and
 * gear, the granted-item lists on a class page. Those are Foundry's `.content-link` anchors, handled
 * by a global listener inside the system, so the click never reaches us and there is no callback to
 * hang a yield on. Watching the render hook is the only seam that catches them.
 *
 * Deliberately narrow. `renderApplicationV2` fires for *every* ApplicationV2 in the world (the hook
 * dispatcher walks the whole inheritance chain), so this filters down to framed windows that
 * actually represent a document — item, actor and journal sheets — and skips our own shells, which
 * would otherwise ask the takeover to step below itself.
 */
export function watchForeignWindows() {
  Hooks.on("renderApplicationV2", application => {
    try {
      if ( !takeoverRoot() ) return;                                  // no takeover on screen
      if ( !application?.document ) return;                           // not a document sheet
      if ( application.hasFrame === false ) return;                   // unframed overlay, not a window
      // Our own shells are ApplicationV2 too. They carry `sogrom-creator` from DEFAULT_OPTIONS.
      if ( application.element?.classList?.contains("sogrom-creator") ) return;
      yieldTakeoverTo(application);
    } catch ( err ) {
      // Never let a stacking nicety break someone else's window opening.
      log("could not yield the takeover to a foreign window", err);
    }
  });
}
