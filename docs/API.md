# Integration API

This module publishes named hooks and a small API object so other packages can react to — and
take part in — character creation and level-up.

Everything on this page is a **supported surface**: it will not change without a major version
bump and a note in the release. Anything not on this page is internal, whatever it looks like
from the outside.

- **Module id:** `sogrom-dnd5e-character-creator`
- **Hook namespace:** `simpleCharacterCreator.`

---

## Quick start

Paste this into the console (F12) and then build a character — every hook logs its payload as it
fires. It is the fastest way to see the whole surface work.

```js
const { HOOKS } = game.modules.get("sogrom-dnd5e-character-creator").api;
Object.values(HOOKS).forEach(h => Hooks.on(h, payload => console.log("HOOK", h, payload)));
```

In a real module, get the API in `setup` or `ready` — it is installed during `init`:

```js
Hooks.once("ready", () => {
  const api = game.modules.get("sogrom-dnd5e-character-creator")?.api;
  if ( !api ) return;   // module not installed or not active — always guard

  Hooks.on(api.HOOKS.characterCreated, ({ actor }) => {
    console.log(`${actor.name} joined the party`);
  });
});
```

---

## Hooks

Two kinds:

- **Cancellable** hooks are named `pre…` and fired with `Hooks.call`. Returning **exactly
  `false`** from a listener aborts the action. Any other return value — including `undefined`,
  `null` or `0` — allows it. This is the same contract the D&D 5e system uses for its own
  `pre…` hooks.
- **Notification** hooks are fired with `Hooks.callAll`. Return values are ignored.

Every hook receives **one object argument**. Destructure the fields you need; more may be added
in future without a breaking change, so never rely on the object's exact key set.

A listener that throws is logged and ignored — a bug in your module will not take down somebody's
character build, and a throwing listener never counts as a veto.

### Lifecycle

| Hook | Payload |
|---|---|
| `simpleCharacterCreator.ready` | `{api, version}` |

Fired once, during Foundry's `ready`, after the module has confirmed it is in a `dnd5e` world and
installed its level-up takeover. Not fired in a non-`dnd5e` world, where the module disables
itself. The API object itself exists earlier, from `init`.

### Creation

| Hook | Cancellable | Payload |
|---|:---:|---|
| `simpleCharacterCreator.preOpenCreator` | **yes** | `{actor, options}` |
| `simpleCharacterCreator.creatorOpened` | no | `{app, state}` |
| `simpleCharacterCreator.creationStepChanged` | no | `{app, state, from, to, step}` |
| `simpleCharacterCreator.preCreateCharacter` | **yes** | `{state, actor}` |
| `simpleCharacterCreator.characterCreated` | no | `{actor, state, targetLevel}` |

- **`preOpenCreator`** — fires after the mode setting and the actor-creation permission have been
  checked, but before the window is constructed. `actor` is the character being resumed, or
  `null` for a fresh build; `options` is the window's ApplicationV2 options. Return `false` to
  refuse the open. Nothing is shown to the player when you do, so post your own notification.
- **`creatorOpened`** — the window is on screen and usable: compendium sources are loaded and the
  first step has been chosen. `state` is the `CreatorState` the whole wizard writes into.
- **`creationStepChanged`** — the player moved between steps. `from`/`to` are indices into the
  step list; `step` is the step object now on screen. Fires on Back as well as Next, and not at
  all when the index does not actually change.
- **`preCreateCharacter`** — **the veto point.** Every choice has been made and validated, and
  nothing has been written to the world yet. Return `false` and the build stops, no actor is
  created, and the Create button re-enables so the player can try again. This is where an
  approval queue, a house-rule validator or a "no evil alignments" check belongs.
- **`characterCreated`** — the character is finished. **Fires exactly once per build**, and does
  so at the moment the character is genuinely complete: for a build that starts above level 1,
  that is after the level-up wizard has applied the climb, not when the level-1 actor appears.
  `targetLevel` is the level actually reached. `state` is the originating `CreatorState`.

> `characterCreated` is *not* governed by the chat-summary setting. The card is the GM's to switch
> off; the hook is a contract with your module and fires either way.

