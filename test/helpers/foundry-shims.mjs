/**
 * Minimal Foundry / dnd5e globals for running the module's pure logic under Node.
 *
 * The source modules assume a live Foundry page (globals like `game`, `CONFIG`, `Roll`,
 * `foundry`, `dnd5e`, `fromUuid`). None of the pure logic *needs* a real Foundry — it only
 * reaches these globals for i18n text, settings, config lookups, and UUID resolution — so we
 * install just-enough stand-ins here. Vitest loads this via `setupFiles`, before any test's
 * imports, so importing the source doesn't throw on a missing global.
 *
 * Individual tests override the pieces they exercise (e.g. `game.settings.get`, `fromUuid`).
 * Everything is attached to `globalThis` so ES-module top-level references resolve.
 */

import { DEFAULTS } from "../../scripts/config.mjs";

const ABILITY_LABELS = {
  str: "Strength", dex: "Dexterity", con: "Constitution",
  int: "Intelligence", wis: "Wisdom", cha: "Charisma"
};

const abilities = Object.fromEntries(Object.entries(ABILITY_LABELS).map(
  ([key, label]) => [key, { label, abbreviation: key }]
));

/** Reset every shimmed global to a clean baseline. Call from `beforeEach` if a test mutated one. */
export function installFoundryShims() {
  globalThis.game = {
    // The world settings the config helpers read; default to the module defaults.
    settings: {
      _values: { ...DEFAULTS },
      get(_module, key) { return this._values[key]; },
      set(_module, key, value) { this._values[key] = value; }
    },
    // i18n: echo the key back (with interpolation data appended) so text assertions stay stable.
    i18n: {
      lang: "en",
      localize: key => key,
      format: (key, data) => `${key}:${JSON.stringify(data ?? {})}`,
      getListFormatter: ({ type = "conjunction" } = {}) => new Intl.ListFormat("en", { type })
    },
    packs: [],
    modules: { get: () => null },
    user: {},
    dice3d: null
  };

  globalThis.CONFIG = {
    DND5E: {
      abilities,
      actorSizes: {
        tiny: { label: "Tiny" }, sm: { label: "Small" }, med: { label: "Medium" },
        lg: { label: "Large" }, huge: { label: "Huge" }, grg: { label: "Gargantuan" }
      }
    }
  };

  // Roll: validate accepts anything non-empty; evaluate yields a fixed total (rolling is
  // never asserted here, only that the pool has six values in it).
  globalThis.Roll = class Roll {
    constructor(formula) { this.formula = formula; this.total = 10; }
    static validate(formula) { return typeof formula === "string" && formula.trim().length > 0; }
    async evaluate() { return this; }
  };

  globalThis.foundry = {
    utils: {
      randomID: () => Math.random().toString(36).slice(2, 18),
      deepClone: v => structuredClone(v),
      duplicate: v => structuredClone(v),
      getProperty: (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj),
      setProperty(obj, path, value) {
        const keys = path.split(".");
        const last = keys.pop();
        let cur = obj;
        for ( const k of keys ) cur = (cur[k] ??= {});
        cur[last] = value;
      },
      diffObject: (a, b) => structuredClone(b),
      // Flatten nested objects to dotted keys, as Foundry does. The replacement-grant grouping
      // reads `configuration.replacements` through this; real content stores it flat, but the
      // source calls flattenObject because a uuid key can contain dots of its own.
      flattenObject(obj, _d = 0) {
        const out = {};
        for ( const [key, value] of Object.entries(obj ?? {}) ) {
          if ( value && (typeof value === "object") && !Array.isArray(value) ) {
            for ( const [k, v] of Object.entries(this.flattenObject(value, _d + 1)) ) out[`${key}.${k}`] = v;
          } else out[key] = value;
        }
        return out;
      },
      isEmpty: obj => !obj || (Object.keys(obj).length === 0)
    },
    applications: {
      ux: { TextEditor: { implementation: { enrichHTML: async html => html } } }
    }
  };

  // dnd5e.documents.Trait: label/icon are identity/stub; wildcard expansion returns empty so
  // the resolver falls back to literal keys (tests that need expansion override this).
  globalThis.dnd5e = {
    documents: {
      Trait: {
        keyLabel: key => key,
        keyIcon: () => null,
        choices: async () => ({}),
        mixedChoices: async () => new Set()
      }
    }
  };

  globalThis.Hooks = { on: () => 1, off: () => {}, once: () => {} };
  globalThis.fromUuid = async () => null;
  // The document class the Compendium Browser's `fetch` is handed. Never constructed — it is a
  // token identifying which collection to search — so an empty class is enough.
  globalThis.Item = class Item {};
}

installFoundryShims();
