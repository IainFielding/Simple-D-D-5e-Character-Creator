import { beforeEach, describe, expect, it } from "vitest";
import { isForeignWindow, watchForeignWindows, yieldTakeoverTo } from "../scripts/app/takeover.mjs";

/**
 * The fullscreen takeover sits just under Foundry's tooltip layer so that nothing behind it — the
 * actor sheet a level-up was launched from, most of all — can peek through. Anything the player
 * opens from *inside* it is therefore buried too, and has to be lifted back over.
 *
 * `isForeignWindow` is the whole of that decision, and it is the part worth pinning: too narrow and
 * a sheet opened from a Review content link is invisible with no way to reach it, too wide and we
 * ask our own takeover to float above itself. The raising itself is two DOM calls with no branch in
 * them and no meaning of its own.
 */
describe("isForeignWindow", () => {

  /** An application-alike; `classes` are what would be on its root element. */
  const app = ({ document = { id: "x" }, hasFrame = true, classes = [] } = {}) => ({
    document, hasFrame, element: { classList: { contains: c => classes.includes(c) } }
  });

  it("claims a document sheet opened over the takeover", () => {
    // The case the whole module exists for: an item sheet from a Review screen content link.
    expect(isForeignWindow(app())).toBe(true);
  });

  it("skips our own wizard windows", () => {
    // Both shells are ApplicationV2 and carry `sogrom-creator` from DEFAULT_OPTIONS, so without
    // this the takeover would be asked to float above itself.
    expect(isForeignWindow(app({ classes: ["sogrom-creator"] }))).toBe(false);
  });

  it("skips applications that aren't windows over a document", () => {
    // renderApplicationV2 fires for every ApplicationV2 in the world, so this stays narrow:
    // no document means it isn't a sheet, and no frame means it isn't a floating window.
    expect(isForeignWindow(app({ document: null }))).toBe(false);
    expect(isForeignWindow(app({ hasFrame: false }))).toBe(false);
  });

  it("says no to a malformed application rather than throwing", () => {
    // It runs inside a hook that fires for the whole world; it must never be what breaks a render.
    expect(isForeignWindow(null)).toBe(false);
    expect(isForeignWindow({})).toBe(false);
    // An application claimed before it has rendered has no element to read classes off yet.
    expect(isForeignWindow({ document: { id: "x" }, hasFrame: true })).toBe(true);
  });
});

/**
 * The raise itself. Worth testing despite being two DOM calls, because *which* windows get it is
 * the part that has already been wrong once: the first design lowered the takeover instead, which
 * revealed every window behind it rather than the one that had just opened.
 */
describe("raising windows over the takeover", () => {

  /** Whether a fullscreen takeover is currently on screen, for `document.querySelector`. */
  let takeover = true;
  globalThis.document = { querySelector: () => (takeover ? {} : null) };

  /** An application-alike that records the classes put on its root element. */
  function app({ classes = [], document: doc = { id: "x" }, element = true } = {}) {
    const set = new Set(classes);
    return {
      document: doc,
      hasFrame: true,
      element: element ? { classList: { contains: c => set.has(c), add: c => set.add(c) } } : null,
      raised: () => set.has("sogrom-above-takeover")
    };
  }

  const render = application => Hooks.callAll("renderApplicationV2", application);

  watchForeignWindows();
  beforeEach(() => { takeover = true; });

  it("raises a sheet opened while the takeover is up", () => {
    const sheet = app();
    render(sheet);
    expect(sheet.raised()).toBe(true);
  });

  it("leaves a window that was already open where it is", () => {
    // The case that matters: committing a level-up re-renders the character sheet to surface the
    // new level, and that sheet is the very thing the takeover exists to cover. Raising it would
    // throw it over the wizard between Apply and close, on every single level-up.
    const characterSheet = app();
    takeover = false;
    render(characterSheet);          // opened before the wizard, as it always is
    takeover = true;
    render(characterSheet);          // re-rendered mid-commit, underneath the wizard
    expect(characterSheet.raised()).toBe(false);
  });

  it("honours a claim made before the window had an element", () => {
    // The Details step claims Foundry's image picker and only then awaits its render — and a
    // FilePicker carries no document, so it would never qualify on its own.
    const classes = new Set();
    const picker = { document: null, hasFrame: true, element: null };
    yieldTakeoverTo(picker);
    picker.element = { classList: { contains: c => classes.has(c), add: c => classes.add(c) } };
    render(picker);
    expect(classes.has("sogrom-above-takeover")).toBe(true);
  });

  it("never raises our own wizard windows", () => {
    const ours = app({ classes: ["sogrom-creator"] });
    render(ours);
    expect(ours.raised()).toBe(false);
  });

  it("does nothing in windowed mode, where stacking already works", () => {
    takeover = false;
    const sheet = app();
    render(sheet);
    expect(sheet.raised()).toBe(false);
  });
});