### Level-up

| Hook | Cancellable | Payload |
|---|:---:|---|
| `simpleCharacterCreator.preLevelUpTakeover` | **yes** | `{manager, actor}` |
| `simpleCharacterCreator.levelUpStarted` | no | `{actor, app, state, driver}` |
| `simpleCharacterCreator.levelUpStepChanged` | no | `{app, state, from, to, step}` |
| `simpleCharacterCreator.preLevelUpApply` | **yes** | `{actor, state, summary}` |
| `simpleCharacterCreator.levelUpApplied` | no | `{actor, state, fromLevel, toLevel, summary}` |
| `simpleCharacterCreator.levelUpCancelled` | no | `{actor, state}` |
| `simpleCharacterCreator.emberHandoff` | no | `{manager, actor}` |

- **`preLevelUpTakeover`** — fires when this module is about to claim a level-up and replace the
  system's advancement wizard with its own. `manager` is the dnd5e `AdvancementManager`.
  **Return `false` and we stand down: the native D&D 5e wizard renders instead.** The player is
  never left with nothing, so this is a safe hook to use liberally — it is the right way to carve
  out level-ups your module wants to own, rather than asking users to disable this one.
- **`levelUpStarted`** — the wizard is open. `driver` is the object holding the working clone; the
  real actor is untouched until apply.
- **`levelUpStepChanged`** — as `creationStepChanged`, for the level-up wizard. Note that the
  level-up's step list is rebuilt as choices reveal further choices, so indices are not stable
  across renders.
- **`preLevelUpApply`** — **the veto point.** Fires after the summary has been captured but before
  anything is written. Return `false` and the actor is untouched and the window stays open.
- **`levelUpApplied`** — everything has been written: advancements, spells and any swap.
  `summary` is the same snapshot the chat card renders from. Like `characterCreated`, this fires
  regardless of the chat-summary setting.
- **`levelUpCancelled`** — the player discarded the level-up. The actor was never touched. Useful
  if you opened something on `levelUpStarted` and need to close it again.
