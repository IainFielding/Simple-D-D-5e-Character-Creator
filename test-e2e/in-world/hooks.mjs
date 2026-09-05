/**
 * The public hook and API surface, asserted against the real wizards — running *inside* the world.
 *
 * **Why this is an assertion and not a scenario.** The equivalence suite builds a character twice
 * and diffs the results, and hooks have no native counterpart to diff against: dnd5e emits nothing
 * comparable, so there is no reference side. Forcing them into that shape would make them weaker,
 * which is the same argument `checkGrantedSpells` and `checkSidekicks` make for themselves.
 *
 * **Why it cannot live in the equivalence adapter either.** `creator.mjs` calls `assembleActor()`
 * and `driver.autoResolve()` directly and never constructs a shell — deliberately, since the UI is
 * not what that comparison is about. Eleven of the thirteen hooks are emitted *from* the shells, so
 * they are structurally invisible there. This module opens the real `CreatorShell` and the real
 * `LevelUpShell`, the way `shots.mjs` does, because the emission sites are the subject.
 *
 * **What the unit tests already cover, and this does not repeat:** the name registry, the veto
 * semantics of `fireCancellableHook`, and a throwing listener not counting as a veto
 * (`test/api.test.mjs`). Those are pure logic and belong in vitest.
 *
 * **What only this can cover:** whether each hook is emitted *at the right place, in the right
 * order, exactly once*. The case that earns the whole file is `characterCreated` on a build that
 * starts above level 1: the creator hands the 1 → N climb to the level-up wizard, so the character
 * is not finished when `assembleActor` returns, and the hook has to fire from the *other* wizard —
 * once, with the level actually reached. Nothing in a unit test can see that.
 *
 * Decisions inside the level-up wizard are answered by the harness's own generating `AnswerBook`
 * rather than by clicking: what is under test is the shell's *apply*, not its screens.
 */

const MODULE = "/modules/sogrom-dnd5e-character-creator/scripts";

// Sibling harness files carry the runner's cache-buster, exactly as `harness.mjs` does — browsers
// cache each module URL independently, so importing them bare would load a *second* copy beside
// the one the runner already has. The module under test is imported without a buster, because the
// whole point is to observe the instance the world actually loaded.
const BUST = new URL(import.meta.url).search;

const { CreatorShell } = await import(`${MODULE}/app/creator-shell.mjs`);
const { applyQuickBuild } = await import(`${MODULE}/data/quick-build.mjs`);
const { getSources, warmSources } = await import(`${MODULE}/data/source-cache.mjs`);
const { MODULE_ID, HOOKS, launchWindowOptions } = await import(`${MODULE}/config.mjs`);
const { triggerLevelUp } = await import(`${MODULE}/levelup/intercept.mjs`);
const { REQUIRED_STEPS } = await import(`${MODULE}/steps/registry.mjs`);

const { AnswerBook } = await import(`./answers.mjs${BUST}`);
const { ScenarioChoiceProvider } = await import(`./provider.mjs${BUST}`);

/** Every actor this module builds carries the harness prefix, so `cleanup()` reclaims them. */
const PREFIX = "[e2e] ";

/* -------------------------------------------- */
/*  Recording                                   */
/* -------------------------------------------- */

/**
 * Subscribe to all thirteen hooks and collect what fires, in order.
 *
 * Returns a handle with the tape and an `off()` — every case takes its own, so one case's
 * emissions can never be read by the next. Listening via `HOOKS` rather than literal strings is
 * deliberate: a rename that the unit test catches should not *also* silently stop this file
 * observing anything, which is what hard-coded names would do.
 */
function record() {
  const tape = [];
  const ids = [];
  for ( const name of Object.values(HOOKS) ) {
    ids.push([name, Hooks.on(name, payload => tape.push({ hook: name, payload }))]);
  }
  return {
    tape,
    /** Just the hook names, in fire order — what the sequence assertions read. */
    names: () => tape.map(e => e.hook),
    /** How many times one hook fired. */
    count: hook => tape.filter(e => e.hook === hook).length,
    /** The payload of the first (or only) firing of a hook. */
    payload: hook => tape.find(e => e.hook === hook)?.payload ?? null,
    off: () => ids.forEach(([name, id]) => Hooks.off(name, id))
  };
}

