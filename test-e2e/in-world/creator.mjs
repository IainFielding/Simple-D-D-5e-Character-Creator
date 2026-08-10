/**
 * The build under test: a character produced by the Simple Character Creator's own pipeline.
 *
 * The wizard's UI exists only to fill a {@link CreatorState}; the actual build is
 * `assembleActor(state, source, equipment)`, which resolves the choices, stages the origin items
 * on an AdvancementManager, and drives them through the shared `LevelUpDriver`. This adapter
 * populates that state directly from the scenario and calls the real assembler — so the whole
 * choice-resolver → creation-manager → driver → commit path is exercised, without the harness
 * having to click through wizard steps whose bugs are not what this comparison is about.
 *
 * The scenario answers the *same* table the native adapter uses: advancement id → picks. Mapping
 * that onto the creator's storage (`state.advChoices[source][selKey]`) is this file's real job,
 * because the resolver splits one advancement into several requirements when it carries several
 * choice groups (a Trait with two pools), each with its own `selKey`.
 */

const MODULE = "/modules/sogrom-dnd5e-character-creator/scripts";

// Import the module under test *without* a cache-buster: these must be the same module instances
// the running world already loaded, not fresh copies with their own state.

const { assembleActor } = await import(`${MODULE}/build/actor-assembler.mjs`);
const { CreatorState } = await import(`${MODULE}/state/creator-state.mjs`);
const { SourceIndex } = await import(`${MODULE}/data/source-index.mjs`);
const { resolveChoices } = await import(`${MODULE}/data/choice-resolver.mjs`);
const { LevelUpDriver } = await import(`${MODULE}/levelup/manager-driver.mjs`);
const { resolveFeatSpells } = await import(`${MODULE}/steps/feat-spells-step.mjs`);
const { isEmberCreationManager, foldOriginScreens } = await import(`${MODULE}/levelup/ember-creation.mjs`);
const BUST = new URL(import.meta.url).search;
const { ScenarioChoiceProvider } = await import(`./provider.mjs${BUST}`);
const { stageEmberManager } = await import(`./ember.mjs${BUST}`);

/**
 * Wait for the writes the system makes *off* a commit to land, before anything reads the actor.
 *
 * Several of dnd5e's `_onCreate` handlers finish the job with a deliberately un-awaited
 * `actor.update`: `SubclassData` sets `attributes.spellcasting` for a subclass-derived caster,
 * `ClassData` assigns the primary class, `BackgroundData` links the background. All of them arrive a
 * tick or more after `commit()` resolves, so reading the actor immediately compares a settled build
 * against an unsettled one — which reads as a missing casting ability or an unlinked background.
 *
 * Watching the actor go quiet is not enough on its own: "unchanged since the last sample" is true
 * *trivially* in the window before a pending write has landed, so a naive version returns
 * immediately and reads the actor a moment too early. Hence `floor` — the earliest this may conclude
 * — with the quiet check on top of it to catch the slower cases.
 *
 * The floor is per-caller because the right one differs by an order of magnitude. A level-up commits
 * one or two items and is done almost at once; Ember's hand-off creates the whole character in a
 * single write and chains `ClassData`, `BackgroundData` and race handlers behind it. A floor long
 * enough for the second would add tens of seconds per scenario to the first, and the incremental
 * sweep pays it twenty times over.
 * @param {Actor5e} actor
 * @param {object} [options]
 * @param {number} [options.floor]  Earliest this may return, however quiet the actor looks.
 * @param {number} [options.quiet]  How long unchanged, past the floor, counts as settled.
 * @param {number} [options.cap]    Give up waiting after this; a build that never settles is a
 *                                  finding for the diff to report, not something to hang on.
 */
async function settle(actor, { floor = 300, quiet = 150, cap = 5000 } = {}) {
  const started = Date.now();
  const snap = () => JSON.stringify(actor?.toObject() ?? null);
  let last = snap();
  while ( (Date.now() - started) < cap ) {
    await new Promise(resolve => setTimeout(resolve, quiet));
    const now = snap();
    const quietNow = now === last;
    last = now;
    if ( quietNow && ((Date.now() - started) >= floor) ) return;
  }
}

