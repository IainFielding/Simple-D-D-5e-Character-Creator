/**
 * In-world entry point. Everything below runs inside Foundry's page context, where `game`, the
 * live documents and the system's applications are all in reach; the Node side (`run.mjs`) only
 * imports this module and calls into it.
 *
 * Loaded over HTTP from the module's own directory — the working tree is junction-linked into
 * Foundry's `Data/modules`, so `test-e2e/in-world/*.mjs` is served alongside the module and can
 * use ordinary ES imports, both between these files and into the module under test.
 */

// The runner imports this file with a `?v=<timestamp>` cache-buster so edits take effect without
// restarting Foundry. Browsers cache each module URL independently, so that buster has to be
// carried onto every sibling import or only this file would ever reload.
const BUST = new URL(import.meta.url).search;

const { buildNative } = await import(`./native.mjs${BUST}`);
const { buildCreator } = await import(`./creator.mjs${BUST}`);
const { snapshot, diff } = await import(`./normalize.mjs${BUST}`);
const { SCENARIOS } = await import(`./scenarios.mjs${BUST}`);
const { AnswerBook } = await import(`./answers.mjs${BUST}`);
const { sweepScenarios } = await import(`./sweep.mjs${BUST}`);

// The module under test, imported *without* a buster — the same instance the world already loaded.
const { SourceIndex } = await import("/modules/sogrom-dnd5e-character-creator/scripts/data/source-index.mjs");

/**
 * Every actor this harness creates is named with this prefix, and cleanup only ever deletes
 * actors that carry it — so a stray run can never touch real world content. A name prefix rather
 * than a document flag because Foundry only accepts flag scopes belonging to an active package,
 * and the normaliser drops `name` from the comparison anyway.
 */
const PREFIX = "[e2e] ";

/* -------------------------------------------- */

/**
 * Fail loudly when a scenario answer was read by neither adapter.
 *
 * Silence is the dangerous case: an answer nobody asked for is simply ignored, and the run builds
 * a *different, valid-looking* character — which then reads as a divergence in the diff rather
 * than the scenario/adapter mismatch it really is.
 *
 * It has to span both sides, because an answer can legitimately be read by only one. The clearest
 * example is a half-feat's forced ability increase: the creator's driver applies a one-open-ability
 * allocation outright without ever consulting the provider, while the native flow renders a live
 * "+" button that has to be clicked. Only the native adapter reads that answer, and that is fine —
 * what would not be fine is neither reading it.
 *
 * Two answer kinds are legitimately unread by *both* and are exempt: hit points on a level-1 build
 * (the original class's first level takes maximum automatically, so no decision is ever raised),
 * and an origin's ability increase — the 2024 background's or the 2014 species' — which the creator
 * routes through `state.originAbilities` rather than through a decision record (`buildCreator`
 * marks it consumed itself).
 * @param {object} answers                  The scenario's answer table.
 * @param {Set<string>} consumed            Ids either adapter read an answer for.
 * @param {Map<string, string>} advTypes    advId -> advancement type, from the origin documents.
 * @param {object} [diagnostics]            The creator's resolver dump, for the error message.
 */
function assertAnswersConsumed(answers, consumed, advTypes, diagnostics) {
  const orphaned = Object.keys(answers)
    .filter(id => !consumed.has(id) && (advTypes.get(id) !== "HitPoints"));
  if ( !orphaned.length ) return;

  const detail = orphaned.map(id => {
    const type = advTypes.get(id);
    return `    ${id} — ${type ? `${type} on an origin item` : "not found on any origin item"}`;
  }).join("\n");
  const offered = (diagnostics?.requirements ?? [])
    .map(r => `    ${r.advId} ${r.type} "${r.title}" (${r.source})`)
    .join("\n");

  throw new Error(
    `${orphaned.length} scenario answer(s) were read by neither the native nor the creator build, `
    + `so they were silently dropped:\n${detail}\n`
    + `  the creator's resolver offered:\n${offered || "    (nothing)"}\n`
    + `  Either the advancement id is wrong (check \`run.mjs --ids <uuid>\`), or the choice is `
    + `never raised — which is itself the bug worth reporting.`
  );
}

