import { log } from "../config.mjs";

/**
 * Finding the rulebook's own page for a topic the wizard is currently asking about.
 *
 * A player mid-step often wants the actual rule, not our one-line hint — and the books already in
 * their world have it, written and laid out properly. This resolves a *topic* (not a step id, so
 * the same map serves both wizards) to a real `JournalEntryPage`, which
 * {@link module:app/source-details} then renders into the overlay the "Full Details" control
 * already uses.
 *
 * **The two editions are shaped completely differently**, which is most of what this file handles:
 *
 *  - **2024** keeps the whole of character creation in one entry with the stable id
 *    `phbCreatingAChar`, whose pages are named for the steps themselves ("Step 1: Choose a Class",
 *    "Step 3: Ability Scores"). A stable id means it resolves without scanning.
 *  - **2014** spreads the same ground across separate chapter entries whose ids are **random**
 *    (`5LoAJLkfIYBAgWTW` and friends) — verified against the installed system content — so those
 *    have to resolve by entry *name* and then page name.
 *
 * Nothing here reproduces any rules text; it points at content the world already has, and returns
 * null when it does not, so callers hide their control rather than offering a dead button.
 */

/** The 2024 entry, carried by both the Player's Handbook module and the system's free rules. */
const MODERN_ENTRY = "phbCreatingAChar";

/**
 * Packs to look in, best first.
 *
 * The Player's Handbook module leads because a GM who installed it gets its fuller, illustrated
 * copy of the same entry; `dnd5e.content24` is the system's free-rules fallback for a world without
 * it. A 2014 build goes to `dnd5e.rules`, which is the only place that content exists.
 */
const PACKS = {
  2024: ["dnd-players-handbook.content", "dnd5e.content24"],
  2014: ["dnd5e.rules"]
};

/**
 * topic -> where its page lives in each edition.
 *
 * Keyed by topic rather than by step id so the level-up wizard can ask for "levelUp" without
 * creation needing a step of that name, and so two steps asking the same question (species and
 * background both land on 2024's single "Character Origin" page) can share one entry.
 * A topic with no meaningful page under an edition maps to null, and callers get nothing back.
 * `page` lists the names known to carry it — the Player's Handbook module and the system's free
 * rules word the same page differently — and `prefix` is the step-number fallback (see
 * {@link pickPage}).
 *
 * Deliberately absent: **feats**. The 2014 rules have a real page for them (Chapter 6), but the 2024
 * `phbCreatingAChar` entry has none — origin feats live in a separate Feats entry entirely — and a
 * topic that silently opens "Character Creation Details" when a player asked about feats is worse
 * than no control at all. Add it when it can be pointed at the right page in both editions.
 */
const TOPICS = {
  class: {
    2024: { prefix: "Step 1:", page: ["Step 1: Choose a Class"] },
    2014: { entry: "Chapter 3: Classes", page: ["Overview"] }
  },
  species: {
    2024: { prefix: "Step 2:", page: ["Step 2: Determine Origin", "Step 2: Character Origin"] },
    2014: { entry: "Chapter 2: Races", page: ["Races"] }
  },
  background: {
    2024: { prefix: "Step 2:", page: ["Step 2: Determine Origin", "Step 2: Character Origin"] },
    2014: { entry: "Chapter 4: Personality and Background", page: ["Backgrounds"] }
  },
  abilities: {
    2024: { prefix: "Step 3:", page: ["Step 3: Determine Ability Scores", "Step 3: Ability Scores"] },
    2014: { entry: "Chapter 7: Using Ability Scores", page: ["Ability Scores and Modifiers"] }
  },
  alignment: {
    2024: { prefix: "Step 4:", page: ["Step 4: Choose an Alignment", "Step 4: Alignment"] },
    2014: { entry: "Chapter 4: Personality and Background", page: ["Alignment"] }
  },
  levelUp: {
    2024: { page: ["Gaining a Level"] },
    2014: { entry: "Chapter 1: Beyond 1st Level", page: ["Beyond 1st Level"] }
  },
  multiclassing: {
    2024: { page: ["Multiclassing"] },
    2014: { entry: "Chapter 6: Customization Options", page: ["Multiclassing"] }
  }
};

