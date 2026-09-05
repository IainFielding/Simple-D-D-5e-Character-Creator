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
const { checkHooks } = await import(`./hooks.mjs${BUST}`);
const deleteErrors = await import(`./delete-errors.mjs${BUST}`);

// The module under test, imported *without* a buster — the same instance the world already loaded.
const { SourceIndex } = await import("/modules/sogrom-dnd5e-character-creator/scripts/data/source-index.mjs");
const { SpellSource } = await import("/modules/sogrom-dnd5e-character-creator/scripts/data/spell-source.mjs");

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

/**
 * Assert the public hook and API surface against the real wizards — see `in-world/hooks.mjs`.
 * Re-exported here so the Node runner reaches it the same way it reaches every other command.
 */
export { checkHooks };

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
    // Every level boundary is marked whether or not snapshots are being kept: the delete errors
    // collected below are bucketed on these marks, and they are worth attributing in either mode.
    const record = side => (level, actor) => {
      deleteErrors.mark(side, level);
      if ( perLevel ) perLevel[side].set(level, snapshot(actor));
    };

    deleteErrors.install();
    deleteErrors.begin();

    deleteErrors.mark("native", 0);
    native = await buildNative(
      { ...scenario, name: `${PREFIX}${scenario.name} [native]` },
      { book, consumed, onLevel: record("native") }
    );
    // Let the native build's trailing rejections land before the boundary moves: `#complete` keeps
    // writing after its manager has closed, and anything arriving after this mark would otherwise be
    // charged to the creator's level 1.
    await new Promise(resolve => setTimeout(resolve, 400));
    deleteErrors.mark("creator", 0);
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
    // Collected before the teardown deletes: a rejection raised by the last level can still be in
    // flight, and deleting the actors would add deletions of its own to the same listener.
    await new Promise(resolve => setTimeout(resolve, 250));
    report.deleteErrors = deleteErrors.collect();

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
/*  Granted always-prepared spells               */
/* -------------------------------------------- */

/**
 * A feature-granted always-prepared spell must not also exist as a second, separately-chosen copy.
 *
 * **Why this is an assertion and not a comparison.** Everything else here diffs two builds, and this
 * cannot: dnd5e has eight advancement types and none of them is class-spell selection, so there is
 * no native behaviour to compare against — the creator invents that step. Teaching `native.mjs` to
 * "pick class spells" would mean the harness writing its own reference and then checking we match
 * it, which tests the expectation rather than the system. The bug is a property of *one* character
 * anyway, so that is what gets checked.
 *
 * **The bug.** A class or subclass `ItemGrant` declaring `configuration.spell.prepared = 2` hands
 * out an always-prepared spell — Divine Smite at Paladin 2, a Life Domain's domain spells. Many are
 * also on the class's own list, so the player could pick the same spell again and end up with two
 * Items. Only the plain copy counts toward `preparation.value` (`SpellData#countsPrepared` requires
 * `prepared === 1`), so the duplicate permanently consumed a prepared slot for a spell the character
 * already always has, and being a plain copy it burned a real spell slot when clicked.
 *
 * **The refusal matters more than the merges.** A missed merge is a duplicate the player can delete;
 * a wrong merge silently destroys an entitlement. Magic Initiate grants a spell *and* a Cleric may
 * prepare the same spell normally — two different things the character can do — so the last case
 * asserts those stay separate. It is the assertion most likely to catch a later "simplify the merge".
 *
 * Cases are content-driven: the overlapping spell is discovered by walking the class and subclass
 * documents for always-prepared grants and intersecting with the class's own spell list, rather than
 * being written down. A hard-coded uuid goes stale the moment a module updates, and a case that can
 * no longer find an overlap reports that rather than passing on an empty test.
 * @returns {Promise<object>}
 */
export async function checkGrantedSpells() {
  const failures = [];
  const cases = [];

  for ( const spec of GRANTED_SPELL_CASES ) {
    let report;
    try {
      report = await runGrantedSpellCase(spec);
    } catch ( err ) {
      report = { id: spec.id, label: spec.label, ok: false, error: err.message };
    }
    cases.push(report);
    for ( const f of report.failures ?? [] ) failures.push(`${spec.id}: ${f}`);
    if ( report.error ) failures.push(`${spec.id}: ${report.error}`);
  }

  return { ok: !failures.length, failures, cases };
}