/**
 * Fail loudly when the book was asked something it should have been able to answer and could not.
 *
 * This is the counterpart to {@link assertAnswersConsumed}: that one catches an answer nobody wanted,
 * this one catches a question nobody could answer. Both matter for the same reason — the run still
 * produces a *valid-looking* character, and the difference surfaces somewhere unrelated. In a sweep
 * it surfaces in every scenario touching the same content, which is a lot of noise for one cause.
 * @param {AnswerBook} book
 */
function assertBookComplete(book) {
  const missing = book.missing;
  if ( !missing.length ) return;
  const detail = missing
    .map(e => `    ${e.advId} ${e.type} "${e.title ?? ""}" (${e.item ?? "?"}, level ${e.level}) — ${e.missing}`)
    .join("\n");
  throw new Error(
    `${missing.length} decision(s) the answer book could not answer:\n${detail}\n`
    + `  Either the content has a shape the generator does not handle — worth teaching it — or the `
    + `scenario has to state the answer itself.`
  );
}

/**
 * Decisions only one adapter ever raised, as difference records.
 *
 * The character diff shows the *consequences* of a divergence; this shows the divergence. A choice
 * the native wizard offers and our driver never surfaces reads as a missing item at best and as
 * nothing at all at worst, and it is the single most useful thing to know when the two builds
 * disagree.
 *
 * Only decisions that were actually *answered* count. The native wizard renders a step for every
 * advancement, automatic ones included — a ScaleValue, a plain ItemGrant, a Trait that is pure
 * grants — and asks the book about each; the driver applies those without surfacing anything, which
 * is correct and would otherwise flood this with one-sided entries. An advancement nobody had an
 * answer for produced the same result on both paths by definition, so a one-sided raise there says
 * nothing. Hit points are excluded outright: a level-1 original class takes maximum automatically
 * and raises no native decision at all.
 * @param {AnswerBook} book
 */
function decisionDifferences(book) {
  return book.asymmetric().filter(e => (e.type !== "HitPoints") && (e.answer !== undefined) && (e.answer !== null)).map(e => ({
    path: `decision.raised.${e.type}.${e.advId}@${e.level}`,
    native: e.askedBy.includes("native") ? `"${e.title ?? e.advId}" on ${e.item ?? "?"}` : "<never raised>",
    creator: e.askedBy.includes("creator") ? `"${e.title ?? e.advId}" on ${e.item ?? "?"}` : "<never raised>"
  }));
}

/**
 * Line up the per-level snapshots and say where the two builds first parted company.
 *
 * A difference at level 3 is still there at level 20, so the final comparison alone says only "this
 * subclass differs" and leaves the interesting question — *when* — to a manual bisect. This answers
 * it directly: the count per level, and the first level with a non-zero one.
 *
 * The differences themselves are kept only for that first level. Every later level repeats them plus
 * whatever else has accumulated, which is a great deal of output saying one thing.
 * @param {{native: Map<number, object>, creator: Map<number, object>}} perLevel
 */
function compareLevels(perLevel) {
  const levels = [...perLevel.native.keys()].filter(l => perLevel.creator.has(l)).sort((a, b) => a - b);
  const out = { profile: [], firstDivergence: null };

  for ( const level of levels ) {
    const a = perLevel.native.get(level);
    const b = perLevel.creator.get(level);
    const differences = [...diff(a.source, b.source, "source"), ...diff(a.derived, b.derived, "derived")];
    out.profile.push({ level, count: differences.length });
    if ( differences.length && !out.firstDivergence ) out.firstDivergence = { level, differences };
  }

  // A level one side reached and the other did not is its own finding — the two builds disagree
  // about how far the character got, which no amount of field-by-field diffing would explain.
  const only = side => [...perLevel[side].keys()].filter(l => !perLevel[side === "native" ? "creator" : "native"].has(l));
  const missing = { native: only("creator"), creator: only("native") };
  if ( missing.native.length || missing.creator.length ) out.missing = missing;
  return out;
}

/** advId -> advancement type across the scenario's origin documents. */
function advancementTypes(docs) {
  const map = new Map();
  for ( const doc of docs ) {
    for ( const adv of Object.values(doc?.advancement?.byId ?? {}) ) map.set(adv.id, adv.type);
  }
  return map;
}

/* -------------------------------------------- */