/** The index is expensive to build and stateless between scenarios — build it once. */
let sourceIndex = null;
async function getSourceIndex() {
  if ( !sourceIndex ) {
    sourceIndex = new SourceIndex();
    await sourceIndex.load();
  }
  return sourceIndex;
}

/* -------------------------------------------- */

/**
 * Distribute one advancement's answer across the resolver requirements that represent it.
 *
 * A single Trait advancement with two choice pools becomes two requirements (`<advId>#0`,
 * `<advId>#1`), and the scenario states the picks as one flat list — the same list the native
 * flow's single select consumes. Each requirement claims the answers its own option list offers,
 * up to its `count`, and claimed keys are removed so two pools never take the same one.
 * A pick this side cannot offer is the interesting case, and what should happen depends on where the
 * answer came from. A *hand-written* scenario naming an unofferable key has gone stale against the
 * content, and building a quietly different character from it would be worse than stopping — so it
 * throws. A *generated* answer came from what the other side was showing, so an unofferable key
 * means the two sides offer different pools: a finding in its own right, reported through
 * `unofferable` and left out of the picks rather than taking the whole scenario down with it.
 * @param {object[]} reqs           Requirements sharing an advancement id.
 * @param {string[]} answer         The picks for that advancement.
 * @param {object} [options]
 * @param {object[]} [options.unofferable]   Collector; its presence is what makes this tolerant.
 * @returns {Map<string, string[]>}  selKey → picks.
 */
function distribute(reqs, answer, { unofferable } = {}) {
  const remaining = [...answer];
  const out = new Map();
  for ( const req of reqs ) {
    // Enabled options only. The resolver keeps a key another source already grants in the list but
    // greys it out, and writing a greyed-out pick back is what made a 2014 Rogue oscillate forever:
    // the Acolyte's language choice offers Thieves' Cant, the class *grants* it, and the book — which
    // memoises its answer on the first pass, before anything was selected to dedupe against — kept
    // re-supplying it after the resolver stripped it to reopen the slot. Filtering the pool the book
    // is *shown* cannot fix that on its own, because the memo predates the narrowing; the answer has
    // to be filtered where it is applied.
    const offered = new Set((req.options ?? []).filter(o => !o.disabled).map(o => o.key));
    const taken = [];
    for ( let i = 0; i < remaining.length && taken.length < (req.count ?? 1); ) {
      if ( offered.has(remaining[i]) ) taken.push(remaining.splice(i, 1)[0]);
      else i++;
    }
    out.set(req.selKey, taken);
  }

  if ( remaining.length ) {
    const titles = reqs.map(r => `"${r.title}"`).join(", ");
    if ( !unofferable ) throw new Error(`picks not offered by ${titles}: ${remaining.join(", ")}`);
    // `answerChoices` re-resolves to a fixed point, so the same advancement reaches here once per
    // pass; the finding is about the advancement, not about how many passes it took.
    if ( unofferable.some(u => u.advId === reqs[0].advId) ) return out;
    unofferable.push({
      advId: reqs[0].advId, title: reqs[0].title, type: reqs[0].type, source: reqs[0].source,
      picks: remaining,
      offers: [...new Set(reqs.flatMap(r => (r.options ?? []).map(o => o.key)))]
    });
  }
  return out;
}

/**
 * Coerce a scenario answer into the flat key list the resolver stores.
 *
 * Answers come in the shapes the *native* forms take, which are not uniform: a list of keys/uuids,
 * a bare string (a size, a casting ability), or `{ uuids, ability }`. An ability-score assignment
 * (`{ int: 2 }`) is not a pick list at all — it reaches the creator through `originAbilities`,
 * so it returns null and is skipped here.
 * @param {string[]|string|object} answer
 * @returns {string[]|null}
 */
function normalisePicks(answer) {
  if ( Array.isArray(answer) ) return answer;
  if ( typeof answer === "string" ) return [answer];
  if ( answer?.uuids || answer?.ability ) return [...(answer.uuids ?? []), ...(answer.ability ? [answer.ability] : [])];
  return null;
}