- **`emberHandoff`** — fires when the module claims [Ember](https://foundryvtt.com/packages/ember)'s
  advancement manager to ask the level-1 questions Ember hands to the system. Lets you tell an
  Ember-driven build from an ordinary level-up. Not cancellable: declining would strand Ember's
  builder waiting on a manager nobody drives.

> **A creation climb announces `characterCreated`, not `levelUpApplied`.** When the creator hands
> a 1 → N jump to the level-up wizard, the player made *one character* — so that session posts the
> creation hook and card, and no level-up hook fires. An Ember hand-off announces neither: Ember
> owns that moment.

---

## The API object

```js
const api = game.modules.get("sogrom-dnd5e-character-creator")?.api;
```

Installed during `init`, so it is available from any `setup` or `ready` handler. Always guard for
`undefined` — the user may not have the module installed or enabled.

| Member | Signature | Notes |
|---|---|---|
| `version` | `string` | The module version from `module.json`. |
| `HOOKS` | `object` | Frozen `alias → hook name` map. Subscribe via these rather than hard-coding strings. |
| `launchCreator` | `(actor?) => Promise<CreatorShell\|null>` | Opens the creator. Honours the mode setting, the actor-creation permission and `preOpenCreator`. Pass an actor to resume it. Returns `null` if the open was refused. |
| `triggerLevelUp` | `(actor) => Promise<void>` | Opens the level-up wizard, as the sheet button does. |
| `canLevelUp` | `(actor) => boolean` | Whether this actor could be levelled right now — owned, a character, below the level cap. |
| `isCreatorCharacter` | `(actor) => boolean` | Whether this actor was built by the creator. Reads a flag, so it works long after the fact. |
| `exportPdf` | `(actor) => Promise<boolean>` | Produces a character-sheet PDF, matching the layout to the rules edition the character's class was written for. Resolves `false` when no module able to print one is installed. Never throws. |
| `pdfExportAvailable` | `() => boolean` | Whether a sheet could be produced right now. Ask before offering an export control of your own. |
| `settings` | `object` | Read-only config readers — see below. |
| `internal` | `object` | **Unstable.** See below. |

### `api.settings`

Frozen; each entry is a function returning the module's *effective* configuration — the same
values the wizard itself reads, including Ember pinning the mode to `"levelup"` regardless of
what is stored.

| Call | Returns |
|---|---|
| `settings.mode()` | `"creation"` \| `"creation-levelup"` \| `"levelup"` |
| `settings.creationEnabled()` | `boolean` — the module owns character creation |
| `settings.levelUpEnabled()` | `boolean` — the module owns level-up |
| `settings.multiclassMode()` | `"off"` \| `"prereq"` \| `"free"` |
| `settings.storeConfig()` | `{enabled, priceMultiplier, inventory}` |

Read-only by design — a module should not silently rewrite a GM's settings. `game.settings.set`
remains available if you genuinely need it.

### `api.internal`

`{CreatorShell, CreatorState, LevelUpShell, LevelUpState, LevelUpDriver}`

**No stability guarantee.** These are the module's implementation and change between releases
without notice. They are exposed because the project's own end-to-end harness drives them, and
because refusing to expose them only pushes people into importing the files by raw URL — which is
worse for everybody, since then we cannot see who depends on what.

If you need something here to do something reasonable, that is a good argument for promoting it to
a supported entry point. Please [open an issue](https://github.com/IainFielding/Simple-DnD5e-Character-Creator/issues).

---

## Examples

### Gate character creation behind GM approval

```js
Hooks.on("simpleCharacterCreator.preCreateCharacter", ({ state }) => {
  if ( game.user.isGM ) return;                       // GMs build freely
  ui.notifications.warn("Send your build to the GM before creating.");
  myModule.submitForReview(state);
  return false;                                       // nothing is written
});
```

### Enforce a house rule

```js
Hooks.on("simpleCharacterCreator.preCreateCharacter", ({ state }) => {
  const scores = state.resolvedScores();
  if ( Object.values(scores).some(v => v > 17) ) {
    ui.notifications.error("No starting ability score may exceed 17 at this table.");
    return false;
  }
});
```

### Own the level-up for certain actors

```js
Hooks.on("simpleCharacterCreator.preLevelUpTakeover", ({ actor }) => {
  // Let the native D&D 5e wizard handle our specially-flagged NPCs-turned-PCs.
  if ( actor.getFlag("my-module", "useNativeLevelUp") ) return false;
});
```

### Log every finished character

```js
Hooks.on("simpleCharacterCreator.characterCreated", async ({ actor, targetLevel }) => {
  await myModule.roster.add({
    name: actor.name,
    level: targetLevel,
    classes: actor.items.filter(i => i.type === "class").map(c => c.name)
  });
});
```

### Open the creator from your own UI

```js
const api = game.modules.get("sogrom-dnd5e-character-creator")?.api;
if ( api?.settings.creationEnabled() ) await api.launchCreator();
```

---

## Compatibility notes

- The module declares **no manifest conflicts**, and it makes no runtime check for any other
  module. Anything else that replaces the same creation or level-up space simply competes with it:
  nothing coordinates the two and Foundry issues no warning, so which one you end up in depends on
  hook order. If you are writing a module that wants only *some* level-ups, take them through
  `preLevelUpTakeover` rather than replacing the flow — it lets you claim what you need without
  either module standing down wholesale.
- The module re-emits the system's own advancement hooks
  (`dnd5e.preAdvancementManagerRender`, `dnd5e.preAdvancementManagerComplete`,
  `dnd5e.advancementManagerComplete`) at the equivalent points in its own flow, so a module built
  against the native advancement manager keeps working during a creator-driven level-up without
  knowing this module exists.
- With Ember active, the module cedes creation entirely and runs in level-up-only mode.
  `settings.creationEnabled()` returns `false` and `launchCreator()` returns `null`.

## Requesting additions

The surface is deliberately small. If your integration needs something that is not here, please
[open an issue](https://github.com/IainFielding/Simple-DnD5e-Character-Creator/issues) describing
what you are building — a concrete use case is the best argument for a new hook.