/** Delete every actor a previous run left behind. */
export async function cleanup() {
  const ids = game.actors.filter(a => a.name.startsWith(PREFIX)).map(a => a.id);
  if ( ids.length ) await Actor.implementation.deleteDocuments(ids, { render: false });
  return ids.length;
}

/* -------------------------------------------- */

/**
 * Run one scenario: build it both ways, compare, and return a report.
 * @param {object} scenario
 * @param {object} [options]
 * @param {boolean} [options.keep]   Leave the built actors in the world for inspection.
 */
export async function runScenario(scenario, { keep = false, render = false } = {}) {
  const started = performance.now();
  const report = {
    id: scenario.id, name: scenario.name, ok: false, differences: [], error: null,
    // The creator's view of what it was asked: every choice the resolver raised and how the
    // scenario answered it. Always collected — it is the first thing you want when a scenario
    // fails, and it is cheap.
    diagnostics: {}
  };
  let native = null;
  let creator = null;

  try {
    // One book, both adapters. It answers each decision once and hands the identical answer to
    // whoever asks second, which is what makes a generated scenario comparable at all: the two
    // builds walk in different orders off different clones and still cannot disagree about what was
    // chosen. A scenario without `generate` answers only from its own table, exactly as before.
    const book = new AnswerBook({ overrides: scenario.answers ?? {}, generate: !!scenario.generate, asiFeats: !!scenario.asiFeats });

    // Both adapters record which answers they actually read, so an answer nobody wanted can be
    // caught below rather than quietly changing the character.
    const consumed = new Set();
    // Picks the creator's resolver could not offer. Only collected for a generating scenario, where
    // the answer came from what the *other* side was showing and a mismatch is therefore a finding
    // about the two pools rather than a stale hand-written table. See `creator.mjs#distribute`.
    const unofferable = scenario.generate ? [] : null;

    // An incremental scenario is snapshotted as it climbs, so a divergence can be attributed to the
    // level it first appears at rather than to "level 20". Each side records independently and the
    // two are lined up afterwards; there is no need to interleave the builds.
    const perLevel = scenario.incremental ? { native: new Map(), creator: new Map() } : null;
    const record = side => perLevel ? ((level, actor) => perLevel[side].set(level, snapshot(actor))) : undefined;

    native = await buildNative(
      { ...scenario, name: `${PREFIX}${scenario.name} [native]` },
      { book, consumed, onLevel: record("native") }
    );
    creator = await buildCreator(
      { ...scenario, name: `${PREFIX}${scenario.name} [creator]` },
      { book, diagnostics: report.diagnostics, consumed, unofferable, onLevel: record("creator") }
    );

    const originDocs = await Promise.all(["speciesUuid", "backgroundUuid", "classUuid"]
      .map(key => (scenario[key] ? fromUuid(scenario[key]) : null)));
    assertAnswersConsumed(scenario.answers ?? {}, consumed, advancementTypes(originDocs), report.diagnostics);
    assertBookComplete(book);
    report.decisions = book.entries.map(({ askedBy, ...rest }) => ({ ...rest, askedBy: [...askedBy] }));

    // `render` opens each sheet in turn, for problems that only exist once something prepares an
    // item for display — the actors are byte-identical and neither says a word until asked. The
    // creator's is rendered second so its output is the tail of the console.
    if ( render ) {
      for ( const actor of [native, creator] ) {
        await actor.sheet.render(true);
        await new Promise(resolve => setTimeout(resolve, 1500));
        await actor.sheet.close();
      }
    }

    const a = snapshot(native);
    const b = snapshot(creator);
    report.differences = [
      ...decisionDifferences(book),
      ...(unofferable ?? []).map(u => ({
        path: `decision.offered.${u.type}.${u.advId}`,
        native: `"${u.title}" offered ${u.picks.join(", ")}`,
        creator: `offers ${u.offers.slice(0, 8).join(", ")}`
          + `${u.offers.length > 8 ? ` … +${u.offers.length - 8} more` : ""}`
      })),
      ...diff(a.source, b.source, "source"),
      ...diff(a.derived, b.derived, "derived")
    ];
    report.ok = report.differences.length === 0;
    if ( perLevel ) report.levels = compareLevels(perLevel);
    report.summary = {
      native: { items: native.items.size, hp: native.system.attributes?.hp?.max },
      creator: { items: creator.items.size, hp: creator.system.attributes?.hp?.max }
    };
  } catch ( err ) {
    report.error = `${err.message}\n${err.stack ?? ""}`;
  } finally {
    if ( !keep ) {
      const ids = [native?.id, creator?.id].filter(Boolean);
      if ( ids.length ) await Actor.implementation.deleteDocuments(ids, { render: false }).catch(() => {});
    }
    report.ms = Math.round(performance.now() - started);
  }
  return report;
}