/**
 * The real Advancement behind a resolver requirement.
 *
 * The resolver hands back its own requirement objects, but the book answers *advancements* — that is
 * what both adapters have in common, and asking it anything else would give the two sides different
 * questions.
 *
 * `req.ownerUuid` is only set for a *nested* owner: a feature the origin grants that carries
 * advancements of its own (`levelOneOwners` documents this). An origin item's own advancements leave
 * it null, so the origin's uuid comes from the scenario instead, keyed by the requirement's source.
 * @param {object} req
 * @param {object} origins   source key ("class"/"species"/"background") → uuid.
 * @returns {Promise<Advancement|null>}
 */
async function advancementFor(req, origins) {
  const uuid = req?.ownerUuid ?? origins[req?.source];
  if ( !uuid || !req.advId ) return null;
  const doc = await fromUuid(uuid).catch(() => null);
  return doc?.advancement?.byId?.[req.advId] ?? null;
}

/**
 * Answer every resolved requirement from the book, re-resolving until the answers stop changing.
 * Re-resolution matters because a pick can *reveal* further choices — taking Magic Initiate as a
 * species origin feat adds its own spell requirements.
 *
 * The resolver hands back requirements, not advancements, so the book is asked with a stand-in
 * carrying the fields generation reads. That is enough for the level-1 origins: every choice they
 * raise is answerable from the requirement's own advancement data, which the resolver copies over.
 * @param {CreatorState} state
 * @param {SourceIndex} source
 * @param {AnswerBook} book         The scenario's answers.
 * @param {object} [tracking]
 * @param {Set<string>} [tracking.consumed]    Collects the advancement ids an answer was written for.
 * @param {object} [tracking.diagnostics]      Filled with the final resolver view (see `buildCreator`).
 * @param {object[]} [tracking.unofferable]    Collector for picks this side cannot offer; see
 *   {@link distribute}. Supplied only for a generating scenario.
 */