/**
 * The builds this check runs. Each names a class by identifier rather than uuid, with the packs it
 * may come from in preference order — the 2014 Cleric specifically, because a 2014 class chooses its
 * subclass at level 1 and so brings its domain spells into *creation*, which is the path where the
 * duplicate was first seen.
 */
const GRANTED_SPELL_CASES = [
  {
    id: "paladin-2",
    label: "Paladin 2 — Divine Smite granted always-prepared",
    classIdentifier: "paladin",
    packs: ["dnd-players-handbook.classes", "dnd5e.classes24"],
    level: 2
  },
  {
    // 2024 rather than 2014 deliberately. The 2014 Life Domain grants *features* and leaves its
    // `spell.preparation` empty, so it has no always-prepared spell grant to duplicate — the 2024
    // one declares `preparation: always`, which migrates to `prepared: 2` on the live model. This is
    // also the more valuable shape: the spell is picked at creation and granted three levels later,
    // which is the one case prevention cannot reach and only reconciliation fixes.
    id: "cleric-life-3",
    label: "Cleric of Life 3 — a spell picked at 1 that the subclass later grants always-prepared",
    classIdentifier: "cleric",
    packs: ["dnd-players-handbook.classes", "dnd5e.classes24"],
    subclassIdentifier: "life",
    level: 3
  },
  {
    id: "magic-initiate-overlap",
    label: "Wizard 1 — a Magic Initiate spell also picked as a class spell stays separate",
    classIdentifier: "wizard",
    packs: ["dnd5e.classes24", "dnd-players-handbook.classes"],
    level: 1,
    // Sage grants Magic Initiate; both sides pick the same spell deliberately.
    backgroundUuid: "Compendium.dnd5e.origins24.Item.phbbgSage0000000",
    featOverlap: {
      featUuid: "Compendium.dnd5e.feats24.Item.phbftMagicInitia",
      spellUuid: "Compendium.dnd5e.spells24.Item.phbsplMagicMissi"
    },
    expectSeparate: true
  }
];

/** Build one case and assert the invariants on the finished actor. */
async function runGrantedSpellCase(spec) {
  const classDoc = await resolveByIdentifier("class", spec.classIdentifier, spec.packs);
  if ( !classDoc ) throw new Error(`no "${spec.classIdentifier}" class in ${spec.packs.join(", ")}`);

  const scenario = {
    name: `${PREFIX}granted-spells ${spec.id}`,
    classUuid: classDoc.uuid,
    speciesUuid: "Compendium.dnd5e.origins24.Item.phbspHuman000000",
    backgroundUuid: spec.backgroundUuid ?? "Compendium.dnd5e.origins24.Item.phbbgSage0000000",
    abilities: { str: 15, dex: 13, con: 14, int: 12, wis: 15, cha: 15 },
    targetLevel: spec.level > 1 ? spec.level : undefined,
    generate: true,
    answers: {}
  };

  // Which spell to pick twice. For the feat case it is stated (the whole point is the collision);
  // otherwise it is discovered from the content.
  let overlap = spec.featOverlap?.spellUuid ?? null;
  let subclassDoc = null;

  if ( spec.subclassIdentifier ) {
    subclassDoc = await resolveByIdentifier("subclass", spec.subclassIdentifier, null,
      d => d.system?.classIdentifier === spec.classIdentifier);
    if ( !subclassDoc ) throw new Error(`no "${spec.subclassIdentifier}" subclass for ${spec.classIdentifier}`);
    const advId = Object.values(classDoc.advancement?.byId ?? {}).find(a => a.type === "Subclass")?.id;
    if ( !advId ) throw new Error(`"${classDoc.name}" has no Subclass advancement`);
    scenario.answers[advId] = subclassDoc.uuid;
  }

  if ( spec.featOverlap ) {
    scenario.featSpells = { [spec.featOverlap.featUuid]: { spells: [overlap], cantrips: [] } };
  } else {
    const found = await findAlwaysPreparedOverlap(classDoc, subclassDoc, spec.level);
    overlap = found.uuid;
    if ( !overlap ) {
      // Not a pass: the precondition this case exists to exercise is absent from the world. Say
      // which half is missing — "no grants" and "grants nothing the class also offers" are different
      // problems, and one of them means the case is pointed at the wrong content.
      throw new Error("no always-prepared grant overlaps this class's own spell list "
        + `(${classDoc.name}${subclassDoc ? ` / ${subclassDoc.name}` : ""}: `
        + `${found.granted.length} always-prepared spell grant(s) at level <= ${spec.level}, `
        + `class list offered ${found.offered} spell(s)) — the case proves nothing against this content`);
    }
  }

  scenario.spells = { level1: [overlap] };
  const overlapDoc = await fromUuid(overlap);
  if ( !overlapDoc ) throw new Error(`the spell under test could not be resolved: ${overlap}`);

  const book = new AnswerBook({ overrides: scenario.answers, generate: true });
  // The same tolerance `runScenario` grants a generating scenario: the resolver's first pass
  // legitimately offers a narrower pool than the settled one, and without somewhere to put those the
  // build throws on a pick that is perfectly valid by the time it matters.
  const actor = await buildCreator(scenario, { book, unofferable: [] });
  try {
    return assertGrantedSpells(actor, { spec, overlap, overlapName: overlapDoc.name });
  } finally {
    await actor.delete().catch(() => {});
  }
}