/**
 * Run the whole suite (or the subset named by `only`).
 * @param {object} [options]
 * @param {string[]} [options.only]   Scenario ids to run; omit for all.
 * @param {boolean} [options.keep]    Leave built actors in the world.
 */
export async function run({ only = null, keep = false } = {}) {
  await cleanup();
  // A scenario may pin itself to one world — the Ember hand-off ones resolve nothing without Ember.
  // Naming a scenario explicitly still runs it, so `--only ember-sorcerer` in the wrong world fails
  // loudly rather than silently doing nothing.
  const here = s => !s.world || (s.world === game.world.id);
  const scenarios = only?.length
    ? SCENARIOS.filter(s => only.includes(s.id))
    : SCENARIOS.filter(here);
  if ( !scenarios.length ) throw new Error(`no scenarios matched ${JSON.stringify(only)}`);
  const foreign = scenarios.filter(s => !here(s));
  if ( foreign.length ) {
    throw new Error(`${foreign.map(s => `"${s.id}"`).join(", ")} need world `
      + `"${foreign[0].world}" but this is "${game.world.id}"`);
  }

  const reports = [];
  for ( const scenario of scenarios ) reports.push(await runScenario(scenario, { keep }));
  return { reports, passed: reports.filter(r => r.ok).length, total: reports.length };
}

/** The scenario table, for listing from the command line. */
export function list() {
  return SCENARIOS.map(s => ({ id: s.id, name: s.name, world: s.world ?? "any" }));
}

/* -------------------------------------------- */
/*  The subclass sweep                           */
/* -------------------------------------------- */

/**
 * The sweep's scenarios, memoised for the session so `sweepList` and each `sweepOne` agree on what
 * the run consists of and on what each id means.
 */
let sweep = null;
async function getSweep(level, incremental = false, axis = "subclass") {
  if ( !sweep || (sweep.level !== level) || (sweep.incremental !== incremental) || (sweep.axis !== axis) ) {
    sweep = { level, incremental, axis, ...(await sweepScenarios({ level, incremental, axis })) };
  }
  return sweep;
}

/**
 * The sweep's plan: what it will run, and what it could not.
 * @param {object} [options]
 * @param {number} [options.level]
 * @param {boolean} [options.incremental]
 * @param {string} [options.axis]   Which axis to sweep: "subclass" (default) or "species".
 */
export async function sweepList({ level = 20, incremental = false, axis = "subclass" } = {}) {
  const { scenarios, skipped } = await getSweep(level, incremental, axis);
  return { level, incremental, axis, skipped, scenarios: scenarios.map(s => ({ id: s.id, name: s.name })) };
}

/**
 * Run **one** sweep scenario.
 *
 * Node drives the loop rather than the world, so each result crosses back as it is produced. A
 * ninety-scenario level-20 run is hours; a crash two hours in must not take the first two hours'
 * results with it, and `run.mjs --resume` must be able to pick up where it stopped.
 * @param {object} options
 * @param {string} options.id
 * @param {number} [options.level]
 * @param {boolean} [options.keep]
 */
export async function sweepOne({ id, level = 20, incremental = false, keep = false, render = false, axis = "subclass" }) {
  const { scenarios } = await getSweep(level, incremental, axis);
  const scenario = scenarios.find(s => s.id === id);
  if ( !scenario ) throw new Error(`unknown sweep scenario "${id}"`);
  await cleanup();
  return runScenario(scenario, { keep, render });
}

/* -------------------------------------------- */
/*  Sidekicks                                    */
/* -------------------------------------------- */