async function answerChoices(state, source, book, { consumed = new Set(), diagnostics, unofferable } = {}) {
  const origins = {
    class: state.classUuid, species: state.speciesUuid, background: state.backgroundUuid
  };
  /** Per-pass record of what changed, so a failure to settle can say *what* is oscillating. */
  const passChurn = [];
  for ( let pass = 0; pass < 5; pass++ ) {
    const resolved = await resolveChoices(state, source);
    state.choiceCache = resolved;

    // Only the settled pass's failures are real. A pool can legitimately be empty mid-loop — the
    // Rogue's Expertise offers the skills the build has made it proficient in, so before the class's
    // own skill choice is answered it offers only what the background granted. Recording that would
    // report a transient as a finding, and the corrected state on the next pass would never be seen.
    const passUnofferable = unofferable ? [] : null;

    // Group requirements by advancement so multi-pool advancements are distributed together.
    const byAdv = new Map();
    for ( const src of resolved.sources ?? [] ) {
      for ( const req of src.requirements ?? [] ) {
        if ( !req.advId ) continue;
        const list = byAdv.get(req.advId) ?? [];
        list.push(req);
        byAdv.set(req.advId, list);
      }
    }

    let changed = false;
    // What moved this pass, for the error below. "Did not settle" with no detail says only that
    // something oscillates; naming the selKeys and the values they alternate between turns a
    // bisecting session into a read.
    const churn = [];
    for ( const [advId, reqs] of byAdv ) {
      const adv = await advancementFor(reqs[0], origins);
      // Not "no answer" but "no question" — the book cannot be asked and an answer for this
      // requirement would be silently dropped, which is exactly the failure mode worth shouting at.
      if ( !adv ) {
        throw new Error(`cannot resolve the advancement behind requirement ${reqs[0].selKey} `
          + `("${reqs[0].title}", ${reqs[0].source}, owner ${reqs[0].ownerUuid ?? "—"})`);
      }
      // The requirement's own already-gated option list stands in for the pool the native flow
      // renders — the resolver has done the prerequisite filtering the compendium documents alone
      // could not.
      //
      // Disabled options are excluded, because a player cannot pick one either: the resolver keeps a
      // key another source already grants in the list but greys it out, which is right for a screen
      // and wrong for a pool to answer from. Offering them made the loop oscillate forever on a
      // 2014 Rogue — the Acolyte's language choice offers Thieves' Cant, the class *grants* it, so
      // the book picked it, the cross-source dedupe stripped it to reopen the slot, and the memoised
      // answer put it straight back.
      const answer = await book.answer(adv, reqs[0].level ?? 0, {
        asker: "creator",
        offered: () => reqs.flatMap(r => (r.options ?? []).filter(o => !o.disabled).map(o => o.key))
      });
      if ( (answer === undefined) || (answer === null) ) continue;
      // A feat's spell choices are not stored in `advChoices` at all — the creator owns them in
      // its feat-spells step and applies them to the actor after commit, so their answers are
      // routed through `state.featSpells` instead (see `applyFeatSpells` below). The resolver
      // surfaces them with no options, so trying to distribute picks here would fail.
      if ( reqs.some(r => r.spellStep) ) continue;
      const picks = normalisePicks(answer);
      if ( !picks ) continue;                              // an ASI map — handled from `originAbilities`
      consumed.add(advId);
      for ( const [selKey, keys] of distribute(reqs, picks, { unofferable: passUnofferable }) ) {
        const bucket = state.advChoices[reqs[0].source] ??= {};
        const current = bucket[selKey] ?? [];
        if ( (current.length === keys.length) && keys.every(k => current.includes(k)) ) continue;
        churn.push(`${reqs[0].source}:${selKey} ${JSON.stringify(current)} -> ${JSON.stringify(keys)}`
          + ` (offered ${(reqs.flatMap(r => r.options ?? []).map(o => o.key)).join("|") || "nothing"})`);
        bucket[selKey] = keys;
        changed = true;
      }
    }

    passChurn.push(churn);
    if ( !changed ) {
      if ( passUnofferable?.length ) unofferable.push(...passUnofferable);
      if ( diagnostics ) {
        diagnostics.passes = pass + 1;
        diagnostics.requirements = [...byAdv].flatMap(([advId, reqs]) => reqs.map(req => ({
          advId,
          selKey: req.selKey,
          type: req.type,
          source: req.source,
          count: req.count,
          title: req.title,
          answered: consumed.has(advId),
          chosen: state.advChoices[req.source]?.[req.selKey] ?? [],
          options: (req.options ?? []).map(o => o.key).slice(0, 12),
          moreOptions: Math.max(0, (req.options?.length ?? 0) - 12)
        })));
        diagnostics.advChoices = JSON.parse(JSON.stringify(state.advChoices));
      }
      return resolved;
    }
  }
  const detail = passChurn
    .map((c, i) => `  pass ${i + 1}:\n${c.map(l => `    ${l}`).join("\n") || "    (nothing)"}`)
    .join("\n");
  throw new Error(`choice answers did not settle after 5 resolver passes\n${detail}`);
}

/**
 * Fill in the picks for a Magic Initiate-style feat's spells.
 *
 * These do not go through the advancement machinery on the creator's side at all. The creator
 * surfaces them in its own feat-spells step and `assembleActor` creates the spells directly on
 * the actor afterwards, hand-applying the casting configuration the advancement would otherwise
 * have applied — which is exactly why comparing them against the native build is worth doing.
 *
 * The scenario states them per feat uuid; the creator keys them by `${source}:${featUuid}`, so
 * the grants are resolved to find the right key (and to fail loudly if the feat is not actually
 * granted by this build).
 * @param {CreatorState} state
 * @param {SourceIndex} source
 * @param {object} scenario
 */