/**
 * Assert that `subset` appears inside `names` in order, allowing anything in between.
 *
 * Order matters and exhaustiveness does not: step changes fire an unpredictable number of times
 * depending on how many steps a Quick Build leaves incomplete, and pinning that count would make
 * the test fail on content changes rather than on regressions.
 * @returns {string|null}  A failure message, or null.
 */
function inOrder(names, subset, label) {
  let at = 0;
  for ( const want of subset ) {
    const found = names.indexOf(want, at);
    if ( found < 0 ) return `${label}: expected ${want} after ${subset[subset.indexOf(want) - 1] ?? "start"}; got [${names.join(", ")}]`;
    at = found + 1;
  }
  return null;
}

/* -------------------------------------------- */
/*  Driving the real wizards                    */
/* -------------------------------------------- */

const pause = ms => new Promise(r => setTimeout(r, ms));

/**
 * Close every application this module may have left open, so cases cannot bleed into each other.
 *
 * **Scoped to windows that are not part of the core interface.** Foundry v14 registers the whole UI
 * in `foundry.applications.instances` alongside module windows — on this world it holds 22 entries
 * of which 20 are core: the sidebar, chat, hotbar, scene navigation, the directories, the combat
 * tracker. Closing those tears down the interface the suite is driving, and one of them never
 * resolving hung the entire hooks run for 93 minutes with no server traffic at all, past its own
 * `waitForStage` ceiling, because nothing here has a timeout.
 *
 * `ui` is the register of what is core, so anything reachable from it is left alone. A close is also
 * only awaited when there is one to await — `app.close?.(…).catch(…)` reads a property of `undefined`
 * and throws synchronously for anything without the method.
 */
async function closeAll() {
  const core = new Set(Object.values(ui).filter(v => v && (typeof v === "object")));
  const closeOne = async app => {
    if ( !app || core.has(app) || (typeof app.close !== "function") ) return;
    await Promise.resolve(app.close({ force: true })).catch(() => {});
  };
  for ( const app of Object.values(ui.windows ?? {}) ) await closeOne(app);
  for ( const app of [...(foundry.applications.instances?.values() ?? [])] ) await closeOne(app);
  await pause(200);
}

/** Resolve once the creator's stage has real content rather than its loading spinner. */
async function waitForStage(timeout = 420_000) {
  const started = Date.now();
  while ( (Date.now() - started) < timeout ) {
    const el = document.querySelector(".creator-stage");
    if ( el && !el.querySelector(".creator-loading") ) return;
    await pause(500);
  }
  throw new Error("creator stage never finished loading");
}

/**
 * Open the creator through the **public API** rather than by constructing the shell.
 *
 * That is the point of doing it this way here: it exercises `api.launchCreator` and the
 * `preOpenCreator` gate as a consumer would reach them, which no other harness path does.
 */
async function openCreator() {
  await closeAll();
  const api = game.modules.get(MODULE_ID)?.api;
  if ( !api ) throw new Error("module API is not installed");
  const shell = await api.launchCreator();
  if ( shell ) await waitForStage();
  return shell;
}

/**
 * Fill a complete, valid character with the real Quick Build, seeded so runs agree.
 *
 * **A class has to be chosen first.** Quick Build fills from the *selected class's* suggestion
 * profile, so `applyQuickBuild` returns `{ok: false, warnings: ["no-class"]}` immediately without
 * one — it is the class step's button, and a class is its precondition. Fighter, because it is the
 * simplest complete character in the world: no spell picks, no level-1 subclass.
 *
 * Every outcome here is asserted rather than assumed. An unfilled state makes `_finish` return at
 * its completeness guard *silently*, which is indistinguishable from "the hook was never emitted"
 * — so a failure would be reported against the hook rather than against the fill that caused it.
 */
