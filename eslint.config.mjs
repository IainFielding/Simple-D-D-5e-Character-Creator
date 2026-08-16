import js from "@eslint/js";
import globals from "globals";

/**
 * Flat ESLint config for the Character Creator.
 *
 * The module is browser ESM running inside Foundry VTT, so on top of the standard browser
 * globals we declare the Foundry / dnd5e globals the code reaches for (`game`, `CONFIG`,
 * `foundry`, `dnd5e`, `Roll`, `Hooks`, `fromUuid`, …). Tests additionally see Vitest's
 * globals and Node built-ins.
 */

const foundryGlobals = {
  game: "readonly",
  CONFIG: "readonly",
  CONST: "readonly",
  foundry: "readonly",
  dnd5e: "readonly",
  Roll: "readonly",
  Hooks: "readonly",
  fromUuid: "readonly",
  fromUuidSync: "readonly",
  ui: "readonly",
  canvas: "readonly",
  Actor: "readonly",
  Item: "readonly",
  Dialog: "readonly",
  Application: "readonly",
  Handlebars: "readonly",
  FilePicker: "readonly",
  ChatMessage: "readonly"
};

export default [
  // `**/` matters: `test-e2e/` carries its own node_modules (Playwright), and a root-anchored
  // pattern would leave every dependency in it to be linted.
  { ignores: ["**/node_modules/**"] },
  js.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...foundryGlobals }
    },
    rules: {
      // Unused args are common in Foundry hook/callback signatures; ignore leading-underscore
      // names and trailing unused args rather than forcing churn on every handler.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", args: "after-used" }],
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },
  {
    files: ["test/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...foundryGlobals }
    }
  },
  // The end-to-end harness is two programs in one directory, and they do not share an environment:
  //
  //  - the driver (`run.mjs`, `lib/`, `provision.mjs`, …) is Node — it spawns Foundry and steers
  //    Playwright;
  //  - `in-world/` is served over HTTP into Foundry's own page and runs in the *browser*, with
  //    every Foundry global in scope, importing the module under test directly.
  //
  // The driver gets the browser and Foundry globals as well, and that is not laziness. It hands
  // closures to Playwright — `session.eval(() => game.world.id)`, `page.addInitScript(...)` — whose
  // bodies are serialised and executed *in the page*. ESLint sees an ordinary arrow function in a
  // Node file and cannot know it will be evaluated somewhere else entirely, so those globals have
  // to be declared for the file that carries them. The cost is that a genuine typo in Node-side
  // code could name a Foundry global and go unflagged; the alternative was ~25 inline disables.
  {
    files: ["test-e2e/**/*.mjs"],
    ignores: ["test-e2e/in-world/**"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...foundryGlobals }
    }
  },
  {
    files: ["test-e2e/in-world/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...foundryGlobals }
    }
  }
];