/**
 * The invariants. Read off the finished actor, so they hold whatever route produced it.
 * @param {Actor5e} actor
 */
function assertGrantedSpells(actor, { spec, overlap, overlapName }) {
  const failures = [];
  const spells = actor.items.filter(i => i.type === "spell");
  // Counted by **name**, deliberately. Identity by compendium source cannot see a cross-package
  // merge — the surviving Bless is the pack the *grant* named, not the one the player picked — and
  // identity by identifier would be asking the module to mark its own homework, since a broken
  // `spellKey` is precisely one of the things this is here to catch. A character holding two spells
  // of the same name is wrong whatever the module thinks, which is what makes it a usable oracle.
  const copies = spells.filter(i => i.name === overlapName);

  if ( spec.expectSeparate ) {
    // A feat's spell and a class's are different entitlements — the character can do both, and
    // collapsing them takes one away.
    if ( copies.length !== 2 ) {
      failures.push(`"${overlapName}" should remain 2 separate items (feat + class), found ${copies.length}`);
    }
  } else {
    if ( copies.length !== 1 ) {
      failures.push(`"${overlapName}" appears ${copies.length} time(s); a granted spell also chosen `
        + `must collapse to exactly 1`);
    }
    const survivor = copies[0];
    if ( survivor && Number(survivor.system?.prepared ?? 0) !== 2 ) {
      failures.push(`"${overlapName}" survived with prepared=${survivor.system?.prepared} — `
        + `the granted copy (always prepared) should be the one kept`);
    }
  }

  // No spell may appear twice at all — the duplicate's signature, checked across the whole character
  // rather than only the spell under test, so a build that collapses the tested pair while leaving
  // another still fails.
  const byName = new Map();
  for ( const spell of spells ) byName.set(spell.name, (byName.get(spell.name) ?? 0) + 1);
  for ( const [name, count] of byName ) {
    if ( count < 2 ) continue;
    if ( spec.expectSeparate && (name === overlapName) ) continue;   // the deliberate pair
    failures.push(`${count} copies of "${name}" on one character`);
  }

  // `preparation.value` counts only `prepared === 1`. A duplicate inflates it, which is how the bug
  // stole a prepared slot; assert the system's own count matches what is actually on the sheet.
  const casting = actor.items.find(i => (i.type === "class") && i.system?.spellcasting?.preparation);
  const prepared = spells.filter(i => Number(i.system?.prepared ?? 0) === 1
    && Number(i.system?.level ?? 0) > 0).length;
  const reported = casting?.system?.spellcasting?.preparation?.value ?? null;
  if ( (reported !== null) && (reported !== prepared) ) {
    failures.push(`preparation.value is ${reported} but ${prepared} leveled spell(s) are prepared`);
  }

  return {
    id: spec.id, label: spec.label, ok: !failures.length, failures,
    overlap: `${overlapName} (${overlap})`,
    copies: copies.length,
    prepared, reportedPrepared: reported,
    spells: spells.map(i => `${i.name} prepared=${i.system?.prepared} source=${i.system?.sourceItem ?? "-"}`).sort()
  };
}

