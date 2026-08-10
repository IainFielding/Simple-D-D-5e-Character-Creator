/**
 * The reference build: a character produced by the dnd5e system's own AdvancementManager.
 *
 * This is the oracle the creator is measured against, so it deliberately goes the long way round.
 * `AdvancementManager` keeps its whole pipeline private (`#forward`, `#synthesizeSteps`,
 * `#complete`) and reachable only from a click on a `[data-action]` button, and its per-step
 * flows apply themselves from their *rendered form* (`advancement-manager.mjs` line 691:
 * `flow._updateObject(event, flow._getSubmitData())`). Short-circuiting that by calling
 * `advancement.apply()` ourselves would mean re-implementing the very walk we are trying to
 * verify — a bug in step ordering or mid-walk synthesis would then be invisible to the test.
 *
 * So: render the manager for real, fill each step's actual form controls, and click Next. The
 * only per-advancement knowledge here is *which control holds which answer*, one small filler
 * per advancement type. Everything else is the system's.
 *
 * The module under test intercepts `dnd5e.preAdvancementManagerRender` and suppresses the native
 * UI for any level-up it can drive. `manager._sogromLevelUp` is the module's own re-entry guard
 * (see `levelup/intercept.mjs`), and setting it up front makes the hook stand down — so the
 * reference build runs the native wizard even with the module active.
 */

const { stageEmberManager } = await import(`./ember.mjs${new URL(import.meta.url).search}`);

/* -------------------------------------------- */
/*  Small async helpers                          */
/* -------------------------------------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Poll a predicate until it holds.
 * @param {() => boolean} test
 * @param {string} what           Described in the timeout error.
 * @param {number} [timeout]
 */