async function answerFeatSpells(state, source, scenario) {
  const wanted = scenario.featSpells;
  if ( !wanted || !Object.keys(wanted).length ) return;

  const grants = await resolveFeatSpells(state, source);
  state.featSpellCache = grants;

  for ( const [featUuid, picks] of Object.entries(wanted) ) {
    const grant = grants.find(g => g.featUuid === featUuid);
    if ( !grant ) {
      throw new Error(`the build grants no spell-bearing feat ${featUuid} `
        + `(it grants: ${grants.map(g => g.featUuid).join(", ") || "none"})`);
    }
    state.featSpells[grant.key] = {
      // A grant that fixes its own class list or ability leaves nothing to choose; state the
      // pick anyway and let the assembler prefer the fixed value, as it does for a real player.
      list: picks.list ?? grant.classList[0] ?? null,
      ability: picks.ability ?? grant.abilityKeys[0] ?? null,
      cantrips: picks.cantrips ?? [],
      spells: picks.spells ?? []
    };
  }
}

/* -------------------------------------------- */

/**
 * Build the scenario's character through the creator's assembler.
 * @param {object} scenario
 * @param {object} [options]
 * @param {object} [options.diagnostics]   Filled in with the resolver's final view: every
 *   requirement it raised (type, source, selKey, offered options, whether the scenario answered
 *   it) and the resulting `state.advChoices`. Reported by `run.mjs --debug`.
 * @returns {Promise<Actor5e>}
 */
export async function buildCreator(
  scenario, { book, diagnostics, unofferable, onLevel, consumed = new Set() } = {}
) {
  if ( scenario.ember ) return buildEmberCreator(scenario, { book, consumed, onLevel });

  const source = await getSourceIndex();
  const actor = await Actor.implementation.create({
    name: scenario.name,
    type: "character"
  }, { render: false });

  const state = new CreatorState(actor);
  state.classUuid = scenario.classUuid ?? null;
  state.speciesUuid = scenario.speciesUuid ?? null;
  state.backgroundUuid = scenario.backgroundUuid ?? null;
  state.details.name = scenario.name;

  // Point-buy is just a carrier here: `resolvedScores()` returns these values verbatim, which is
  // what the native reference was created with.
  state.abilityMethod = "point-buy";
  state.pointBuy = { ...state.pointBuy, ...scenario.abilities };

  // An origin's ability increase is applied by its own ASI advancement during the driver pass, from
  // `originDeltas(source)` = the advancement's fixed part + the player's allocation. Which origin
  // carries one is an edition question — 2024 puts it on the background, 2014 on the species — so
  // both are offered to the book; a scenario only ever answers whichever exists.
  for ( const [src, field] of [["species", "speciesUuid"], ["background", "backgroundUuid"]] ) {
    const doc = state[field] ? await fromUuid(state[field]) : null;
    const asi = doc ? await source.abilityScoreIncrease(state[field], doc) : null;
    state.originAsi[src] = asi;
    if ( !asi ) continue;
    // Asked with the origin's *real* advancement, not the flattened record: the native side asks
    // about that object, and both have to put the same question to the book or the memo would hold
    // two entries and answer them independently.
    const asiAdv = doc.advancement?.byId?.[asi.id];
    const assignment = await book.answer(asiAdv, asiAdv?.level ?? 0, { asker: "creator" });
    if ( assignment ) consumed.add(asi.id);
    // The scenario states the *total* assignment (as the native ASI form takes it), so the
    // allocation is that minus whatever the advancement fixes itself. A purely fixed increase
    // (Hill Dwarf) leaves the allocation empty and still applies, through `fixed` alone.
    for ( const [key, total] of Object.entries(assignment ?? {}) ) {
      state.originAbilities[src][key] = Number(total) - Number(asi.fixed?.[key] ?? 0);
    }
  }

  await answerChoices(state, source, book, { consumed, diagnostics, unofferable });
  await answerFeatSpells(state, source, scenario);

  // Equipment is out of scope for an advancement comparison — the native reference grants none.
  // `assembleActor` writes the base scores itself (from `resolvedScores()`) *before* running the
  // driver, so the background ASI lands on top of them exactly as it does natively. Nothing may
  // touch `system.abilities` after this point or that increase would be overwritten.
  await assembleActor(state, source, null);
  await settle(actor);
  await onLevel?.(1, actor);

  await levelUp(actor, scenario, book, consumed, onLevel);
  await multiclass(actor, scenario, book, consumed);
  await settle(actor);
  return actor;
}