/**
 * Tasha's five sidekick classes must **not** be offered as player classes.
 *
 * They are the one part of `dnd-tashas-cauldron` the sweep deliberately cannot reach: a sidekick has
 * no subclasses, so a subclass-driven sweep has nothing to build, and there is nothing to build
 * anyway — the module's answer to a sidekick is to leave it out of the class grid entirely
 * (`source-index.mjs`'s `SIDEKICK_IDENTIFIERS`). So the whole test is a presence check on the index
 * the grid renders from, and it needs three parts to mean anything:
 *
 *  - the sidekicks are **installed**, or an empty class grid would pass;
 *  - none of them is offered;
 *  - the Artificer, which ships in the *same pack* and is a genuine player class, still is — the
 *    filter has to be exactly as wide as the five identifiers and no wider.
 *
 * This runs the real `SourceIndex.load()`, so it covers whichever route that takes in this world:
 * the dnd5e Compendium Browser's own fetch, or the direct pack scan it falls back to.
 * @returns {Promise<object>}
 */
export async function checkSidekicks() {
  const SIDEKICKS = ["expert", "warrior", "healer", "mage", "prodigy"];

  // What the world actually holds, read straight from the packs rather than through the index under
  // test — otherwise the filter would be marking its own homework.
  const installed = new Map();
  for ( const pack of game.packs.filter(p => p.documentName === "Item") ) {
    const index = await pack.getIndex({ fields: ["system.identifier"] });
    for ( const entry of index ) {
      if ( entry.type !== "class" ) continue;
      const id = entry.system?.identifier;
      if ( id && !installed.has(id) ) installed.set(id, { name: entry.name, uuid: entry.uuid });
    }
  }

  const index = new SourceIndex();
  await index.load();
  const offered = index.classes();
  const offeredIds = new Set(offered.map(c => c.identifier));

  const failures = [];
  const checks = [];

  for ( const id of SIDEKICKS ) {
    const inWorld = installed.get(id);
    const shown = offeredIds.has(id);
    checks.push({ identifier: id, installed: !!inWorld, offered: shown, name: inWorld?.name ?? null });
    if ( !inWorld ) failures.push(`sidekick "${id}" is not installed — this check proves nothing`);
    else if ( shown ) failures.push(`sidekick "${id}" (${inWorld.name}) is offered in the class grid`);
  }

  // The control: same pack, same publisher, genuinely playable.
  const artificer = offered.find(c => c.identifier === "artificer");
  checks.push({ identifier: "artificer", installed: installed.has("artificer"), offered: !!artificer,
    name: artificer?.name ?? null });
  if ( installed.has("artificer") && !artificer ) {
    failures.push(`"artificer" is installed but not offered — the sidekick filter is too wide`);
  }

  return {
    ok: !failures.length, failures, checks,
    classesOffered: offered.length,
    offered: offered.map(c => `${c.identifier} — ${c.name}`).sort()
  };
}

/* -------------------------------------------- */

/**
 * Isolate which `SourceIndex` warm call writes derived data back into a cached compendium
 * document's `_source` (see the `system.source.book` note in the README).
 *
 * Each call is tested against a *different* document in one page session, because the pollution is
 * sticky: once a document has been touched, a later call cannot be shown to be innocent. The
 * granted feature is checked too, since `advancementGroups` resolves the metadata of everything a
 * card grants and could pollute those rather than the card itself.
 */
export async function probeWarmCalls() {
  const { SourceIndex } = await import("/modules/sogrom-dnd5e-character-creator/scripts/data/source-index.mjs");
  const index = new SourceIndex();
  await index.load();

  const book = async uuid => (await fromUuid(uuid))?.toObject()?.system?.source?.book ?? null;
  const cases = [
    { call: "detail", uuid: "Compendium.dnd5e.classes24.Item.phbftrFighter000" },
    { call: "advancementGroups", uuid: "Compendium.dnd5e.classes24.Item.phbwzdWizard0000",
      granted: "Compendium.dnd5e.classes24.Item.phbwzdRitualAdep" },
    { call: "abilityScoreIncrease", uuid: "Compendium.dnd5e.origins24.Item.phbbgSage0000000" }
  ];

  const out = [];
  for ( const { call, uuid, granted } of cases ) {
    const before = await book(uuid);
    const grantedBefore = granted ? await book(granted) : null;
    await index[call](uuid, await fromUuid(uuid));
    const after = await book(uuid);
    const grantedAfter = granted ? await book(granted) : null;
    out.push({
      call, uuid, before, after, changed: before !== after,
      ...(granted ? { granted, grantedBefore, grantedAfter, grantedChanged: grantedBefore !== grantedAfter } : {})
    });
  }

  // All three on one untouched document, in the order `warmAll` uses them — in case the write
  // needs the memoised results of an earlier call.
  const combo = "Compendium.dnd5e.origins24.Item.phbspHuman000000";
  const comboBefore = await book(combo);
  const comboDoc = await fromUuid(combo);
  await index.detail(combo, comboDoc);
  await index.advancementGroups(combo, comboDoc);
  await index.abilityScoreIncrease(combo, comboDoc);
  out.push({ call: "all three, one doc", uuid: combo, before: comboBefore,
    after: await book(combo), changed: comboBefore !== await book(combo) });

  // The real thing, checked against a granted feature that nothing above has touched — the item
  // the original symptom was reported on.
  const target = "Compendium.dnd5e.classes24.Item.phbftrSecondWind";
  const warmBefore = await book(target);
  await index.warmAll();
  const warmAfter = await book(target);
  out.push({ call: "warmAll()", uuid: target, before: warmBefore, after: warmAfter,
    changed: warmBefore !== warmAfter });

  return out;
}