async function fill(shell, { name, targetLevel = 1 } = {}) {
  const { source, spells, equipment } = getSources();

  const classes = source.classes();
  if ( !classes.length ) throw new Error("no classes in the world's compendiums");
  const pick = classes.find(c => (c.name === "Fighter") && c.uuid.includes("dnd-players-handbook"))
    ?? classes.find(c => c.name === "Fighter")
    ?? classes[0];
  shell.state.classUuid = pick.uuid;

  const result = await applyQuickBuild({ state: shell.state, source, spells, equipment }, { rng: mulberry32(7) });
  if ( !result?.ok ) throw new Error(`quick build did not fill the character: ${result?.warnings?.join(", ") || "no reason given"}`);

  shell.state.details.name = name;
  shell.state.targetLevel = targetLevel;

  // Walk a couple of steps so the step-change hook has something to report. `gotoStep` is the
  // shell's own navigation, so this goes through `_leaveStepFor` exactly as a click does — and it
  // returns false when a step is not reachable, which would otherwise leave no step change at all.
  for ( const id of ["details", "review"] ) {
    if ( !shell.gotoStep(id) ) throw new Error(`could not reach the "${id}" step after a quick build`);
  }
  await pause(300);

  // The guard `_finish` applies. Reported here, by name, so an incomplete character says which
  // step is missing instead of manifesting as a hook that never fired.
  const incomplete = REQUIRED_STEPS.filter(s => !s.isComplete(shell.state)).map(s => s.id);
  if ( incomplete.length ) throw new Error(`required step(s) incomplete after quick build: ${incomplete.join(", ")}`);

  return { class: pick.name, warnings: result.warnings ?? [] };
}

/** The seeded RNG `shots.mjs` uses, so a re-run builds the same character. */
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * The open level-up wizard, if one is on screen.
 *
 * A climb opens itself from inside `CreatorShell#_finish`, so there is no handle to catch — it has
 * to be found among the live applications.
 */
function liveLevelUp() {
  for ( const app of foundry.applications.instances?.values() ?? [] ) {
    if ( app.constructor?.name === "LevelUpShell" ) return app;
  }
  return null;
}

/**
 * Answer every decision the open level-up wizard is showing, then apply it.
 *
 * Uses the harness's own generating `AnswerBook` through the same `autoResolve` the equivalence
 * adapter uses, so the wizard's required steps all report complete and `_finish` will proceed.
 * Clicking through the screens would be testing the screens; what is under test here is which
 * hooks `_finish` emits.
 */
async function applyLevelUp(shell) {
  const provider = new ScenarioChoiceProvider(new AnswerBook({ generate: true }));
  await shell.state.driver.autoResolve(provider);
  await shell._finish();
  await pause(1500);
}

/* -------------------------------------------- */
/*  The cases                                   */
/* -------------------------------------------- */

/**
 * Assert the public surface against the real wizards.
 *
 * Every case cleans up after itself and reports independently, so one failure does not cascade
 * into five — the same shape `checkGrantedSpells` uses.
 * @returns {Promise<{ok: boolean, cases: object[], failures: string[]}>}
 */
export async function checkHooks() {
  await warmSources();
  // Runs must be independent: these cases build characters and then level them, so an actor left
  // behind by a previous run is one at the wrong level wearing the name this run will use.
  const reclaimed = await purge();
  const cases = [];
  if ( reclaimed ) cases.push({ label: "Cleanup", ok: true, failures: [], notes: [`reclaimed ${reclaimed} actor(s) from a previous run`] });

  cases.push(await guard("API object shape", checkApiShape));
  cases.push(await guard("Creation at level 1: full sequence", creationSequence));
  cases.push(await guard("preCreateCharacter veto leaves nothing behind", creationVeto));
  cases.push(await guard("Creation climbing above level 1: characterCreated fires once, after the climb", creationClimb));
  cases.push(await guard("Ordinary level-up: levelUpApplied, not characterCreated", ordinaryLevelUp));
  cases.push(await guard("Discarded level-up: levelUpCancelled", cancelledLevelUp));

  const failures = cases.flatMap(c => c.failures.map(f => `${c.label}: ${f}`));
  return { ok: !failures.length, cases, failures };
}

/** Run one case, turning a throw into a reported failure rather than an aborted run. */
async function guard(label, fn) {
  const result = { label, ok: false, failures: [], notes: [] };
  try {
    await fn(result);
  } catch ( err ) {
    result.failures.push(`threw: ${err.message}`);
  } finally {
    await closeAll();
  }
  result.ok = !result.failures.length;
  return result;
}

/* -------------------------------------------- */