async function until(test, what, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while ( Date.now() < deadline ) {
    if ( test() ) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The live root element of an ApplicationV2 flow, once it has painted. Waits on `form` rather
 * than `element` because that is what the flow's own submit path reads (see `driveManager`).
 */
async function flowElement(flow) {
  await until(() => !!flow?.form, `flow ${flow?.advancement?.type} to render`);
  return flow.form;
}

/**
 * Poll until a lookup yields something, then return it.
 *
 * The flows paint their frame before their *content* is ready — an ItemChoice's pool and a
 * Trait's option list are both resolved from compendia asynchronously — so a control that is
 * merely late is indistinguishable from one that will never appear unless we wait for it.
 * @param {() => *} find      Returns the thing, or a falsy value while it is not there yet.
 * @param {() => string} describe   Builds the error message if it never appears.
 * @param {number} [timeout]
 */
async function untilFound(find, describe, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for ( ;; ) {
    const found = find();
    if ( found ) return found;
    if ( Date.now() > deadline ) throw new Error(describe());
    await sleep(100);
  }
}

/**
 * Change a form control the way a user would, and give the flow's `submitOnChange` handler time
 * to apply and re-render. All the advancement flows we drive extend `AdvancementFlowV2`, whose
 * form options set `submitOnChange: true`, so a dispatched change event *is* the interaction.
 */
async function change(element) {
  element.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(150);
}

/* -------------------------------------------- */
/*  Per-advancement form fillers                 */
/* -------------------------------------------- */

/**
 * Fill the currently-rendered flow from the answer book.
 *
 * Advancements with nothing to answer (ItemGrant without an ability choice, ScaleValue, a
 * single-option Size) are handled by the system automatically and never reach here. Everything that
 * does reach here is *asked about*, answered or not, so the book's ledger is a complete record of
 * what this side of the build was offered — which is what makes it comparable with the creator's.
 * @param {object} step               The manager step being displayed.
 * @param {AnswerBook} book           The scenario's answers.
 * @param {Set<string>} [consumed]    Collects the ids an answer was read for.
 */
async function fillStep(step, book, consumed, manager) {
  const flow = step.flow;
  const adv = flow?.advancement;
  if ( !adv ) return;

  // What this screen is actually showing. Some pools cannot be derived from the configuration —
  // an expertise Trait offers "skills you are already proficient in", and an ItemChoice hides the
  // options whose prerequisites the build fails — so the book takes the rendered list from whichever
  // side asks first and hands the same picks to the other.
  const offered = () => {
    const form = flow.form;
    if ( !form ) return [];
    if ( adv.type === "Trait" ) {
      return [...(form.querySelector("[name=added]")?.options ?? [])].map(o => o.value).filter(Boolean);
    }
    if ( adv.type === "ItemChoice" ) {
      // A restriction-driven pool renders a browse button instead of checkboxes and comes back
      // empty here, which is what sends the book to the compendium scan instead.
      return [...form.querySelectorAll("[name]")]
        .filter(el => (el.type === "checkbox" || el.tagName === "DND5E-CHECKBOX") && !el.disabled)
        .map(el => el.name).filter(Boolean);
    }
    return [];
  };
  const answer = await book.answer(adv, flow.level, { asker: "native", offered });
  if ( answer !== undefined ) consumed?.add(adv.id);

  // A manager built with `automaticApplication` — Ember's hand-off is one — re-evaluates
  // `getAutomaticApplicationValue()` on every render and forwards past the step the moment nothing
  // is left to decide. Applying a pick can therefore *finish* the screen, resetting the clone and
  // leaving the advancement object captured above behind. Anything waiting on that object has to
  // accept "the manager has moved on" as the answer, or it waits for a state that will never arrive.
  const moved = () => manager.step !== step;

  switch ( adv.type ) {
    case "HitPoints": return fillHitPoints(flow, answer);
    case "Size": return fillSize(flow, answer);
    case "Trait": return fillTrait(flow, adv, answer, moved);
    case "ItemChoice": return fillItemChoice(flow, adv, answer, moved);
    case "ItemGrant": return fillGrantAbility(flow, answer);
    case "AbilityScoreImprovement": return fillAsi(flow, answer);
    case "Subclass": return fillSubclass(flow, adv, answer, moved);
    default:
      // A third-party ItemGrant subclass presenting base-vs-replacement pairs — Tasha's
      // `TCOEReplacementGrant`, injected into every 2014-rules class. Left to itself the flow
      // submits with nothing selected and applies *nothing*, so the native reference silently lost
      // every feature on the advancement (a 2014 Ranger's Favored Enemy, Natural Explorer and
      // Ranger Archetype). Choosing the base is what "the player did not take Tasha's alternative"
      // means, and it is what the driver applies, so the two are comparable again.
      if ( adv.configuration?.replacements && !foundry.utils.isEmpty(adv.configuration.replacements) ) {
        return fillReplacementGrant(flow, adv, moved);
      }
      // Nothing to answer, or a type this harness does not drive yet. Leave it as rendered and
      // let the manager apply whatever the flow defaults to.
      return;
  }
}

/**
 * A replacement grant: tick every item that is not an opt-in alternative.
 *
 * The flow renders one group per base→replacement pair plus the unpaired items. Everything in a pair
 * carries `optional: true` in the configuration, and only the *base* of each pair is also a key of
 * `configuration.replacements` — so "base or unpaired" is the same rule the driver applies.
 */
async function fillReplacementGrant(flow, adv, moved) {
  const withItem = uuid => {
    const parts = String(uuid).split(".");
    if ( parts[3] === "Item" ) return uuid;
    parts.splice(3, 0, "Item");
    return parts.join(".");
  };
  const bases = new Set(Object.keys(foundry.utils.flattenObject(adv.configuration.replacements)).map(withItem));
  const wanted = new Set(Array.from(adv.configuration.items ?? [])
    .map(i => (typeof i === "string") ? { uuid: i } : i)
    .filter(i => i.uuid && (!i.optional || bases.has(withItem(i.uuid))))
    .map(i => withItem(i.uuid)));

  const root = await flowElement(flow);
  if ( moved?.() ) return;
  for ( const input of root.querySelectorAll("input[type=checkbox], input[type=radio]") ) {
    const uuid = withItem(input.value || input.name.split(".").slice(-1)[0]);
    const want = wanted.has(uuid);
    if ( input.checked !== want ) {
      input.checked = want;
      await change(input);
      if ( moved?.() ) return;
    }
  }
}

/**
 * Hit points. `"avg"` ticks Take Average; a number switches to manual entry and types it.
 * The original class's first level takes maximum automatically and renders no control at all.
 */
async function fillHitPoints(flow, answer) {
  const root = await flowElement(flow);
  const average = root.querySelector("[name=useAverage]");
  if ( !average ) return;                                   // first class level — nothing to choose

  if ( (answer ?? "avg") === "avg" ) {
    if ( !average.checked ) { average.checked = true; await change(average); }
    return;
  }
  if ( average.checked ) { average.checked = false; await change(average); }

  const manual = (await flowElement(flow)).querySelector("input[name=value]");
  if ( manual && Number.isFinite(Number(answer)) ) {
    manual.value = String(answer);
    await change(manual);
  }
}

/** Size: a single `<select name="size">`. */
async function fillSize(flow, answer) {
  if ( !answer ) return;
  const select = (await flowElement(flow)).querySelector("[name=size]");
  if ( !select ) return;
  select.value = Array.isArray(answer) ? answer[0] : answer;
  await change(select);
}

/**
 * Trait picks. The native flow takes them **one at a time**: choosing a key from the `added`
 * select applies it and re-renders with the select cleared and a new filled slot. So this loops,
 * re-reading the select each pass, until the advancement's own `value.chosen` holds every
 * requested key (or the pool stops offering them).
 */
async function fillTrait(flow, adv, answer, moved = () => false) {
  const wanted = [...(answer ?? [])];
  if ( !wanted.length ) return;

  for ( const key of wanted ) {
    if ( adv.value.chosen?.has?.(key) || moved() ) break;
    const root = await flowElement(flow);
    if ( !root.querySelector("[name=added]") ) break;        // pool exhausted / quota already full
    const select = await untilFound(
      () => {
        if ( moved() ) return true;
        const el = flow.form?.querySelector("[name=added]");
        return [...(el?.options ?? [])].some(o => o.value === key) ? el : null;
      },
      () => {
        const el = flow.form?.querySelector("[name=added]");
        return `trait key "${key}" is not offered by "${adv.title}" `
          + `(offered: ${[...(el?.options ?? [])].map(o => o.value).filter(Boolean).join(", ") || "nothing"})`;
      }
    );
    if ( moved() ) break;
    select.value = key;
    await change(select);
    await until(() => adv.value.chosen?.has?.(key) || moved(), `trait "${key}" to apply`);
  }
}

/**
 * Feature/spell choices: one `dnd5e-checkbox` per pool entry, named for the entry's uuid.
 * An `ability` select is present when the choice grants spells with a choosable casting ability.
 */
async function fillItemChoice(flow, adv, answer, moved = () => false) {
  const uuids = Array.isArray(answer) ? answer : (answer?.uuids ?? []);
  const ability = answer?.ability ?? null;

  for ( const uuid of uuids ) {
    if ( moved() ) return;
    const root = await flowElement(flow);

    // A configured pool renders a checkbox per entry. A restriction-driven pool (Magic Initiate's
    // "any wizard cantrip") has no entries at all — the flow offers a browse button instead — so
    // fall back to that route when there is no checkbox to tick.
    const box = root.querySelector(`[name="${CSS.escape(uuid)}"]`);
    if ( box ) {
      if ( !box.checked ) { box.checked = true; await change(box); }
      continue;
    }
    if ( root.querySelector("[data-action=browse]") ) {
      await selectViaBrowser(flow, adv, uuid);
      continue;
    }

    // Neither route available: wait a beat in case the pool is merely late, then report.
    await untilFound(
      () => moved() || flow.form?.querySelector(`[name="${CSS.escape(uuid)}"]`)
        || flow.form?.querySelector("[data-action=browse]"),
      () => {
        const offered = [...(flow.form?.querySelectorAll("li.item[data-uuid]") ?? [])].map(li => li.dataset.uuid);
        return `choice "${adv.title}" does not offer ${uuid} `
          + `(offered: ${offered.join(", ") || "nothing, and no browse button"})`;
      }
    );
    if ( moved() ) return;
    await fillItemChoice(flow, adv, { uuids: [uuid] }, moved);
  }

  // Set the casting ability last. Each change here re-applies the advancement and re-renders the
  // flow; doing it after the picks keeps one fewer re-render in flight while the browser modal is
  // being driven, which is where the manager was observed tearing its own step down mid-render.
  if ( ability && !moved() ) {
    const select = (await flowElement(flow)).querySelector("[name=ability]");
    if ( select && (select.value !== ability) ) { select.value = ability; await change(select); }
  }
}

/**
 * Pick one item for a choice through the flow's compendium browser.
 *
 * A restriction-driven pool is populated by the browser, not by the template, so this is the only
 * route to it. As with the ASI feat picker, `selectOne` is stubbed for a single call and the
 * flow's own handler runs for real around it — the stub replaces the user's click inside the
 * modal. Note this bypasses the browser's *filters*, so a scenario can pick something the
 * restriction would have excluded; the restriction itself is therefore not under test here.
 */
async function selectViaBrowser(flow, adv, uuid) {
  await withBrowserPick(uuid, async () => {
    // Each accepted pick re-applies the advancement and re-renders both the flow and the manager
    // around it. Clicking browse into a render that is still in flight has been seen to leave the
    // manager's `_onRender` dereferencing a torn-down flow element, so settle first.
    await flowElement(flow);
    await sleep(400);
    const button = (await flowElement(flow)).querySelector("[data-action=browse]");
    if ( !button ) throw new Error(`"${adv.title}" has no browse button to pick ${uuid} with`);
    button.click();
    await untilFound(
      () => Object.values(adv.value.added?.[flow.level] ?? {}).includes(uuid),
      () => `"${adv.title}" did not accept ${uuid} from the browser`,
      10_000
    );
  });
  await sleep(400);
}

/**
 * Run `fn` with the compendium browser's pickers stubbed to return `uuid`, restoring them
 * afterwards whatever happens. Shared by the ASI feat picker and restriction-driven item choices,
 * which are the two places the native flows can only be answered through the browser modal.
 *
 * Both entry points are stubbed because the flows do not agree on which to use: the ASI screen
 * calls `selectOne` (returning a uuid), while `ItemChoiceFlow` calls `select` (returning a Set,
 * since it may take several picks at once). Stubbing only one leaves the other opening a real
 * modal that nothing ever answers.
 */
async function withBrowserPick(uuid, fn) {
  const browser = dnd5e.applications?.CompendiumBrowser;
  if ( !browser ) throw new Error("CompendiumBrowser is unavailable");
  const originals = { selectOne: browser.selectOne, select: browser.select };
  browser.selectOne = async () => uuid;
  browser.select = async () => new Set([uuid]);
  try {
    return await fn();
  } finally {
    Object.assign(browser, originals);
  }
}

/**
 * Subclass. The flow has no form fields at all — selection happens either through the compendium
 * browser modal or by dropping a subclass onto it, and `_handleForm` is empty. Dropping is the
 * cheaper of the two to drive faithfully: the flow binds a `DragDrop` with `dropSelector: "form"`,
 * so a real `drop` event carrying the usual `{type: "Item", uuid}` payload lands in `_onDrop`,
 * which does its own type validation and applies the advancement. Driving the browser modal
 * instead would be a pile of fragile UI work for no extra fidelity.
 */
async function fillSubclass(flow, adv, answer, moved = () => false) {
  const uuid = Array.isArray(answer) ? answer[0] : (typeof answer === "string" ? answer : answer?.uuid);
  if ( !uuid ) return;
  if ( adv.value?.uuid === uuid ) return;

  const form = await flowElement(flow);
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid }));
  form.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));

  await untilFound(
    () => moved() || (adv.value?.uuid === uuid),
    () => `subclass ${uuid} was not accepted by "${adv.title}" `
      + `(the flow still holds ${adv.value?.uuid ?? "nothing"}) — is the uuid a subclass of this class?`,
    10_000
  );
  // `_onDrop` re-renders after applying; let that settle before the step is advanced.
  await sleep(300);
}