/**
 * Build a scenario both ways and return one item's raw source from each, side by side.
 *
 * `run` reports *normalised* differences, which is right for spotting them but useless for
 * chasing one down: the interesting question is usually "what does each side actually store for
 * this item, before any normalisation". This answers exactly that.
 * @param {string} scenarioId
 * @param {string} itemName     Case-insensitive substring of the item's name.
 */
export async function compareItem({ scenarioId, itemName, level = 20, incremental = false }) {
  // Sweep ids resolve too (`sweep:artificer/battle-smith`), because a sweep finding is exactly when
  // you want this: the report shows the normalised path, and the question is always what each side
  // actually stored underneath it. `incremental` has to be honoured for the same reason — a finding
  // that only exists in that mode cannot be explained by a build that does not reproduce it.
  const scenario = SCENARIOS.find(s => s.id === scenarioId)
    ?? (await getSweep(level, incremental)).scenarios.find(s => s.id === scenarioId);
  if ( !scenario ) throw new Error(`unknown scenario "${scenarioId}"`);
  await cleanup();

  // *Every* match, not the first: a duplicated item is exactly the kind of thing this is pointed at,
  // and returning one copy of two would hide the finding it was opened to explain.
  const pick = actor => actor.items
    .filter(i => i.name.toLowerCase().includes(itemName.toLowerCase()))
    .map(i => i.toObject());

  let native = null;
  let creator = null;
  try {
    const book = new AnswerBook({ overrides: scenario.answers ?? {}, generate: !!scenario.generate, asiFeats: !!scenario.asiFeats });
    // The same tolerance `runScenario` grants a generating scenario. Without it the resolver's first
    // pass — which legitimately offers a narrower pool than the settled one — throws, and this tool
    // cannot be pointed at the sweep findings it exists to explain.
    const unofferable = scenario.generate ? [] : null;
    native = await buildNative({ ...scenario, name: `${PREFIX}${scenario.name} [native]` }, { book });
    creator = await buildCreator(
      { ...scenario, name: `${PREFIX}${scenario.name} [creator]` }, { book, unofferable }
    );
    return { scenario: scenarioId, item: itemName, native: pick(native), creator: pick(creator) };
  } finally {
    const ids = [native?.id, creator?.id].filter(Boolean);
    if ( ids.length ) await Actor.implementation.deleteDocuments(ids, { render: false }).catch(() => {});
  }
}

/**
 * Build **only** the native reference and return every copy of one item, per level.
 *
 * The clean-room half of {@link compareItem}. Several findings come down to timing around writes the
 * system makes from un-awaited hooks — a Cast activity's cached spell being the current one — and the
 * question that decides whose they are is whether dnd5e still does it with this module absent. Run
 * this against the `playwright-clean` world, where it is not enabled, and nothing of ours is in the
 * room to perturb the answer.
 *
 * Reports at every level rather than only the last, because the interesting moment is the transition:
 * an item held at one level and gone at the next.
 * @param {object} options
 * @param {string} options.scenarioId
 * @param {string} options.itemName
 * @param {number} [options.level]
 * @param {boolean} [options.incremental]
 * @param {boolean} [options.render]   Open the finished character's sheet before tearing it down.
 *   The harness otherwise never renders anything — it builds with `render: false` and only reads
 *   data — so a problem that only surfaces when something *prepares an item for display* leaves no
 *   trace at all. A consumption target that cannot resolve is exactly that shape: the actor's stored
 *   data is identical either way, and the complaint only arrives when the sheet asks for it.
 */