/** The first item of a type whose identifier matches, honouring a pack preference order. */
async function resolveByIdentifier(type, identifier, packs = null, extra = null) {
  const search = packs
    ? packs.map(c => game.packs.get(c)).filter(Boolean)
    : game.packs.filter(p => p.documentName === "Item");
  for ( const pack of search ) {
    const index = await pack.getIndex({ fields: ["system.identifier", "system.classIdentifier"] });
    for ( const entry of index ) {
      if ( (entry.type !== type) || (entry.system?.identifier !== identifier) ) continue;
      const doc = await fromUuid(entry.uuid);
      if ( doc && (!extra || extra(doc)) ) return doc;
    }
  }
  return null;
}

/**
 * A spell that is both granted always-prepared at or below `level` and offered by the class's own
 * spell list — the precondition the whole bug depends on.
 *
 * Discovered rather than written down: an advancement id and a spell uuid both belong to the content
 * version that shipped them, and this way the case keeps working when a book updates and covers
 * content it has never seen.
 * @returns {Promise<{uuid: string|null, granted: string[], offered: number}>}
 */
async function findAlwaysPreparedOverlap(classDoc, subclassDoc, level) {
  const granted = [];
  for ( const doc of [classDoc, subclassDoc].filter(Boolean) ) {
    for ( const adv of Object.values(doc.advancement?.byId ?? {}) ) {
      if ( adv.type !== "ItemGrant" ) continue;
      if ( Number(adv.level ?? 0) > level ) continue;
      if ( Number(adv.configuration?.spell?.prepared ?? 0) !== 2 ) continue;
      for ( const ref of Array.from(adv.configuration?.items ?? []) ) {
        const uuid = typeof ref === "string" ? ref : ref?.uuid;
        const item = uuid ? await fromUuid(uuid).catch(() => null) : null;
        if ( item?.type === "spell" ) granted.push(uuid);
      }
    }
  }
  if ( !granted.length ) return { uuid: null, granted, offered: 0 };

  // Intersect with what the class itself offers, so the pick is one a player could really have made.
  //
  // By **identifier**, not uuid, and that distinction is the whole reason this case was worth
  // building. A world with the Player's Handbook module holds two copies of every spell: the grant
  // names `dnd5e.spells24`'s Cure Wounds while the class list offers the module's, so a uuid
  // intersection finds nothing even though the spell is plainly the same. That is exactly the
  // mismatch the module's own identity test had, and matching the other way here would have hidden it.
  //
  // The *pool's* uuid is returned rather than the grant's, because that is the copy a player picks —
  // which makes this case a cross-package duplicate, the shape that actually occurs.
  const spells = new SpellSource();
  const pool = await spells.forClassAtLevel(classDoc.uuid, 1, "class", { doc: classDoc })
    .catch(() => null);
  const rows = Object.values(pool?.byLevel ?? {}).flat();

  const grantedIdentifiers = new Set();
  for ( const uuid of granted ) {
    const doc = await fromUuid(uuid).catch(() => null);
    const identifier = doc?.system?.identifier;
    if ( identifier ) grantedIdentifiers.add(identifier);
  }
  const match = rows.find(row => grantedIdentifiers.has(row.identifier));
  return { uuid: match?.uuid ?? null, granted, offered: rows.length };
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
/**
 * What `foundry.applications.instances` actually holds, and which of those `hooks.mjs`'s `closeAll`
 * would try to close.
 *
 * `closeAll` awaits `close({force: true})` on every registered ApplicationV2. That was written when
 * the registry held module windows; if Foundry v14 also registers the core UI singletons — sidebar,
 * chat, hotbar, scene navigation — then `closeAll` is closing the interface out from under itself,
 * and one of those closes not resolving is enough to hang the whole hooks suite with no server
 * traffic, which is the symptom. Reports the registry rather than assuming either way.
 */
/**
 * Which half of `SourceIndex.#resolveDetail` writes the derived book back into a cached document.
 *
 * `--probe-warm` narrows the writer to `detail()`, which does exactly two things to the document it
 * is handed: enriches its description with `relativeTo: doc`, and reads `system.source.value`. Those
 * need different fixes — an enrich that mutates is Foundry's, a read that mutates is dnd5e's
 * `SourceField` back-filling a placeholder on access — so they are run against separate untouched
 * documents here. The clone case tests the fix the README proposes.
 */
/**
 * Which *stage* of the real creator path pollutes, rather than which call does in isolation.
 *
 * `--probe-detail` proves `enrichHTML(relativeTo: cachedDoc)` can write the derived book, and the
 * clone stops it. But the base suite still reports the rows after that fix, and the polluted items
 * include granted features that `detail()` never touches — so isolation testing has found *a*
 * writer, not the one that matters. This walks the real sequence and reads the same three documents
 * after each stage: whichever stage flips them is the one to fix.
 */
/**
 * Where the `source.book` a built character stores actually comes from.
 *
 * `--probe-pollution` shows the compendium documents are *clean* by the time a build starts —
 * `warmAll`'s document load replaces the entries `SourceIndex.load()` polluted — yet the creator's
 * items still store "SRD 5.2" while native's store "". So the value is not being read from the
 * documents at build time. This reports, for the same scenario built both ways: the documents'
 * books at each stage, and every stored `_source.system.source.book` on each finished actor. If the
 * documents are clean and the creator's items are not, the creator is copying from something cached
 * while the documents *were* polluted, and the cache is the thing to fix.
 */
/**
 * What `native.mjs`'s `fillReplacementGrant` actually sees for the 2014 Ranger.
 *
 * It is reached (`probe-replacement` shows `dispatchesToDefault: true`, `hasReplacements: true`) and
 * computes the right `wanted`, yet native ends the build with none of the base features. That leaves
 * the DOM: either the flow renders no controls this selector matches, or it renders controls whose
 * `value`/`name` does not normalise to a uuid in `wanted`. Builds natively to `level` with the
 * recorder armed and returns one record per replacement flow driven.
 * @param {object} [options]
 * @param {string} [options.scenarioId]  Defaults to the 2014 Ranger sweep scenario.
 * @param {number} [options.level]
 */
export async function probeReplacementFlow({ scenarioId = "sweep:ranger/hunter", level = 3 } = {}) {
  const scenario = SCENARIOS.find(s => s.id === scenarioId)
    ?? (await getSweep(level, true)).scenarios.find(s => s.id === scenarioId);
  if ( !scenario ) throw new Error(`unknown scenario "${scenarioId}"`);
  await cleanup();

  globalThis.__replacementDiag = [];
  try {
    const book = new AnswerBook({ overrides: scenario.answers ?? {}, generate: !!scenario.generate });
    const actor = await buildNative({ ...scenario, name: `${PREFIX}replprobe [native]`, level }, { book });
    const granted = actor.items.map(i => i.name).sort();
    return { scenario: scenarioId, level, flows: globalThis.__replacementDiag, grantedItems: granted };
  } finally {
    delete globalThis.__replacementDiag;
    await cleanup();
  }
}

/**
 * Who writes `system.source.book` into a cached compendium document's `_source`, with a stack.
 *
 * Three rounds of narrowing by elimination each found *a* writer and none of them the one that
 * matters, so this stops inferring and traps the write itself: the target documents'
 * `_source.system.source.book` is replaced with an accessor that records a stack trace on every
 * write, and then the creator builds. Whatever appears in those traces is the call site, with no
 * reasoning in between.
 */
/**
 * Run the creator's full warm-up on its own, and time each phase.
 *
 * `--hooks` is the only suite that reaches `warmSources`, and it is the only suite that crashes the
 * renderer. Everything else — the sweep, the base suite, every probe — drives `LevelUpDriver`
 * directly and never pays for it. That makes `warmSources` the prime suspect, but it is also exactly
 * what a real player's creator does on open, so if it is pathological on 6.0.0 that matters well
 * beyond the harness. Isolated here so the answer is not entangled with the hooks suite's own work.
 */
/**
 * The smallest reproduction of the `source.book` write, in the shape a bug report can paste.
 *
 * Deliberately uses nothing from this module: one `fromUuid` read, one `CompendiumBrowser.fetch`,
 * one more read. If the second read differs from the first, dnd5e has written a derived value into
 * a cached document's `_source`.
 */
export async function probeMinimalBookRepro() {
  const uuid = "Compendium.dnd5e.classes24.Item.phbftrFighter000";
  const read = async () => (await fromUuid(uuid))?.toObject()?.system?.source?.book ?? null;

  const before = await read();
  await dnd5e.applications.CompendiumBrowser.fetch(Item, {
    types: new Set(["class"]),
    indexFields: new Set(["system.source"])
  });
  const after = await read();
  return { uuid, before, after, changed: before !== after };
}

export async function probeWarm() {
  const t0 = performance.now();
  const marks = [];
  const mark = label => marks.push({ label, ms: Math.round(performance.now() - t0),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null });

  mark("start");
  const { warmSources, invalidateSources } = await import(
    "/modules/sogrom-dnd5e-character-creator/scripts/data/source-cache.mjs");
  mark("imported source-cache");
  try {
    invalidateSources?.();
    mark("invalidated");
  } catch { /* not exported on this build */ }

  await warmSources();
  mark("warmSources resolved");

  return { totalMs: Math.round(performance.now() - t0), marks };
}

export async function probeBookWriter() {
  const targets = {
    Fighter: "Compendium.dnd5e.classes24.Item.phbftrFighter000",
    SecondWind: "Compendium.dnd5e.classes24.Item.phbftrSecondWind",
    Resourceful: "Compendium.dnd5e.origins24.Item.phbsptResourcefu"
  };
  const writes = [];
  const armed = [];

  for ( const [label, uuid] of Object.entries(targets) ) {
    const doc = await fromUuid(uuid);
    const src = doc?._source?.system?.source;
    if ( !src ) { writes.push({ label, error: "no _source.system.source" }); continue; }
    let held = src.book;
    try {
      Object.defineProperty(src, "book", {
        configurable: true, enumerable: true,
        get: () => held,
        set(v) {
          if ( v !== held ) {
            writes.push({ label, from: held, to: v, stack: (new Error().stack ?? "").split("\n").slice(1, 9).join("\n") });
          }
          held = v;
        }
      });
      armed.push(label);
    } catch ( err ) {
      writes.push({ label, error: `could not arm: ${err.message}` });
    }
  }

  const scenario = SCENARIOS.find(s => s.id === "human-fighter-sage");
  await cleanup();
  try {
    const book = new AnswerBook({ overrides: scenario.answers ?? {} });
    await buildCreator({ ...scenario, name: `${PREFIX}bookwriter [creator]` }, { book, unofferable: [] });
  } finally {
    await cleanup();
  }
  return { armed, writeCount: writes.length, writes: writes.slice(0, 12) };
}

export async function probeBuildBooks() {
  const targets = {
    Human: "Compendium.dnd5e.origins24.Item.phbspHuman000000",
    Fighter: "Compendium.dnd5e.classes24.Item.phbftrFighter000",
    SecondWind: "Compendium.dnd5e.classes24.Item.phbftrSecondWind"
  };
  const read = async () => {
    const out = {};
    for ( const [k, uuid] of Object.entries(targets) ) {
      out[k] = (await fromUuid(uuid))?.toObject()?.system?.source?.book ?? null;
    }
    return out;
  };
  const books = actor => actor.items
    .map(i => ({ name: i.name, book: i._source?.system?.source?.book ?? null }))
    .filter(i => i.book);

  const scenario = SCENARIOS.find(s => s.id === "human-fighter-sage");
  if ( !scenario ) throw new Error("human-fighter-sage scenario missing");
  await cleanup();

  const stages = [{ step: "before any build", docs: await read() }];
  try {
    const nBook = new AnswerBook({ overrides: scenario.answers ?? {} });
    const native = await buildNative({ ...scenario, name: `${PREFIX}bookprobe [native]` }, { book: nBook });
    stages.push({ step: "after native build", docs: await read(), itemsWithBook: books(native) });

    const cBook = new AnswerBook({ overrides: scenario.answers ?? {} });
    const creator = await buildCreator({ ...scenario, name: `${PREFIX}bookprobe [creator]` },
      { book: cBook, unofferable: [] });
    stages.push({ step: "after creator build", docs: await read(), itemsWithBook: books(creator) });
  } finally {
    await cleanup();
  }
  return stages;
}

export async function probeBuildPollution() {
  const targets = {
    "Human (card)": "Compendium.dnd5e.origins24.Item.phbspHuman000000",
    "Fighter (card)": "Compendium.dnd5e.classes24.Item.phbftrFighter000",
    "Second Wind (granted)": "Compendium.dnd5e.classes24.Item.phbftrSecondWind",
    "Resourceful (granted)": "Compendium.dnd5e.origins24.Item.phbsptResourcefu"
  };
  const read = async () => {
    const out = {};
    for ( const [label, uuid] of Object.entries(targets) ) {
      out[label] = (await fromUuid(uuid))?.toObject()?.system?.source?.book ?? null;
    }
    return out;
  };

  const steps = [{ step: "start (nothing touched)", books: await read() }];
  const index = new SourceIndex();
  await index.load();
  steps.push({ step: "after SourceIndex.load()", books: await read() });
  await index.warmAll();
  steps.push({ step: "after warmAll()", books: await read() });
  return steps;
}

export async function probeDetailWriter() {
  const book = async uuid => (await fromUuid(uuid))?.toObject()?.system?.source?.book ?? null;
  const out = [];

  const run = async (label, uuid, fn) => {
    const before = await book(uuid);
    try { await fn(await fromUuid(uuid)); } catch ( err ) { out.push({ label, uuid, error: String(err) }); return; }
    const after = await book(uuid);
    out.push({ label, uuid, before, after, changed: before !== after });
  };

  await run("enrichHTML(relativeTo: doc)", "Compendium.dnd5e.classes24.Item.phbbrbBarbarian0", async doc => {
    await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      doc.system?.description?.value ?? "", { relativeTo: doc, secrets: false });
  });

  await run("read system.source.value", "Compendium.dnd5e.classes24.Item.phbbrdBard000000", async doc => {
    void doc.system?.source?.value;
  });

  // The proposed fix: enrich against a clone so the cached instance is never the thing prepared.
  // Reports the clone's own uuid too — `relativeTo` resolves relative links against it, so a clone
  // that has lost its identity would fix the pollution by breaking the enrichment.
  const cloneUuid = "Compendium.dnd5e.classes24.Item.phbrgrRanger0000";
  {
    const before = await book(cloneUuid);
    const doc = await fromUuid(cloneUuid);
    let clonedUuid = null;
    if ( doc ) {
      const copy = doc.clone({}, { keepId: true });
      clonedUuid = copy?.uuid ?? null;
      await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        copy.system?.description?.value ?? "", { relativeTo: copy, secrets: false });
    }
    out.push({ label: "enrich against a clone", uuid: cloneUuid, before, after: await book(cloneUuid),
      changed: before !== await book(cloneUuid), clonedUuid, originalUuid: doc?.uuid ?? null });
  }

  await run("toObject() only (control)", "Compendium.dnd5e.classes24.Item.phbdrdDruid00000", async doc => {
    void doc.toObject();
  });

  return out;
}