/** Every member docs/API.md promises is present, and of the promised kind. */
async function checkApiShape(result) {
  const api = game.modules.get(MODULE_ID)?.api;
  if ( !api ) return result.failures.push("game.modules.get(MODULE_ID).api is not installed");

  for ( const fn of ["launchCreator", "triggerLevelUp", "canLevelUp", "isCreatorCharacter"] ) {
    if ( typeof api[fn] !== "function" ) result.failures.push(`api.${fn} is not a function`);
  }
  for ( const fn of ["mode", "creationEnabled", "levelUpEnabled", "multiclassMode", "storeConfig"] ) {
    if ( typeof api.settings?.[fn] !== "function" ) result.failures.push(`api.settings.${fn} is not a function`);
  }
  for ( const cls of ["CreatorShell", "CreatorState", "LevelUpShell", "LevelUpState", "LevelUpDriver"] ) {
    if ( typeof api.internal?.[cls] !== "function" ) result.failures.push(`api.internal.${cls} is missing`);
  }
  if ( !api.version ) result.failures.push("api.version is empty");
  if ( !Object.isFrozen(api.HOOKS) ) result.failures.push("api.HOOKS is not frozen");
  if ( Object.keys(api.HOOKS ?? {}).length !== 13 ) {
    result.failures.push(`api.HOOKS has ${Object.keys(api.HOOKS ?? {}).length} entries, expected 13`);
  }
  // The settings readers must actually run — a getter that throws would be worse than a missing one.
  result.notes.push(`mode=${api.settings.mode()} creation=${api.settings.creationEnabled()} levelUp=${api.settings.levelUpEnabled()}`);
  result.notes.push(`version=${api.version}`);
}

/* -------------------------------------------- */

/** A plain level-1 build fires the creation hooks in order, and announces the character once. */
async function creationSequence(result) {
  const rec = record();
  try {
    const shell = await openCreator();
    if ( !shell ) return result.failures.push("api.launchCreator() returned null");
    const filled = await fill(shell, { name: `${PREFIX}Hooks Level One` });
    result.notes.push(`built a ${filled.class}${filled.warnings.length ? ` (quick-build warnings: ${filled.warnings.join(", ")})` : ""}`);
    await shell._finish(null);
    await pause(2500);

    const names = rec.names();
    result.notes.push(names.join(" → "));

    const bad = inOrder(names, [
      HOOKS.preOpenCreator, HOOKS.creatorOpened, HOOKS.creationStepChanged,
      HOOKS.preCreateCharacter, HOOKS.characterCreated
    ], "creation order");
    if ( bad ) result.failures.push(bad);

    if ( rec.count(HOOKS.characterCreated) !== 1 ) {
      result.failures.push(`characterCreated fired ${rec.count(HOOKS.characterCreated)}×, expected once`);
    }
    if ( rec.count(HOOKS.levelUpApplied) ) result.failures.push("levelUpApplied fired on a plain creation");

    const payload = rec.payload(HOOKS.characterCreated);
    if ( !payload?.actor ) result.failures.push("characterCreated payload carries no actor");
    if ( !payload?.state ) result.failures.push("characterCreated payload carries no creator state");
    if ( payload?.targetLevel !== 1 ) result.failures.push(`targetLevel was ${payload?.targetLevel}, expected 1`);
    if ( payload?.actor && !game.modules.get(MODULE_ID).api.isCreatorCharacter(payload.actor) ) {
      result.failures.push("isCreatorCharacter() is false for a character the creator just built");
    }
  } finally {
    rec.off();
  }
}

/* -------------------------------------------- */

/**
 * A vetoed build writes nothing.
 *
 * The assertion that matters is the actor count: a veto that still leaves an orphan in the
 * directory would be worse than no veto at all, because the player would be told no and get a
 * half-built character anyway.
 */
async function creationVeto(result) {
  const rec = record();
  const veto = Hooks.on(HOOKS.preCreateCharacter, () => false);
  const before = game.actors.size;
  try {
    const shell = await openCreator();
    await fill(shell, { name: `${PREFIX}Hooks Vetoed` });
    await shell._finish(null);
    await pause(1500);

    if ( rec.count(HOOKS.preCreateCharacter) !== 1 ) {
      result.failures.push(`preCreateCharacter fired ${rec.count(HOOKS.preCreateCharacter)}×, expected once`);
    }
    if ( rec.count(HOOKS.characterCreated) ) result.failures.push("characterCreated fired despite the veto");
    if ( game.actors.size !== before ) {
      result.failures.push(`the veto left ${game.actors.size - before} actor(s) behind`);
    }
    // The window must still be usable — the player is meant to be able to change something and
    // try again, which is the whole point of vetoing before anything is written.
    if ( !shell.rendered ) result.failures.push("the creator closed on a vetoed build");
    result.notes.push(`actors before ${before}, after ${game.actors.size}`);
  } finally {
    Hooks.off(HOOKS.preCreateCharacter, veto);
    rec.off();
  }
}

