/**
 * A browser session joined to an active world as the Gamemaster.
 *
 * Playwright's only job in this harness is to *be a client*: launch Chromium, log in, and hand us
 * a page whose JS context has `game`, `CONFIG`, `dnd5e` and the live documents. Every actual test
 * runs inside that context via {@link Session#eval} — there are no selectors for game UI here,
 * because driving Foundry through its own objects is far more stable than through the DOM.
 */

import { chromium } from "playwright";
import { BASE_URL, GM_USER, HEADED, WORLD_READY_TIMEOUT_MS } from "../config.mjs";

export class Session {

  /** @type {import("playwright").Browser} */ browser;
  /** @type {import("playwright").Page} */ page;
  /** Console + pageerror lines from the world, newest last. Surfaced when something fails. */
  consoleLog = [];

  constructor(browser, page) {
    this.browser = browser;
    this.page = page;
  }

  /**
   * Launch a browser, join the active world as {@link GM_USER}, and wait for `game.ready`.
   * @param {object} [options]
   * @param {{width: number, height: number}} [options.viewport]  Client size. The default suits the
   *   equivalence suite, which never looks at the screen; `screenshots.mjs` overrides it.
   * @param {number} [options.deviceScaleFactor]  Pixel ratio. 2 renders at twice the resolution,
   *   which is what makes a captured screenshot legible on a high-DPI display.
   * @returns {Promise<Session>}
   */
  static async open({ viewport = { width: 1600, height: 1000 }, deviceScaleFactor = 1,
    canvas = false } = {}) {
    const browser = await chromium.launch({
      headless: !HEADED,
      args: [
        // Foundry leans on WebGL for the canvas; SwiftShader keeps it working headlessly. Kept even
        // though `core.noCanvas` is set below, because `HEADED=1` and `screenshots.mjs` can turn the
        // canvas back on.
        "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio",
        // Headroom for the creator's warm-up. `warmSources` runs five phases concurrently —
        // `warmAll`, `warmClasses`, `warmChoices`, the equipment scan and the Magic Initiate spell
        // lists — each with eight compendium reads in flight, over every class, species and
        // background in nine content modules. Only `--hooks` reaches it, because it is the only
        // suite that opens the real creator; it repeatedly took the renderer down with
        // `page.evaluate: Target crashed` at exactly that point. A real browser has far more room
        // than a headless renderer's default heap, so this is headroom for the harness rather than
        // a statement about the module.
        "--js-flags=--max-old-space-size=4096",
        // NOTE: `--blink-settings=imagesEnabled=false` was tried here to cut renderer memory (decoded
        // bitmaps live outside the JS heap, which is why the heap flag above did nothing for the
        // hooks crash). It breaks the join screen outright — the form never renders and the session
        // dies with "The join form never appeared" — so it is not an option. Left recorded so the
        // next person does not spend the same hour on it.
        // Chromium's default /dev/shm is small and it falls back to disk noisily under memory
        // pressure; harmless elsewhere, and one less way for the renderer to die.
        "--disable-dev-shm-usage"
      ]
    });
    const context = await browser.newContext({ viewport, deviceScaleFactor });
    const page = await context.newPage();
    const session = new Session(browser, page);

    page.on("console", msg => session.consoleLog.push(`[${msg.type()}] ${msg.text()}`));
    // Keep the stack: a bare message rarely identifies which package threw.
    page.on("pageerror", err => session.consoleLog.push(`[pageerror] ${err.message}\n${err.stack ?? ""}`));

    // Turn Foundry's canvas off before the world loads.
    //
    // Nothing here looks at the board: the suites drive documents, and `screenshots.mjs` captures
    // the creator's own DOM, which covers the screen anyway. Under headless Chromium the canvas is
    // served by SwiftShader — *software* WebGL — and drawing 24 canvas groups plus the FogExtractor's
    // texture-compression worker was enough to lose the GL context outright: four
    // `CONTEXT_LOST_WEBGL` warnings and then `page.evaluate: Target crashed`, which killed the hooks
    // suite during world load, before any of its own code ran.
    //
    // It has to be done *here*, in the browser, not with `game.settings.set` after joining:
    // `core.noCanvas` is registered `scope: "client"`, so it lives in `window.localStorage` and a
    // fresh Playwright context starts empty every run. `addInitScript` runs before page scripts on
    // every navigation, which is early enough for `requiresReload` to be moot. The value is the
    // cleaned JSON Foundry itself writes (`storage.setItem(key, json)`), i.e. the string "true".
    if ( !canvas ) {
      await page.addInitScript(() => {
        try { window.localStorage.setItem("core.noCanvas", "true"); } catch { /* storage blocked */ }
      });
    }

    // Foundry's render pipeline is entirely promise-based, so a failing application render
    // surfaces as an *unhandled rejection*, which never fires `pageerror` — the window simply
    // stays half-drawn. Route those to the console so they land in `consoleLog` too.
    await page.addInitScript(() => {
      addEventListener("unhandledrejection", event => {
        const reason = event.reason;
        console.error(`[unhandledrejection] ${reason?.message ?? reason}\n${reason?.stack ?? ""}`);
      });
    });

    // One retry: the very first join after a cold server start can still land while the server is
    // finishing its own wiring, and a second attempt against the now-settled server just works.
    for ( let attempt = 1; ; attempt++ ) {
      try {
        await session.join();
        return session;
      } catch ( err ) {
        if ( attempt >= 2 ) {
          await browser.close().catch(() => {});
          throw err;
        }
        session.consoleLog.push(`[harness] join attempt ${attempt} failed, retrying: ${err.message}`);
        await page.waitForTimeout(5000);
      }
    }
  }

