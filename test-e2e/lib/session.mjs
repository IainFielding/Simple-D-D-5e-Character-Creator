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
  static async open({ viewport = { width: 1600, height: 1000 }, deviceScaleFactor = 1 } = {}) {
    const browser = await chromium.launch({
      headless: !HEADED,
      // Foundry leans on WebGL for the canvas; SwiftShader keeps it working headlessly.
      args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"]
    });
    const context = await browser.newContext({ viewport, deviceScaleFactor });
    const page = await context.newPage();
    const session = new Session(browser, page);

    page.on("console", msg => session.consoleLog.push(`[${msg.type()}] ${msg.text()}`));
    // Keep the stack: a bare message rarely identifies which package threw.
    page.on("pageerror", err => session.consoleLog.push(`[pageerror] ${err.message}\n${err.stack ?? ""}`));

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

  /** Load the join page, authenticate as {@link GM_USER}, and wait for the world. */
  async join() {
    await this.page.goto(`${BASE_URL}/join`, { waitUntil: "domcontentloaded" });

    // Foundry auto-creates a passwordless "Gamemaster" on a world that has no GM, so the join
    // form is just: pick the user, submit.
    const select = this.page.locator("select[name=userid]");
    await select.waitFor({ timeout: 30_000 });
    await select.selectOption({ label: GM_USER });
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