/**
 * The creator's side of an Ember hand-off.
 *
 * In a real Ember world `intercept.mjs` claims the manager Ember renders and hands it to the
 * interactive shell. This is that path with the UI removed, exactly as {@link levelUp} is for an
 * ordinary level-up: the same driver, the same `foldOriginScreens`, the same commit — answered by
 * the book instead of by a person.
 *
 * `isEmberCreationManager` is asserted rather than assumed. It is the module's own fingerprint for
 * "this is Ember's hand-off", and if a staged manager does not satisfy it the scenario is testing
 * something that would never reach this code in a real world — better to fail loudly than to quietly
 * compare two builds of a manager the module would have ignored.
 * @param {object} scenario
 * @param {object} options
 * @returns {Promise<Actor5e>}
 */
async function buildEmberCreator(scenario, { book, consumed, onLevel }) {
  const { actor, manager } = await stageEmberManager(scenario);
  if ( !isEmberCreationManager(manager) ) {
    throw new Error("the staged manager is not one the module would claim as an Ember hand-off — "
      + "either Ember is not active in this world, or its staging and `isEmberCreationManager` "
      + "have diverged (see in-world/ember.mjs)");
  }

  manager._sogromLevelUp = true;
  const driver = new LevelUpDriver(manager);
  await driver.prepare();
  // Origin decisions belong on the level-1 screen for a character being created; the shell does this
  // too. It moves `screenLevel` only, so nothing about what applies where changes.
  foldOriginScreens(driver);
  await warmBook(driver, book);

  const provider = new ScenarioChoiceProvider(book);
  await driver.autoResolve(provider);
  await driver.commit();
  for ( const id of provider.consumed ) consumed.add(id);

  // A patient floor here: one commit creates the entire character, so `ClassData._onCreate`'s
  // primary-class assignment, `BackgroundData`'s link and the race link all queue behind it.
  await settle(actor, { floor: 1500 });
  await onLevel?.(1, actor);
  return actor;
}

/**
 * Add a second class, the way the module's multiclass level-up does.
 *
 * The distinction from {@link levelUp} is `forNewItem` rather than `forLevelChange`: the class is
 * staged onto the manager's clone rather than existing on the actor, which is what
 * `LevelUpDriver.canDrive`'s `allowNewClass` option exists to recognise. The gate itself is not
 * exercised here — this drives the claimed manager directly, as the level-up leg does — so what is
 * under test is the *walk*: that a secondary class contributes its `classRestriction: "secondary"`
 * advancements rather than its primary ones, and that its first level is a real hit-point decision
 * rather than the automatic maximum an original class gets.
 * @param {Actor5e} actor
 * @param {object} scenario
 * @param {Set<string>} consumed
 */
async function multiclass(actor, scenario, book, consumed) {
  const mc = scenario.multiclass;
  if ( !mc?.classUuid ) return;

  const doc = await fromUuid(mc.classUuid);
  if ( !doc ) throw new Error(`multiclass not found: ${mc.classUuid}`);
  const data = doc.toObject();
  if ( data._stats ) data._stats.compendiumSource = doc.uuid;
  data.system.levels = mc.levels ?? 1;

  const manager = dnd5e.applications.advancement.AdvancementManager.forNewItem(actor, data);
  manager._sogromLevelUp = true;
  await resolveWith(manager, book, consumed);
}

/**
 * Drive a prepared manager through `LevelUpDriver`, answering it from the book.
 *
 * The warm is the point. `autoResolve` reads its provider **synchronously**, so every answer has to
 * exist before it runs — and generating one is asynchronous (it reads compendium indexes). Warming
 * the driver's own decision records is also what makes this side's ledger complete: every decision
 * the driver surfaced is recorded as asked, whether or not it ends up answered, so it can be
 * compared against what the native wizard raised.
 * @param {AdvancementManager} manager
 * @param {AnswerBook} book
 * @param {Set<string>} consumed
 */
