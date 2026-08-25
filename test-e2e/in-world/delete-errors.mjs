/**
 * Attribute Foundry's `Item "<id>" does not exist!` deletion failures to the build that caused them.
 *
 * The console stream cannot answer "which subclass, at which level" on its own: it carries no
 * scenario or level markers, and the ids in the errors are *actor-local*, regenerated every run and
 * gone with the actor when the scenario tears down. So a run's `console.log` can be counted but
 * never attributed after the fact — the attribution has to be recorded as it happens.
 *
 * The mechanism these errors come from is described in the README's "Foundry 14.367" section: one
 * stale id rejects an entire `deleteEmbeddedDocuments` batch, and `#complete` fires its batch from an
 * un-awaited call, so the rejection surfaces as an `unhandledrejection` rather than anywhere a
 * `try`/`catch` could see it.
 *
 * **Why timestamps rather than a hook in the walk.** `onLevel` already fires once per side per level,
 * and an error necessarily lands *between* two of those marks. Bucketing on time therefore needs no
 * change to `driveManager` or to either adapter — the thing being measured is exactly the thing that
 * would be most easily perturbed by instrumenting it.
 */

/** Errors seen since the last {@link begin}, newest last. @type {{t: number, message: string}[]} */
let errors = [];

/** Side/level boundaries, in the order they were marked. @type {{t: number, side: string, level: number}[]} */
let marks = [];

let installed = false;

/** The message shape this module exists to count. Anything else is left to the console capture. */
const PATTERN = /does not exist!/;

/**
 * Start listening. Idempotent — the listener outlives any one scenario, because a rejection raised
 * by a build can arrive after that build's last `await` has already resolved.
 */
export function install() {
  if ( installed ) return;
  installed = true;
  globalThis.addEventListener("unhandledrejection", event => {
    const message = event?.reason?.message ?? String(event?.reason ?? "");
    if ( PATTERN.test(message) ) errors.push({ t: performance.now(), message });
  });
}

/** Discard everything recorded so far. Called once per scenario. */
export function begin() {
  errors = [];
  marks = [];
}

/**
 * Mark a boundary. Level 0 means "this side is about to start building".
 * @param {string} side    `"native"` or `"creator"`.
 * @param {number} level
 */
export function mark(side, level) {
  marks.push({ t: performance.now(), side, level });
}

/**
 * Bucket what was recorded into the level each error happened *during*.
 *
 * A mark is written when a level finishes, so an error falling between the mark for level N and the
 * mark for level N+1 belongs to level N+1; anything after a side's level-0 mark but before its first
 * level mark belongs to level 1. Errors arriving after the final mark are attributed to that side's
 * last level.
 * @returns {{total: number, first: {side: string, level: number}|null, byLevel: object[]}}
 */
export function collect() {
  if ( !errors.length ) return { total: 0, first: null, byLevel: [] };

  const ordered = [...marks].sort((a, b) => a.t - b.t);
  const counts = new Map();
  let unattributed = 0;
  // `first` must be the earliest error *in time*, not the lowest level number: the native side is
  // built first, so a native divergence at level 4 precedes anything the creator does at level 1.
  let first = null;

  for ( const error of errors ) {
    // The last boundary crossed before this error, and the next boundary on that same side. The
    // level under construction across that window is the *next* one, because a mark is written when
    // a level finishes. With no next mark on that side the error is a trailing write from the side's
    // final level — `#complete` keeps writing after the manager has closed.
    const previous = ordered.filter(m => m.t <= error.t).at(-1);
    if ( !previous ) { unattributed++; continue; }
    const next = ordered.find(m => (m.t > error.t) && (m.side === previous.side));
    // Level 0 is the "about to start" mark: in jump mode it is the only one, and the error belongs
    // to the build as a whole rather than to any level.
    const level = next ? next.level : (previous.level || null);
    const key = `${previous.side}@${level ?? "-"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ( !first && (level !== null) ) first = { side: previous.side, level };
  }

  const byLevel = [...counts].map(([key, count]) => {
    const [side, level] = key.split("@");
    return { side, level: level === "-" ? null : Number(level), count };
  }).sort((a, b) => ((a.level ?? 0) - (b.level ?? 0)) || a.side.localeCompare(b.side));

  return { total: errors.length, first, byLevel, ...(unattributed ? { unattributed } : {}) };
}