/**
 * Pick a topic's page out of an entry.
 *
 * Tries the known names in order, then — for the numbered creation steps — falls back to whatever
 * page starts with the same `Step N:` token. That fallback is what makes this survive a book that
 * words its headings differently again: the step *numbers* are fixed by the rules, the wording is
 * the publisher's. Without it four of the seven topics resolved to nothing the moment the Player's
 * Handbook module was installed, because it and the system's free rules share one entry id but name
 * its pages differently ("Step 2: Determine Origin" vs "Step 2: Character Origin").
 * @param {JournalEntry} entry
 * @param {{page: string[], prefix?: string}} target
 * @returns {JournalEntryPage|null}
 */
function pickPage(entry, target) {
  const pages = entry?.pages;
  if ( !pages ) return null;
  for ( const name of target.page ) {
    const hit = pages.find(p => p.name === name);
    if ( hit ) return hit;
  }
  if ( target.prefix ) return pages.find(p => p.name?.startsWith(target.prefix)) ?? null;
  return null;
}

/** `"topic|edition"` -> resolved page (or null). Cleared with the rest of the source caches. */
const cache = new Map();

/** Forget every resolved page. Called from `invalidateSources()` when enabled packs change. */
export function invalidateRulesPages() {
  cache.clear();
}

/** The topics this module knows how to resolve, for callers that want to validate one. */
export const RULE_TOPICS = Object.keys(TOPICS);

/**
 * Look one entry up in the first pack that has it.
 * @param {string[]} packIds
 * @param {(index: object) => object|undefined} find   Picks the wanted entry out of a pack index.
 * @returns {Promise<JournalEntry|null>}
 */
async function firstEntry(packIds, find) {
  for ( const id of packIds ) {
    // `?.get?.` rather than `?.get` — a world can legitimately have no compendium collection to ask
    // (and the unit harness has none), and "no book covering this" is a null, never a throw.
    const pack = game.packs?.get?.(id);
    if ( !pack ) continue;
    try {
      const hit = find(await pack.getIndex());
      if ( hit ) return await pack.getDocument(hit._id);
    } catch ( err ) {
      log(`could not read the rules pack ${id}`, err);
    }
  }
  return null;
}

/**
 * The rulebook page for a topic under a given edition, or null when the world has no book covering
 * it (an SRD-only world, or a homebrew-only one).
 * @param {string} topic              One of {@link RULE_TOPICS}.
 * @param {"2014"|"2024"|null} edition   Defaults to 2024, matching dnd5e's own "modern" default.
 * @returns {Promise<JournalEntryPage|null>}
 */
export async function rulesPageFor(topic, edition) {
  const rules = String(edition) === "2014" ? "2014" : "2024";
  const key = `${topic}|${rules}`;
  if ( cache.has(key) ) return cache.get(key);

  const target = TOPICS[topic]?.[rules] ?? null;
  let page = null;
  if ( target ) {
    // 2024 resolves by the entry's stable id; 2014's chapter ids are random, so it goes by name.
    const entry = await firstEntry(PACKS[rules], index => (rules === "2024")
      ? index.get(MODERN_ENTRY)
      : index.find(e => e.name === target.entry));
    page = entry ? pickPage(entry, target) : null;
  }
  cache.set(key, page);
  return page;
}

/**
 * Whether a rules page exists for a topic — so a step can decide whether to render its control at
 * all, without paying to build the overlay payload.
 * @param {string} topic
 * @param {"2014"|"2024"|null} edition
 * @returns {Promise<boolean>}
 */
export async function hasRulesPage(topic, edition) {
  return !!(await rulesPageFor(topic, edition));
}