/** An ItemGrant that lets the player choose the casting ability of a granted spell. */
async function fillGrantAbility(flow, answer) {
  const ability = (typeof answer === "string") ? answer : answer?.ability;
  if ( !ability ) return;
  const select = (await flowElement(flow)).querySelector("[name=ability]");
  if ( select ) { select.value = ability; await change(select); }
}

/**
 * Ability score improvement. The inputs are named `abilities.<key>` and hold the *resulting
 * score*, with the pre-ASI score in `data-initial`; the flow derives the point assignment from
 * the difference. The scenario states the assignment (`{ int: 2, con: 1 }`), so each input is set
 * to `initial + assigned`.
 */
async function fillAsi(flow, answer) {
  if ( !answer ) return;
  if ( typeof answer.feat === "string" ) return takeAsiFeat(flow, answer.feat);

  // Under the 2024 rules a *class* ASI opens on a choice between points and a feat, and the ability
  // inputs are not rendered at all until the points side is picked — the flow's
  // `showImprovement = !modernRules || !allowFeat || isASI` (ability-score-improvement-flow.mjs).
  // Ticking `asi-selected` applies `{type: "asi"}` and re-renders with the inputs present. A
  // background increase offers no feat, so the checkbox is absent and this is skipped.
  const mode = (await flowElement(flow)).querySelector("[name=asi-selected]");
  if ( mode && !mode.checked ) {
    mode.checked = true;
    await change(mode);
    await untilFound(
      () => flow.form?.querySelector("input[name^='abilities.']"),
      () => `"${flow.advancement.title}" rendered no ability inputs after selecting the points mode`
    );
  }

  const root = await flowElement(flow);
  const adv = flow.advancement;
  const sourceAbilities = adv.actor?.system?._source?.abilities ?? {};

  for ( const [key, points] of Object.entries(answer) ) {
    const input = root.querySelector(`input[name="abilities.${key}"]`);
    // Silence here is how a whole ASI went missing once: the inputs were behind the mode toggle
    // above, every lookup missed, and the build simply came out two points short.
    if ( !input ) {
      throw new Error(`"${flow.advancement.title}" offers no input for ${key} `
        + `(it shows: ${[...root.querySelectorAll("input[name^='abilities.']")].map(i => i.name).join(", ") || "none"})`);
    }

    // A scenario states the *total* for each ability, fixed part included, so the target is that
    // total on top of the score as it stood **before this advancement touched it**.
    //
    // Not `data-initial`, which the flow renders as `sourceValue + fixed` — and `sourceValue`
    // already carries the fixed bump, because the manager seeds every step before rendering it
    // (`apply(level, {}, {initial: true})`). Adding a stated total to that counts `fixed` twice.
    // Invisible for a 2024 background, whose `fixed` is all zeroes; the 2014 Half-Elf is the first
    // content here that fixes *and* allocates (+2 Charisma, then 2 points at a cap of 1), and it
    // drove Charisma to 17 — one point past what the advancement's own "+" button allows, since
    // `canIncrease` gates on `assignment < cap` and the fixed 2 already exceeds a cap of 1. The
    // form's submit path is looser than its buttons, so nothing stopped it.
    const base = Number(sourceAbilities[key]?.value ?? 0) - Number(adv.value?.assignments?.[key] ?? 0);
    const target = base + Number(points);
    if ( Number(input.value) === target ) continue;
    input.value = String(target);
    await change(input);
  }
}