export async function probeNative({
  scenarioId, itemName, level = 20, incremental = true, render = false
}) {
  const scenario = SCENARIOS.find(s => s.id === scenarioId)
    ?? (await getSweep(level, incremental)).scenarios.find(s => s.id === scenarioId);
  if ( !scenario ) throw new Error(`unknown scenario "${scenarioId}"`);
  await cleanup();

  const wanted = itemName.toLowerCase();
  const byLevel = [];
  let actor = null;
  try {
    const book = new AnswerBook({ overrides: scenario.answers ?? {}, generate: !!scenario.generate, asiFeats: !!scenario.asiFeats });
    actor = await buildNative({ ...scenario, name: `${PREFIX}${scenario.name} [native]` }, {
      book,
      onLevel: (lvl, a) => {
        const copies = a.items.filter(i => i.name.toLowerCase().includes(wanted)).map(i => ({
          prepared: i.system?.prepared ?? null,
          cachedFor: i.flags?.dnd5e?.cachedFor ?? null,
          advancementOrigin: i.flags?.dnd5e?.advancementOrigin ?? null
        }));
        byLevel.push({ level: lvl, count: copies.length, copies });
      }
    });
    if ( render && actor ) {
      await actor.sheet.render(true);
      await new Promise(resolve => setTimeout(resolve, 1500));
      await actor.sheet.close();
    }
    return { scenario: scenarioId, item: itemName, world: game.world.id, incremental, rendered: render, byLevel };
  } finally {
    if ( actor?.id ) await Actor.implementation.deleteDocuments([actor.id], { render: false }).catch(() => {});
  }
}

/**
 * Probe where a derived field first appears in an item's data, for chasing prepared values that
 * end up persisted as source. Reports the same two fields (`system.source.book`, the enchantment
 * `riders` flag) at each hop a build takes them through:
 *
 *   `_source`            what the pack actually stores
 *   `toObject()`         what the creator stages an origin item from
 *   `createItemData()`   what an ItemGrant advancement grants a feature from
 *   clone round-trip     what survives `clone.updateSource(...)` → `clone.toObject()`
 *
 * The first hop where the value turns up is the one that introduced it.
 * @param {string} uuid
 */
export async function probeSource(arg) {
  const uuid = (typeof arg === "string") ? arg : arg.uuid;
  const warm = (typeof arg === "object") && arg.warm;

  const read = data => ({
    book: data?.system?.source?.book ?? null,
    riders: data?.flags?.dnd5e?.riders ?? null
  });

  // Optionally run the creator's own index warm first. It resolves every origin document and the
  // metadata of everything they grant, which is the most likely way a *prepared* value could end
  // up in the cached compendium document that later builds stage from — and it would explain why
  // the difference comes and goes with run order.
  let beforeWarm = null;
  if ( warm ) {
    beforeWarm = read((await fromUuid(uuid))?.toObject());
    const { SourceIndex } = await import("/modules/sogrom-dnd5e-character-creator/scripts/data/source-index.mjs");
    const index = new SourceIndex();
    await index.load();
    await index.warmAll();
  }

  const doc = await fromUuid(uuid);
  if ( !doc ) throw new Error(`not found: ${uuid}`);

  const out = {
    uuid,
    name: doc.name,
    ...(warm ? { toObjectBeforeWarm: beforeWarm } : {}),
    prepared: { book: doc.system?.source?.book ?? null, riders: doc.flags?.dnd5e?.riders ?? null },
    _source: read(doc._source),
    toObject: read(doc.toObject()),
    fromCompendium: read(game.items.fromCompendium(doc))
  };

  // What the advancement machinery itself produces for a granted item.
  const actor = await Actor.implementation.create(
    { name: "[e2e] probe", type: "character" }, { render: false }
  );
  try {
    const clone = actor.clone({}, { keepId: true });
    clone.updateSource({ items: [doc.toObject()] });
    const roundTripped = clone.toObject().items?.[0];
    out.cloneRoundTrip = read(roundTripped);

    // …and what actually persists once the document is written to an actor, which is where a
    // schema default or a migration would quietly drop a field that source really did carry.
    const [created] = await actor.createEmbeddedDocuments("Item", [doc.toObject()], { render: false });
    out.afterCreate = read(created.toObject());
  } finally {
    await actor.delete();
  }
  return out;
}

