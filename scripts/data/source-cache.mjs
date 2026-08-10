import { log } from "../config.mjs";
import { SourceIndex } from "./source-index.mjs";
import { SpellSource, MAGIC_INITIATE_LISTS } from "./spell-source.mjs";
import { EquipmentSource } from "./equipment-source.mjs";
import { StoreSource } from "./store-source.mjs";
import { warmChoices, resetRestrictedCache } from "./choice-resolver.mjs";
import { resetToolCache } from "./tool-source.mjs";
import { resetWeaponIcons } from "./weapon-source.mjs";
import { getEnabledPacks } from "./compendium-util.mjs";

/**
 * Shared, warm-once compendium data for the builder.
 *
 * The three data sources ({@link SourceIndex}, {@link SpellSource}, {@link EquipmentSource})
 * hold only compendium-derived caches — no per-session selection state — so a single set is
 * built and indexed once per world session and reused by every CreatorShell *and* LevelUpShell
 * (the level-up warms only what it needs — the subclass index and its spell pool — but shares
 * these instances so that work survives the window and benefits the next one). A background warm
 * kicked off at `ready` (see main.mjs) means the builder opens instantly; a window opened before
 * that finishes awaits the same in-flight work behind its loading screen. The per-window
 * {@link module:state/creator-state.CreatorState} stays separate — only these read-only indexes
 * are shared here.
 *
 * For a junior dev: "warming" means pre-reading slow compendium data into memory *before* the UI
 * asks for it, so the first render is instant instead of stalling on disk/pack reads. This module
 * is a module-level singleton (the `cache`, `warming`, and `signature` variables persist for the
 * whole session). The `warming` promise is shared so that if ten windows ask at once, the work runs
 * once and everyone awaits the same promise. "Stale" = the GM changed which compendiums are enabled,
 * so the cache no longer matches the world and must be rebuilt.
 */

/** @type {{source: SourceIndex, spells: SpellSource, equipment: EquipmentSource, store: StoreSource}|null} */
let cache = null;
/** @type {Promise<object>|null} The in-flight (or settled) warm, shared by concurrent callers. */
let warming = null;
/** Enabled-pack signature captured when the cache was warmed, for staleness detection. */
let signature = null;

/** Progress subscribers (0–100) and the latest reported value, so late subscribers catch up. */
const listeners = new Set();
let lastPct = 0;

/** A cheap signature of the world's enabled compendium sources; changes invalidate the cache. */
function packSignature() {
  const enabled = getEnabledPacks();
  return enabled ? [...enabled].sort().join("|") : "*";
}

/** The shared data sources, created (but not necessarily warmed) on first access. */
export function getSources() {
  if ( !cache ) cache = { source: new SourceIndex(), spells: new SpellSource(), equipment: new EquipmentSource(), store: new StoreSource() };
  return cache;
}

/**
 * Subscribe to warm progress. The callback fires immediately with the latest percentage and
 * again on every tick. Returns an unsubscribe function.
 * @param {(pct: number) => void} fn
 * @returns {() => void}
 */
export function onWarmProgress(fn) {
  listeners.add(fn);
  try { fn(lastPct); } catch ( err ) { log("warm progress listener failed", err); }
  return () => listeners.delete(fn);
}

function emit(pct) {
  lastPct = pct;
  for ( const fn of listeners ) {
    try { fn(pct); } catch ( err ) { log("warm progress listener failed", err); }
  }
}

/**
 * Index and warm every compendium read the builder will need, once. Concurrent callers share
 * the returned promise, so a window opening mid-warm awaits the running work rather than starting
 * its own. A no-op once warmed (unless {@link invalidateSources} cleared the cache first).
 *
 * On failure the in-flight promise is dropped so a later open can retry from the (possibly
 * partly-filled, still valid) memo caches.
 * @returns {Promise<{source: SourceIndex, spells: SpellSource, equipment: EquipmentSource}>}
 */
export function warmSources() {
  if ( warming ) return warming;
  const { source, spells, equipment } = getSources();
  signature = packSignature();
  lastPct = 0;
  warming = (async () => {
    await source.load();
    const classes = source.classes();
    const species = source.species();
    const backgrounds = source.backgrounds();
    const origins = classes.length + species.length + backgrounds.length;
    // One tick each for: origin details (warmAll), class spell lists (warmClasses), per-origin
    // advancement-choice scans (warmChoices), class+background equipment (equipment.warmAll), and
    // the Magic Initiate feat spell lists (warmLists).
    const total = origins + classes.length + origins + (classes.length + backgrounds.length)
      + MAGIC_INITIATE_LISTS.length;
    let done = 0;
    const tick = () => emit(total ? Math.round((++done / total) * 100) : 100);
    // The five phases populate separate memo caches and only depend on the index loaded
    // above, so they run concurrently rather than back to back. Each caps its own in-flight
    // reads (forEachLimit), and the shared `done` counter still totals every tick, so the
    // bar advances smoothly to 100 however the phases interleave.
    await Promise.all([
      source.warmAll(tick),
      spells.warmClasses(classes.map(c => c.uuid), tick),
      warmChoices(source, tick),
      equipment.warmAll(source, tick),
      spells.warmLists(MAGIC_INITIATE_LISTS, 1, tick)
    ]);
    emit(100);
    return cache;
  })();
  // Drop a failed warm so the next open can retry; swallow here so it isn't an unhandled rejection
  // (the awaiting caller still sees the rejection via the returned promise and notifies the user).
  warming.catch(err => { log("source warm failed", err); warming = null; });
  return warming;
}

/** True once the world's enabled-source set has changed since the cache was warmed. */
export function isStale() {
  return cache != null && signature !== packSignature();
}

/**
 * Drop the shared cache so the next {@link warmSources} rebuilds from scratch.
 *
 * The four data sources hang off `cache` and go with it, but three memos live at module scope in
 * their own files and would otherwise outlive the world they describe. All three are built by
 * scanning the *enabled* packs — the `allowDrops` restriction scan, the tool-category expansion, and
 * the PHB weapon-icon map — which is exactly the configuration whose change brought us here, so they
 * are cleared on the same beat rather than serving pre-change content for the rest of the session.
 */
export function invalidateSources() {
  cache = null;
  warming = null;
  signature = null;
  lastPct = 0;
  resetRestrictedCache();
  resetToolCache();
  resetWeaponIcons();
}