/**
 * Take a feat for an ASI decision instead of allocating points.
 *
 * The native flow's only route to a feat is `data-action="browse"`, which opens
 * `CompendiumBrowser.selectOne()` — a modal whose whole purpose is to return one uuid. Driving its
 * internals would be a large amount of fragile UI work to arrive at a value the scenario already
 * states, so the browser's `selectOne` is stubbed for exactly one call and the flow's own browse
 * handler runs for real around it: the click, the prerequisite check, the apply, the re-render.
 * The stub stands in for the user's click inside the modal, nothing more, and is always restored.
 */
async function takeAsiFeat(flow, uuid) {
  const adv = flow.advancement;
  if ( adv.value?.type === "feat" ) return;

  await withBrowserPick(uuid, async () => {
    const root = await flowElement(flow);
    const button = root.querySelector("[data-action=browse]");
    if ( !button ) {
      throw new Error(`the ASI screen for "${adv.title}" offers no feat browser `
        + "(does this advancement allow a feat?)");
    }
    button.click();
    await untilFound(
      () => adv.value?.type === "feat",
      () => `feat ${uuid} was not taken for "${adv.title}" — it may fail its own prerequisites `
        + "at this level, which the flow reports by declining silently",
      10_000
    );
  });
  await sleep(300);                                        // let the flow's re-render settle
}