/* -------------------------------------------- */

/**
 * **The case this file exists for.**
 *
 * A build that starts above level 1 is not finished when `assembleActor` returns — the creator
 * hands the 1 → N climb to the level-up wizard, and the character is only complete when *that*
 * applies. So `characterCreated` must fire from the level-up shell, exactly once, after
 * `levelUpStarted`, carrying the level actually reached — and `levelUpApplied` must not fire at
 * all, because the player made one character rather than levelling one up.
 *
 * **Why level 2 and not higher.** The property under test is *which wizard announces the
 * character, and how many times* — the size of the climb is incidental to it, and a 1 → 2 jump
 * exercises the whole path. Going to 3 drags in a subclass decision, which the generating
 * `AnswerBook` does not invent (see "Writing a scenario" — subclasses are always named
 * explicitly), so the wizard's required steps would never complete and `_finish` would return at
 * its guard. Answering it here would mean naming a subclass uuid, which dates the moment content
 * updates — and subclass resolution is already covered across 122 subclasses by the sweep.
 * What this therefore does *not* cover: a climb spanning several levels, or one carrying a
 * subclass. Both are the sweep's job.
 */
async function creationClimb(result) {
  const rec = record();
  const target = 2;
  try {
    const shell = await openCreator();
    await fill(shell, { name: `${PREFIX}Hooks Climb`, targetLevel: target });
    await shell._finish(null);
    await pause(3000);

    const wizard = liveLevelUp();
    if ( !wizard ) return result.failures.push("the climb never opened a level-up wizard");

    // Nothing may have been announced yet: the character is not finished until this applies.
    if ( rec.count(HOOKS.characterCreated) ) {
      result.failures.push("characterCreated fired before the climb was applied");
    }
    await applyLevelUp(wizard);

    const names = rec.names();
    result.notes.push(names.join(" → "));

    const bad = inOrder(names, [
      HOOKS.preCreateCharacter, HOOKS.levelUpStarted, HOOKS.preLevelUpApply, HOOKS.characterCreated
    ], "climb order");
    if ( bad ) result.failures.push(bad);

    if ( rec.count(HOOKS.characterCreated) !== 1 ) {
      result.failures.push(`characterCreated fired ${rec.count(HOOKS.characterCreated)}×, expected exactly once`);
    }
    if ( rec.count(HOOKS.levelUpApplied) ) {
      result.failures.push("levelUpApplied fired on a creation climb — the player built one character");
    }

    const payload = rec.payload(HOOKS.characterCreated);
    const level = payload?.actor?.system?.details?.level;
    if ( level !== target ) result.failures.push(`the built character is level ${level}, expected ${target}`);
    if ( payload?.targetLevel !== target ) {
      result.failures.push(`characterCreated reported targetLevel ${payload?.targetLevel}, expected ${target}`);
    }
    // The threaded creator state is the reason `LevelUpState#creationState` exists — if it is null
    // here, the payload is not uniform across the two places a build can finish.
    if ( !payload?.state ) {
      result.failures.push("characterCreated carried no creator state from the climb (creationState not threaded)");
    }
  } finally {
    rec.off();
  }
}

/* -------------------------------------------- */