  /**
   * Load the join page, authenticate as {@link GM_USER}, and wait for the world.
   *
   * Foundry auto-creates a passwordless "Gamemaster" on a world that has no GM, so joining is just:
   * name the user, submit. *How* you name them depends on the world's join-screen theme, and both
   * shapes are live — the classic screen renders a `<select name="userid">` of every user, while the
   * minimal theme (`body.join-theme-minimal`) renders a free-text `<input name="username">` instead.
   * Waiting on the select alone timed out against a minimal-themed world with an error that named
   * only the missing locator, which reads like the world failed to launch when it is up and serving.
   */
  async join() {
    await this.page.goto(`${BASE_URL}/join`, { waitUntil: "domcontentloaded" });

    const select = this.page.locator("select[name=userid]");
    const username = this.page.locator("input[name=username]");
    await Promise.race([
      select.waitFor({ timeout: 30_000 }),
      username.waitFor({ timeout: 30_000 })
    ]).catch(() => {
      throw new Error("The join form never appeared — neither select[name=userid] nor "
        + `input[name=username]. Page: ${this.page.url()}`);
    });

    if ( await select.count() ) await select.selectOption({ label: GM_USER });
    else await username.fill(GM_USER);
    await this.page.locator("button[name=join]").click();

    await this.waitForReady();
  }

  /** Block until the world's `game` object reports ready (canvas draw included). */
  async waitForReady() {
    try {
      await this.page.waitForFunction(() => globalThis.game?.ready === true, null, {
        timeout: WORLD_READY_TIMEOUT_MS,
        polling: 250
      });
    } catch ( err ) {
      // A bare "timeout" tells you nothing about *why* the world never came up, so pull the
      // client's own view of where it got stuck before re-throwing.
      const state = await this.page.evaluate(() => ({
        url: location.href,
        hasGame: typeof globalThis.game,
        ready: globalThis.game?.ready ?? null,
        world: globalThis.game?.world?.id ?? null,
        user: globalThis.game?.user?.name ?? null,
        body: document.body?.innerText?.slice(0, 800) ?? null
      })).catch(e => ({ evaluateFailed: e.message }));
      throw new Error(`World never reached game.ready.\nclient state: ${JSON.stringify(state, null, 2)}`
        + `\n--- console tail ---\n${this.tail(60)}`, { cause: err });
    }
    // `game.ready` fires before the first canvas draw settles; a beat here avoids racing the
    // scene load when a test opens sheets or renders applications.
    await this.page.waitForTimeout(1000);
  }

  /**
   * Run a function inside the world and return its (JSON-serialisable) result.
   * @param {Function} fn      Executed in the page; receives `arg`.
   * @param {*} [arg]          Serialisable argument.
   */
  async eval(fn, arg) {
    return this.page.evaluate(fn, arg);
  }

  /**
   * Load a module file from this harness into the world as an ES module and return its exports
   * bound to `window.__harness`. Lets the in-world suite be written as normal files on disk
   * rather than as one giant stringified function.
   * @param {string} source   ES module source text.
   * @param {string} name     Key under `window.__harness`.
   */
  async injectModule(source, name) {
    await this.page.evaluate(async ({ source, name }) => {
      const blob = new Blob([source], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        const mod = await import(/* webpackIgnore: true */ url);
        (globalThis.__harness ??= {})[name] = mod;
      } finally {
        URL.revokeObjectURL(url);
      }
    }, { source, name });
  }

  /**
   * Reload the page and wait for the world to come back — needed after any change that Foundry
   * only applies on reload (module activation, most notably).
   */
  async reload() {
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.waitForReady();
  }

  /**
   * Return the world to the setup screen (closing its database cleanly) and shut the browser.
   * Always call this before killing the server — see `server.stopFoundry`.
   */
  async close({ shutDownWorld = true } = {}) {
    if ( shutDownWorld ) {
      try {
        await this.page.evaluate(() => globalThis.game?.shutDown?.());
        // shutDown navigates to /setup; give it a moment to complete server-side.
        await this.page.waitForTimeout(3000);
      } catch { /* the page may already be gone; the hard kill covers it */ }
    }
    await this.browser.close().catch(() => {});
  }

  /**
   * The last `n` interesting console lines, for error reporting. Foundry's routine chatter
   * (template compilation, compendium index construction) drowns out anything useful, so it is
   * filtered out first.
   */
  tail(n = 40) {
    const noise = /Constructed index of|Retrieved and compiled template|(Un)?[Rr]egistered callback for|Loaded localization/;
    return this.consoleLog.filter(line => !noise.test(line)).slice(-n).join("\n");
  }
}