/**
 * Find items by name across every active pack — the general companion to
 * {@link describeAdvancements}, for when you know what a scenario should pick but not its uuid.
 * @param {string} query   Case-insensitive name substring, optionally prefixed `type:` to filter
 *                         (e.g. `"feat:Actor"`).
 */
export async function findItems(query) {
  const terms = String(query).split(",").map(q => {
    const [maybeType, ...rest] = q.trim().split(":");
    return {
      type: rest.length ? maybeType : null,
      name: (rest.length ? rest.join(":") : maybeType).toLowerCase()
    };
  });

  const out = [];
  for ( const pack of game.packs.filter(p => p.documentName === "Item") ) {
    for ( const entry of await pack.getIndex() ) {
      const hit = terms.some(t => (!t.type || (entry.type === t.type))
        && entry.name.toLowerCase().includes(t.name));
      if ( hit ) out.push({ name: entry.name, type: entry.type, uuid: entry.uuid });
    }
  }
  return out.sort((a, b) => a.uuid.localeCompare(b.uuid));
}

/**
 * Every subclass available for a class identifier, across all active packs — the companion to
 * {@link describeAdvancements} for writing a level-3 scenario, where the answer to the Subclass
 * advancement is a subclass uuid that has to come from somewhere.
 * @param {string} identifier   A class identifier, e.g. "wizard".
 */
export async function listSubclasses(identifier) {
  const out = [];
  for ( const pack of game.packs.filter(p => p.documentName === "Item") ) {
    const index = await pack.getIndex({ fields: ["system.classIdentifier"] });
    for ( const entry of index ) {
      if ( (entry.type !== "subclass") || (entry.system?.classIdentifier !== identifier) ) continue;
      out.push({ name: entry.name, uuid: entry.uuid, pack: pack.collection });
    }
  }
  return out.sort((a, b) => a.uuid.localeCompare(b.uuid));
}

/**
 * Dump an item's advancements — id, type, title, and what each one offers — which is how the
 * answer tables in `scenarios.mjs` are written and kept current when content updates reshape an
 * advancement. Exposed because guessing these ids from the pack YAML is error-prone.
 * @param {string} uuid   A class/species/background/feat compendium uuid.
 */
export async function describeAdvancements(uuid) {
  const doc = await fromUuid(uuid);
  if ( !doc ) throw new Error(`not found: ${uuid}`);

  const out = [];
  for ( const adv of Object.values(doc.advancement?.byId ?? {}) ) {
    const cfg = adv.configuration ?? {};
    const entry = { id: adv.id, type: adv.type, title: adv.title, level: adv.level ?? 0 };

    if ( adv.type === "Trait" ) {
      // The mode matters when writing an answer: an "expertise" Trait only offers skills the
      // build is already proficient in, so a valid-looking key can still be unofferable.
      entry.mode = cfg.mode;
      entry.grants = [...(cfg.grants ?? [])];
      entry.choices = (cfg.choices ?? []).map(c => ({ count: c.count, pool: [...(c.pool ?? [])] }));
    } else if ( adv.type === "ItemChoice" ) {
      entry.counts = cfg.choices;
      entry.pool = [...(cfg.pool ?? [])].map(p => p.uuid ?? p);
      entry.restriction = cfg.restriction;
    } else if ( adv.type === "ItemGrant" ) {
      entry.items = [...(cfg.items ?? [])].map(i => i.uuid ?? i);
      entry.spellAbility = [...(cfg.spell?.ability ?? [])];
    } else if ( adv.type === "Size" ) {
      entry.sizes = [...(cfg.sizes ?? [])];
    } else if ( adv.type === "AbilityScoreImprovement" ) {
      entry.points = cfg.points;
      entry.cap = cfg.cap;
      entry.fixed = cfg.fixed;
      entry.locked = [...(cfg.locked ?? [])];
    }
    out.push(entry);
  }
  return { uuid, name: doc.name, type: doc.type, advancements: out };
}