/** An ordinary level-up announces itself as a level-up, and never as a new character. */
async function ordinaryLevelUp(result) {
  const rec = record();
  try {
    const actor = await buildBaseCharacter(`${PREFIX}Hooks LevelUp`);
    if ( !actor ) return result.failures.push("could not build a character to level up");
    rec.tape.length = 0;                     // the build's own hooks are not what this case reads
    const from = actor.system.details.level;

    await closeAll();
    await triggerLevelUp(actor);
    await pause(2000);
    const wizard = liveLevelUp();
    if ( !wizard ) return result.failures.push("triggerLevelUp opened no wizard");
    await applyLevelUp(wizard);

    result.notes.push(rec.names().join(" → "));

    const bad = inOrder(rec.names(), [HOOKS.levelUpStarted, HOOKS.preLevelUpApply, HOOKS.levelUpApplied], "level-up order");
    if ( bad ) result.failures.push(bad);

    if ( rec.count(HOOKS.levelUpApplied) !== 1 ) {
      result.failures.push(`levelUpApplied fired ${rec.count(HOOKS.levelUpApplied)}×, expected once`);
    }
    if ( rec.count(HOOKS.characterCreated) ) {
      result.failures.push("characterCreated fired on an ordinary level-up");
    }
    if ( rec.count(HOOKS.levelUpCancelled) ) {
      result.failures.push("levelUpCancelled fired on an applied level-up");
    }

    const payload = rec.payload(HOOKS.levelUpApplied);
    if ( payload?.fromLevel !== from ) result.failures.push(`fromLevel was ${payload?.fromLevel}, expected ${from}`);
    if ( payload?.toLevel !== from + 1 ) result.failures.push(`toLevel was ${payload?.toLevel}, expected ${from + 1}`);
    if ( !payload?.summary ) result.failures.push("levelUpApplied carried no summary");
    if ( actor.system.details.level !== from + 1 ) {
      result.failures.push(`the actor is level ${actor.system.details.level}, expected ${from + 1}`);
    }
    result.notes.push(`level ${from} → ${actor.system.details.level}`);
  } finally {
    rec.off();
  }
}

/* -------------------------------------------- */

/**
 * A discarded level-up announces itself and changes nothing.
 *
 * Worth asserting precisely because nothing happened: a listener that opened something on
 * `levelUpStarted` has no other way to learn it should close it again.
 */
async function cancelledLevelUp(result) {
  const rec = record();
  try {
    const actor = await buildBaseCharacter(`${PREFIX}Hooks Cancel`);
    if ( !actor ) return result.failures.push("could not build a character to level up");
    rec.tape.length = 0;
    const from = actor.system.details.level;

    await closeAll();
    await triggerLevelUp(actor);
    await pause(2000);
    const wizard = liveLevelUp();
    if ( !wizard ) return result.failures.push("triggerLevelUp opened no wizard");

    // `force` skips the discard confirmation, which is a DialogV2 nobody is here to answer.
    await wizard.close({ force: true });
    await pause(800);

    result.notes.push(rec.names().join(" → "));
    if ( rec.count(HOOKS.levelUpCancelled) !== 1 ) {
      result.failures.push(`levelUpCancelled fired ${rec.count(HOOKS.levelUpCancelled)}×, expected once`);
    }
    if ( rec.count(HOOKS.levelUpApplied) ) result.failures.push("levelUpApplied fired on a discarded level-up");
    if ( actor.system.details.level !== from ) {
      result.failures.push(`a discarded level-up changed the actor: level ${from} → ${actor.system.details.level}`);
    }
  } finally {
    rec.off();
  }
}

/* -------------------------------------------- */

/**
 * Build a plain level-1 character to level up, without asserting anything about it.
 *
 * The actor is identified by **diffing the directory**, not by looking its name up. A name lookup
 * returns the *first* match, so a character left behind by an earlier run — already levelled —
 * would be found instead of the one just built, and the case would silently level the wrong actor
 * from the wrong starting level. That cost a run to find. {@link purge} makes it unlikely; this
 * makes it impossible.
 */
async function buildBaseCharacter(name) {
  await closeAll();
  const before = new Set(game.actors.map(a => a.id));
  const shell = new CreatorShell(null, launchWindowOptions());
  await shell.render(true);
  await waitForStage();
  await fill(shell, { name });
  await shell._finish(null);
  await pause(2500);
  await closeAll();
  return game.actors.find(a => !before.has(a.id) && (a.name === name)) ?? null;
}

/**
 * Delete every actor a previous run of this file left behind.
 *
 * These cases build characters and then level them, so a leftover is not merely untidy — it is a
 * character at the wrong level wearing the name the next run expects to create. Runs have to be
 * independent. Scoped to the harness prefix, like `harness.mjs`'s own `cleanup`, so real world
 * content can never be touched.
 */
async function purge() {
  const ids = game.actors.filter(a => a.name.startsWith(PREFIX)).map(a => a.id);
  if ( ids.length ) await Actor.implementation.deleteDocuments(ids, { render: false });
  return ids.length;
}
