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
      },
      // The spell-facing config, trimmed to the entries the spell steps read. Shapes are the real
      // ones from dnd5e 5.3.3 (`module/config.mjs`) with the i18n keys already resolved, since
      // Foundry pre-localizes these before anything here would see them.
      spellLevels: { 0: "Cantrip", 1: "1st Level", 2: "2nd Level", 3: "3rd Level" },
      spellSchools: {
        abj: { label: "Abjuration" }, con: { label: "Conjuration" }, div: { label: "Divination" },
        enc: { label: "Enchantment" }, evo: { label: "Evocation" }, ill: { label: "Illusion" },
        nec: { label: "Necromancy" }, trs: { label: "Transmutation" }
      },
      // Only `spell` is populated: it is the only set this module filters on.
      validProperties: { spell: new Set(["vocal", "somatic", "material", "concentration", "ritual"]) },
      itemProperties: {
        vocal: { label: "Verbal" }, somatic: { label: "Somatic" }, material: { label: "Material" },
        concentration: { label: "Concentration" }, ritual: { label: "Ritual" }
      },
      // `scalar` marks the types that carry a count; the time ones also appear in timeUnits, which
      // is what routes them through formatTime rather than a flat label.
      activityActivationTypes: {
        action: { label: "Action" }, bonus: { label: "Bonus Action" }, reaction: { label: "Reaction" },
        minute: { label: "Minutes", scalar: true }, hour: { label: "Hours", scalar: true },
        day: { label: "Days", scalar: true }
      },
      timeUnits: {
        minute: { label: "Minute" }, hour: { label: "Hour" }, day: { label: "Day" }
      },
      movementUnits: { ft: { label: "Feet" }, mi: { label: "Miles" }, m: { label: "Meters" } },
      // dnd5e builds this by merging movementUnits' labels with rangeTypes, so it is flat strings.
      distanceUnits: {
        ft: "Feet", mi: "Miles", m: "Meters",
        self: "Self", touch: "Touch", spec: "Special", any: "Any"
      },
      damageTypes: {
        fire: { label: "Fire" }, cold: { label: "Cold" }, radiant: { label: "Radiant" }
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
      // Just enough of the application framework for the two wizard shells to be *imported*.
      // Nothing renders in Node, and nothing here tries to: the shells are `extends
      // HandlebarsApplicationMixin(ApplicationV2)`, which is evaluated at import time, so without
      // these three names a test cannot so much as reference a shell's class.
      //
      // Methods that are pure view-model arithmetic can then be exercised by borrowing them off the
      // prototype with an object standing in for `this` — see test/ember-creation.test.mjs — which
      // keeps them testable without a fake render loop nobody would trust.
      api: {
        ApplicationV2: class ApplicationV2 {
          constructor(options = {}) { this.options = options; }
        },
        HandlebarsApplicationMixin: Base => class HandlebarsApplication extends Base {
          /** Foundry's own default: the class's static PARTS, cloned so a caller can mutate it. */
          _configureRenderParts() { return structuredClone(this.constructor.PARTS ?? {}); }
        },
        DialogV2: { confirm: async () => false }
      },
      ux: { TextEditor: { implementation: { enrichHTML: async html => html } } },
      // The chat cards render a real .hbs file in Foundry. Here the template is never the thing
      // under test, so this echoes back the path and the context it was handed — enough for a test
      // to assert *what* the card was told, without a Handlebars runtime.
      handlebars: { renderTemplate: async (path, context) => JSON.stringify({ path, context }) }
    }
  };

  // dnd5e.documents.Trait: label/icon are identity/stub; wildcard expansion returns empty so
  // the resolver falls back to literal keys (tests that need expansion override this).
  globalThis.dnd5e = {
    // The system's own formatters, which the spell card borrows so a row is worded exactly as the
    // sheet words it. These stand in with the plain English forms.
    utils: {
      formatTime: (value, unit) => {
        const label = CONFIG.DND5E.timeUnits?.[unit]?.label ?? unit;
        return `${value} ${Number(value) === 1 ? label : `${label}s`}`;
      },
      formatLength: (value, unit) => `${value} ${unit}`
    },
    documents: {
      Trait: {
        keyLabel: key => key,
        keyIcon: () => null,
        choices: async () => ({}),
        mixedChoices: async () => new Set()
      }
    }
  };

  // ChatMessage: the summary cards' only Foundry write. `created` collects every message the code
  // under test posted, so a test can assert on the payload without a real chat log.
  globalThis.ChatMessage = class ChatMessage {
    static created = [];
    static async create(data) { this.created.push(data); return data; }
    static getSpeaker({ actor } = {}) { return { actor: actor?.id ?? null, alias: actor?.name ?? null }; }
    static getWhisperRecipients(name) { return name === "GM" ? [{ id: "gm-user" }] : []; }
  };

  // Hooks: enough of Foundry's event bus to exercise the module's own public hooks.
  //
  // `fired` collects every emission as `{hook, payload}`, the same trick `ChatMessage.created`
  // uses, so a test can assert "this flow announced that" without a live page. Registered
  // listeners are honoured too, so the cancellable hooks can actually be vetoed in a test:
  // `Hooks.call` stops at the first listener returning exactly `false` and hands it back, which
  // is the real contract the module relies on.
  const listeners = new Map();
  globalThis.Hooks = {
    fired: [],
    on(hook, fn) {
      if ( !listeners.has(hook) ) listeners.set(hook, []);
      listeners.get(hook).push(fn);
      return listeners.get(hook).length;
    },
    once(hook, fn) { return this.on(hook, fn); },
    off(hook, fn) {
      const list = listeners.get(hook) ?? [];
      const index = list.indexOf(fn);
      if ( index >= 0 ) list.splice(index, 1);
    },
    callAll(hook, ...args) {
      this.fired.push({ hook, payload: args[0] });
      for ( const fn of listeners.get(hook) ?? [] ) fn(...args);
      return true;
    },
    call(hook, ...args) {
      this.fired.push({ hook, payload: args[0] });
      for ( const fn of listeners.get(hook) ?? [] ) {
        if ( fn(...args) === false ) return false;
      }
      return true;
    }
  };
  globalThis.fromUuid = async () => null;
  // The document class the Compendium Browser's `fetch` is handed. Never constructed — it is a
  // token identifying which collection to search — so an empty class is enough.
  globalThis.Item = class Item {};
}

installFoundryShims();