async function resolveWith(manager, book, consumed) {
  const driver = new LevelUpDriver(manager);
  await driver.prepare();
  const records = await warmBook(driver, book);

  const provider = new ScenarioChoiceProvider(book);
  await driver.autoResolve(provider);
  await driver.commit();
  for ( const id of provider.consumed ) consumed.add(id);

  // A subclass brings its own features into the walk *after* it is chosen, so the records that
  // carry them did not exist when the warm above ran. Nothing further needs answering by then —
  // `autoResolve` has run — but the ledger should still show what was raised.
  for ( const rec of [...driver.traitSteps, ...driver.choiceSteps, ...driver.asiSteps] ) {
    if ( !records.includes(rec) ) book.peek(rec.advancement, rec.level, "creator");
  }
}

/**
 * Ask the book about every decision the driver surfaced, before anything reads an answer back.
 *
 * `autoResolve` reads its provider **synchronously**, and generating an answer is not — it reads
 * compendium indexes — so the answers have to exist first. Warming is also what makes this side's
 * ledger complete: every decision the driver raised is recorded as asked, answered or not, so it can
 * be compared against what the native wizard raised.
 * @param {LevelUpDriver} driver
 * @param {AnswerBook} book
 * @returns {Promise<object[]>}  The records warmed, so a caller can tell which were already present.
 */
async function warmBook(driver, book) {
  const records = [
    ...driver.hpSteps, ...driver.sizeSteps, ...driver.grantSteps, ...driver.subclassSteps,
    ...driver.asiSteps, ...driver.traitSteps, ...driver.choiceSteps
  ];
  for ( const rec of records ) {
    await book.answer(rec.advancement, rec.level, { asker: "creator", offered: () => offeredFor(driver, rec) });
  }
  return records;
}

/**
 * The options a driver decision is showing, for the pools the book cannot derive from configuration
 * alone. Everything else answers from the advancement itself and needs no list.
 */
async function offeredFor(driver, rec) {
  if ( rec.advancement?.type !== "Trait" ) return [];
  const options = await driver.traitOptions(rec).catch(() => []);
  return options.filter(o => !o.owned && !o.disabled).map(o => o.key);
}

/**
 * Carry a just-created level-1 character up to the scenario's target level.
 *
 * This mirrors `intercept.mjs#launchLevelUpTo` — one `forLevelChange` manager for the whole jump,
 * driven by `LevelUpDriver` and committed once — with the interactive `LevelUpShell` replaced by a
 * {@link ScenarioChoiceProvider}. The shell exists only to fill the provider interface that
 * `autoResolve` reads, so answering it directly still exercises the entire driver: the walk, the
 * subclass resolution, the feature synthesis a subclass pulls in, and the commit.
 *
 * `_sogromLevelUp` is set for the same reason the native side sets it: the manager is never
 * rendered here, and the flag stops the module's own takeover hook claiming it if anything else
 * forces a render.
 * @param {Actor5e} actor
 * @param {object} scenario
 * @param {Set<string>} consumed   Shared with the creation pass; the provider records into it so
 *   the orphaned-answer check can see answers read by either leg.
 */
async function levelUp(actor, scenario, book, consumed, onLevel) {
  const target = scenario.targetLevel ?? 1;
  if ( target <= 1 ) return;

  const classItem = actor.items.find(i => i.type === "class");
  if ( !classItem ) throw new Error("cannot level up: the creator built no class");
  const from = classItem.system?.levels ?? 1;
  if ( target <= from ) return;

  // One manager for the whole jump, or one per level when the scenario asks for it — see the same
  // branch in `native.mjs` for why the two are worth testing separately.
  const stride = scenario.incremental ? 1 : (target - from);
  for ( let level = from + stride; level <= target; level += stride ) {
    const manager = dnd5e.applications.advancement.AdvancementManager
      .forLevelChange(actor, classItem.id, stride);
    manager._sogromLevelUp = true;
    await resolveWith(manager, book, consumed);
    await settle(actor);
    await onLevel?.(level, actor);
  }
}