/* -------------------------------------------- */
/*  Driving one manager                          */
/* -------------------------------------------- */

/**
 * Render a manager and walk it to completion, answering each step from the book.
 * @param {AdvancementManager} manager
 * @param {AnswerBook} book          The scenario's answers.
 * @param {Set<string>} [consumed]   Collects the ids an answer was read for.
 */
export async function driveManager(manager, book, consumed) {
  // Opt out of the module's takeover so the *native* wizard runs (see the file header).
  manager._sogromLevelUp = true;
  if ( !manager.steps.length ) return;

  await manager.render({ force: true });
  await until(() => !!manager.element, "the advancement manager to render");

  const trace = [];
  const describe = s => s
    ? `${s.flow?.advancement?.type ?? s.type}"${s.flow?.advancement?.title ?? ""}"@${manager.steps.indexOf(s)}`
    : "<none>";

  for ( let guard = 0; guard < 200; guard++ ) {
    const step = manager.step;
    if ( !step ) break;
    trace.push(describe(step));

    if ( step.flow ) await ensureFlowRendered(manager, step, trace, describe);

    // A manager built with `automaticApplication` — Ember's hand-off is the one here — forwards
    // through automatic steps *asynchronously* after each advance, because the check it makes is
    // `await getAutomaticApplicationValue()`. So `manager.step` read at the top of this loop can be
    // a step it is already leaving, and filling one it has left applies to a clone that no longer
    // exists: Ember's "Path Skills" picks silently went nowhere that way. Re-read before filling and
    // let the next iteration pick up wherever it actually settled.
    if ( manager.step !== step ) continue;

    await fillStep(step, book, consumed, manager);

    const button = manager.element.querySelector("[data-action=next], [data-action=complete]");
    if ( !button ) throw new Error(`no next/complete button on step "${step.flow?.advancement?.title}"`);
    button.click();

    // The manager either moves to another step or closes itself via `#complete`.
    try {
      await until(() => (manager.step !== step) || !manager.rendered,
        `step "${step.flow?.advancement?.title ?? step.type}" to advance`);
    } catch ( err ) {
      throw new Error(`${err.message}\n${describeStuckStep(manager, step)}`);
    }
    if ( !manager.rendered ) break;
  }

  // `#complete` writes to the actor asynchronously after closing; wait for the window to go.
  await until(() => !manager.rendered, "the advancement manager to close");
  await sleep(300);
}