export async function probeOpenApps() {
  const instances = [...(foundry.applications.instances?.entries() ?? [])].map(([id, app]) => ({
    id,
    ctor: app?.constructor?.name ?? null,
    rendered: app?.rendered ?? null,
    hasClose: typeof app?.close === "function",
    // The core singletons hang off `ui`; anything found there is interface, not a module window.
    isCoreUi: Object.entries(ui).some(([, v]) => v === app)
  }));
  const uiKeys = Object.entries(ui)
    .filter(([, v]) => v && (typeof v === "object"))
    .map(([k, v]) => ({ key: k, ctor: v?.constructor?.name ?? null,
      inInstances: [...(foundry.applications.instances?.values() ?? [])].includes(v) }));

  return {
    instanceCount: instances.length,
    coreUiInInstances: instances.filter(i => i.isCoreUi).length,
    instances,
    ui: uiKeys
  };
}

export async function probeReplacement(uuid) {
  const item = await fromUuid(uuid);
  if ( !item ) throw new Error(`no item at ${uuid}`);

  const named = ["HitPoints", "Size", "Trait", "ItemChoice", "ItemGrant",
    "AbilityScoreImprovement", "Subclass"];
  const out = [];
  for ( const adv of item.system.advancement ?? [] ) {
    const replacements = adv.configuration?.replacements;
    const hasReplacements = replacements && !foundry.utils.isEmpty(replacements);
    if ( (adv.type !== "ItemGrant") && !hasReplacements ) continue;
    out.push({
      id: adv.id,
      type: adv.type,
      ctor: adv.constructor?.name ?? null,
      // Whether `native.mjs`'s `switch (adv.type)` sends this to a named case rather than to
      // `default`, which is the only branch that drives a replacement grant.
      dispatchesToDefault: !named.includes(adv.type),
      level: adv.level ?? adv.levels ?? null,
      hasReplacements: !!hasReplacements,
      replacements: hasReplacements ? replacements : null,
      items: Array.from(adv.configuration?.items ?? [])
        .map(i => (typeof i === "string") ? { uuid: i } : { uuid: i.uuid, optional: i.optional })
    });
  }
  return { uuid, name: item.name, advancements: out };
}

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