/**
 * Wait until the current step's flow has actually painted, nudging the manager if it hasn't.
 *
 * The manager paints its own frame and then swaps the step's flow into a `<template>` slot; but
 * `#forward` kicks that render off **without awaiting it**, and our own change events trigger
 * flow re-renders that can overlap it (ApplicationV2 drops a render that races another). The
 * result is a manager frame showing an empty placeholder forever. Clicking Next in that state
 * makes the flow submit with `this.form` undefined, which throws inside FormDataExtended and
 * strands the wizard — so the flow is nudged into existence here rather than clicked blind.
 */
async function ensureFlowRendered(manager, step, trace, describe) {
  const flow = step.flow;
  // Be patient before nudging. `AdvancementManager#render` pre-applies the step's advancement
  // (`apply(level, {}, {initial: true})`), so a nudge that overlaps the manager's own in-flight
  // render gives two `apply` calls that both read an empty `value.added` and both grant — which
  // shows up as duplicated items and looks like a creator bug. The first wait is therefore long
  // enough that the manager almost always wins on its own.
  for ( let attempt = 1; attempt <= 3; attempt++ ) {
    try {
      // The manager leaving this step counts as settled: an automatic step never paints a form, so
      // on an `automaticApplication` manager waiting the full timeout for one would stall the walk
      // by twelve seconds per step and then fill a step that is no longer current.
      await until(() => !!flow.form || (manager.step !== step), "flow form",
        attempt === 1 ? 12_000 : 8000);
      return;
    } catch {
      if ( manager.step !== step ) return;                 // it moved on by itself; nothing to do
      // Render the *flow*, not the manager. `AdvancementManager#render` re-runs
      // `advancement.apply(level, {}, {initial: true})` on the way through, so nudging it would
      // grant every ItemGrant a second time and invent differences. Rendering the flow and
      // slotting its element into the manager's placeholder is exactly what the manager's own
      // `_onRender` does, with none of the side effects.
      try {
        await flow.render({ force: true, error: step.error });
        const existing = document.getElementById(flow.element?.id);
        if ( existing && (existing !== flow.element) ) existing.replaceWith(flow.element);
      } catch { /* reported below if it never recovers */ }
    }
  }
  throw new Error(`the form of ${flow.advancement?.type} "${flow.advancement?.title}" never rendered\n`
    + `  trace        : ${trace.join(" -> ")}\n`
    + `  all steps    : ${manager.steps.map(describe).join(", ")}\n`
    + `  flow class   : ${flow.constructor.name}, rendered: ${flow.rendered}\n`
    + `  flow.element : ${flow.element ? `<${flow.element.tagName.toLowerCase()} id="${flow.element.id}">` : "null"}\n`
    + `  manager html : ${manager.element?.querySelector(".step")?.innerHTML?.slice(0, 300)}`);
}

/**
 * Explain why a step refused to advance. The manager swallows advancement errors into
 * `step.error` and simply re-renders the same step, which from the outside looks identical to a
 * click that never landed — so both possibilities are reported.
 */
function describeStuckStep(manager, step) {
  const adv = step.flow?.advancement;
  const buttons = [...(manager.element?.querySelectorAll("nav [data-action]") ?? [])]
    .map(b => `${b.dataset.action}${b.disabled ? " (disabled)" : ""}`);
  const lines = [
    `  advancement : ${adv?.type} "${adv?.title}" (${adv?.id}) at level ${step.flow?.level}`,
    `  step.error  : ${step.error?.message ?? "none"}`,
    `  nav buttons : ${buttons.join(", ") || "none"}`,
    `  steps       : ${manager.steps.length}, still rendered: ${manager.rendered}`
  ];
  // Foundry builds the submit payload from `form.elements`, then looks each name back up with
  // `namedItem()`. A name that does not resolve makes FormDataExtended throw, which is a common
  // way for a step to "not advance" — so report the resolution of every field.
  const form = step.flow?.form ?? step.flow?.element?.querySelector("form") ?? step.flow?.element;
  if ( form ) {
    lines.push(`  form        : <${form.tagName?.toLowerCase()}> `
      + `owner=${form.elements ? `${form.elements.length} elements` : "not a form"}`);
    for ( const el of form.elements ?? [] ) {
      const named = el.name ? form.elements.namedItem(el.name) : "(unnamed)";
      lines.push(`    <${el.tagName.toLowerCase()} name="${el.name}"> `
        + `-> ${named === "(unnamed)" ? named : (named ? named.constructor.name : "NULL — this is the crash")}`);
    }
  }
  return lines.join("\n");
}

/* -------------------------------------------- */
/*  The reference build                          */
/* -------------------------------------------- */

/**
 * Build a character the way a player would without this module: create a blank character, set
 * its base ability scores, then add species, background and class one at a time — each one
 * opening the system's advancement wizard, which we answer from the book.
 * @param {object} scenario
 * @param {object} [options]
 * @param {AnswerBook} options.book        The scenario's answers, shared with the creator build.
 * @param {Set<string>} [options.consumed] Collects the ids an answer was read for.
 * @param {Function} [options.onLevel]     Called `(level, actor)` once the character has finished a
 *   level, for a scenario that wants the state at each one rather than only at the end.
 * @returns {Promise<Actor5e>}
 */
export async function buildNative(scenario, { book, consumed, onLevel } = {}) {
  // An Ember character is not built origin-by-origin: its builder stages everything onto one
  // manager's clone and hands that over. The reference is the system's own wizard driving it.
  if ( scenario.ember ) {
    const { actor, manager } = await stageEmberManager(scenario);
    if ( manager.steps.length ) await driveManager(manager, book, consumed);
    await onLevel?.(1, actor);
    return actor;
  }

  const actor = await Actor.implementation.create({
    name: scenario.name,
    type: "character",
    system: { abilities: abilityUpdate(scenario.abilities) }
  }, { render: false });

  const { AdvancementManager } = dnd5e.applications.advancement;

  // Species → background → class, matching the order the creator stages them in.
  for ( const key of ["species", "background", "class"] ) {
    const uuid = scenario[`${key}Uuid`];
    if ( !uuid ) continue;
    const doc = await fromUuid(uuid);
    if ( !doc ) throw new Error(`${key} not found: ${uuid}`);

    const data = doc.toObject();
    if ( data._stats ) data._stats.compendiumSource = doc.uuid;
    if ( data.type === "class" ) data.system.levels = 1;

    const manager = AdvancementManager.forNewItem(actor, data);
    if ( manager.steps.length ) await driveManager(manager, book, consumed);
    else await actor.createEmbeddedDocuments("Item", [data], { render: false });
  }

  await onLevel?.(1, actor);

  // A scenario above level 1 raises the class the rest of the way in one manager, which is what
  // the sheet's own level selector does — and what the creator's post-creation jump mirrors.
  //
  // `incremental` takes one level at a time instead, which is how a character is actually played:
  // a manager per level, each starting from a committed actor rather than one long-lived clone.
  // The two are genuinely different walks. The ordering `deferredAsi` fixes only goes wrong in the
  // jump; anything that fails to survive a commit only goes wrong in the increments.
  const target = scenario.targetLevel ?? 1;
  if ( target > 1 ) {
    const classItem = actor.items.find(i => i.type === "class");
    if ( !classItem ) throw new Error("cannot level up: the scenario built no class");
    const from = classItem.system?.levels ?? 1;
    const stride = scenario.incremental ? 1 : (target - from);

    for ( let level = from + stride; level <= target; level += stride ) {
      const manager = AdvancementManager.forLevelChange(actor, classItem.id, stride);
      if ( manager.steps.length ) await driveManager(manager, book, consumed);
      else await classItem.update({ "system.levels": level });
      await onLevel?.(level, actor);
    }
  }

  // Multiclassing is adding a *new* class item, not raising the existing one — `forNewItem`
  // again, exactly as dropping a second class on the sheet would. The system knows it is a
  // multiclass because the actor already has a class, and applies the `classRestriction:
  // "secondary"` advancements instead of the primary ones.
  const mc = scenario.multiclass;
  if ( mc?.classUuid ) {
    const doc = await fromUuid(mc.classUuid);
    if ( !doc ) throw new Error(`multiclass not found: ${mc.classUuid}`);
    const data = doc.toObject();
    if ( data._stats ) data._stats.compendiumSource = doc.uuid;
    data.system.levels = mc.levels ?? 1;

    const manager = AdvancementManager.forNewItem(actor, data);
    if ( manager.steps.length ) await driveManager(manager, book, consumed);
    else await actor.createEmbeddedDocuments("Item", [data], { render: false });
  }

  return actor;
}

/** `{str: 15, …}` → the nested shape `Actor.create` wants. */
export function abilityUpdate(abilities = {}) {
  return Object.fromEntries(Object.entries(abilities).map(([key, value]) => [key, { value }]));
}
