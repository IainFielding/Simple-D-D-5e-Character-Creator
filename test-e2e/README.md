# End-to-end equivalence harness

Builds the same character twice in a real Foundry world — once through the **dnd5e system's own
AdvancementManager**, once through the **Simple Character Creator** — and diffs the results.

Tracked in git, but **never shipped** — the release archive in `.github/workflows/main.yml` names
its contents explicitly rather than packaging the repo. Three things stay out of version control:
`config.mjs` (absolute paths to one machine's Foundry install), and the run output (`*.jsonl`,
`*.log`, `*.html`), which quotes item descriptions verbatim and so carries text from the paid content
packs under test.

Copy `config.example.mjs` to `config.mjs` and edit the paths before the setup steps below.

## Layout

| Path | Role |
| --- | --- |
| `config.mjs` | Machine paths, port, world definitions, module lists |
| `lib/server.mjs` | Spawns/stops the Foundry server |
| `lib/session.mjs` | Playwright: launches Chromium, joins the world as Gamemaster |
| `lib/worlds.mjs` | Writes `world.json` manifests |
| `provision.mjs` | One-time world setup: modules, adventure import |
| `run.mjs` | Runs the suite and prints the diff |
| `shell.mjs` | Diagnostics; `--hold` leaves Playwright's browser open, `--serve` opens none |
| `screenshots.mjs` | Recaptures the README's `docs/screenshots/` images from a live world |
| `in-world/*.mjs` | Everything that runs **inside** the world |
| `in-world/answers.mjs` | The answer book: one decision-answering strategy, both adapters |
| `in-world/sweep.mjs` | Generates one scenario per subclass in the world |
| `in-world/shots.mjs` | Opens and drives the real wizard, for `screenshots.mjs` |

## Screenshots

`screenshots.mjs` retakes the README's pictures against a live world, so they can be regenerated
whenever the UI is restyled instead of being recaptured by hand:

```bash
npm run screenshots                        # every base-world shot
node screenshots.mjs --only=review,actor   # just these two
npm run screenshots:ember                  # the Ember hand-off and level-up
```

The character is filled by Quick Build with a fixed seed, so re-running produces the same Wizard
and a single picture can be retaken without the others drifting out of step. `--only` filters what
is *captured*, not what runs: the shots are one continuous walk through the wizard, so every
preceding step's setup still executes. Files land in `docs/screenshots/`, overwriting in place —
check `git diff` before keeping them.

The Ember creation shot renders the hand-off manager staged by `in-world/ember.mjs` rather than one
Ember's own builder produced; see that file's header for why, and what that does not cover.

Playwright is only the boot loader — it launches a browser, logs in, and calls into
`in-world/harness.mjs`. There are no selectors for game UI on the Node side.

The `in-world/` files are served over HTTP from Foundry's own static route
(`/modules/sogrom-dnd5e-character-creator/test-e2e/in-world/…`), because the repo is
junction-linked into `Data/modules`. That means they are ordinary ES modules with real imports —
into each other, and into the module under test.

## Setup

```bash
cp config.example.mjs config.mjs   # then edit FOUNDRY_ROOT, DATA_PATH, MODULE_SOURCE
npm install                 # in test-e2e/
npx playwright install chromium
npm run link-module         # junction Data/modules/sogrom-dnd5e-character-creator -> repo
npm run provision           # create + configure both worlds
```

`provision.mjs` is idempotent — re-run it after changing the module list in `config.mjs`.
`--reset` deletes the world databases and rebuilds; `--force` re-imports adventures.

## Worlds

| World | Modules |
| --- | --- |
| `playwright` | creator + dice-so-nice, dnd-dungeon-masters-guide, dnd-forge-artificer, dnd-heroes-faerun, dnd-monster-manual, dnd-players-handbook, dnd-ravenloft-horrors-within, dnd-tashas-cauldron |
| `playwright-ember` | the same plus `ember`, with the Ember adventure imported |
| `playwright-clean` | the same content **without** the creator — for deciding whether a difference is dnd5e's or ours |

`playwright-clean` exists because several findings come down to timing around writes the system makes
from un-awaited hooks, and "does this still happen with our module absent" is the question that
decides whose bug it is. Only the native adapter runs there — `--probe-native` builds the reference
alone and counts an item at each level. The module stays junction-linked into `Data/modules`, so the
harness's own files are still served: Foundry's static routes come from the filesystem, not from the
world's module list.

Both run dnd5e 5.3.3 on Foundry 14.365, on port 30099 (not 30000).

**Foundry locks its data directory**, so the harness cannot run while the Foundry desktop app is
open. A crashed run leaves a lock that goes stale after ~10s; `startFoundry` retries through that.

## Running

```bash
node run.mjs                          # base world, all scenarios
node run.mjs playwright-ember         # the Ember world
node run.mjs --only human-fighter-sage
node run.mjs --keep                   # leave both built actors in the world to inspect
node run.mjs --list
node run.mjs --ids <compendium-uuid>  # dump an item's advancement ids + options
node run.mjs --find "feat:Actor"      # find items by name (optionally type-prefixed)
node run.mjs --subclasses wizard      # subclasses for a class identifier
node run.mjs --sidekicks              # assert Tasha's sidekicks are not offered as classes
node run.mjs --granted-spells         # assert an always-prepared grant is never duplicated
node run.mjs --sweep                  # every subclass in the world, at level 20 (see below)
node run.mjs --sweep --axis species   # vary the species instead, on a fixed Wizard/Evoker
node run.mjs --sweep --axis background  # vary the background, taking a feat at every ASI
HEADED=1 node run.mjs                 # watch the native wizard being driven
```

## Verified by hand

Checked in Foundry on 2026-08-03, covering everything this harness cannot see because it compares
committed actors and never opens a screen:

| Check | Result |
| --- | --- |
| Ember hand-off claimed on a real Ember manager | works |
| Ember **Cancel** returns to its builder | works — found and fixed the double-prompt below |
| Ember **Complete**: Ember's own diff-and-apply | works, starting equipment included |
| Barbarian 1→20 jump: every ASI screen spends its full budget | works |
| …and Review reports Strength **24** | works — the `deferredAsi` fix |
| Rogue 6 Expertise offers culture/path skills | works — the pool-scoping fix |
| …and Expertise on a skill granted at level 3 (Phantom) gives **2** | works — the trait-ordering fix |
| A half-feat at an ASI level applies its +1 and shows it | works |

### One warning, seen once, not reproduced

*"item configured to be consumed by Recharge with Rage activity on Intimidating Presence could not be
found"* — Path of the Berserker, on a jump to level 14. Neither a repeat by hand nor four harness
runs reproduced it, so it is closed as a one-off. Recorded only so a recurrence does not start from
nothing; what was ruled out:

- Native jump to 14 with this module **absent** — no warning, with and without the sheet rendered
- Both builds, base world and Ember world, sheets rendered — no warning
- The two builds are byte-identical at 14, and that comparison covers consumption targets: the
  normaliser rewrites actor-local ids to identities, so a reference dangling on one side only would
  have surfaced as a difference rather than matching

If it returns, the question that splits the remaining space is *when* it appears — stepping through
the wizard (the shell), on Apply (the commit), on opening the sheet (stored data), or on clicking
Rage (runtime resolution).

It also exposed a real blind spot, now fixed: the harness built with `render: false` and never opened
a sheet, so anything that only complains while *preparing an item for display* was invisible to it.
`--render` and `--console` exist because of this.

## Testing by hand

Some of what this module changes is only visible on a screen — a granted trait rendering locked, an
ASI screen's remaining budget, Ember's Cancel returning to its own builder. The harness compares
committed actors and never opens a screen, so those need a person:

```bash
node shell.mjs playwright-ember --serve
```

Server up, **no browser**, so the single Gamemaster seat is free for you to join at
`http://127.0.0.1:30099`. That matters: these worlds have exactly one user, and `--hold` spends it on
Playwright's own (headless by default) browser, leaving nobody for you to log in as.

Foundry locks its data directory, so a manual session and a sweep cannot run at the same time.
Actors you make by hand are safe — cleanup only ever deletes ones named `[e2e] …`.

## Chasing a difference

Two tools for once the suite reports one:

```bash
node run.mjs --probe <uuid>                              # where a field first appears:
                                                         # _source / toObject / fromCompendium /
                                                         # clone round-trip / after create
node run.mjs --compare-item "<scenario>/<item name>"     # that item's raw source from both builds
```

`--compare-item` is usually the one you want: the suite reports *normalised* differences, which is
right for spotting them and useless for diagnosing them, and normalisation deliberately hides
things (item ids, timestamps) that turn out to matter.

Exit code is 0 only when every scenario is byte-identical after normalisation.

## Writing a scenario

`in-world/scenarios.mjs`. A scenario names the origins, the base ability scores, and answers each
choice **keyed by advancement id** — the one identifier both adapters see. Use
`node run.mjs --ids <uuid>` to get the ids, titles, pools and option keys for an item.

Answer shapes mirror the native form for each advancement type:

| Type | Answer |
| --- | --- |
| `HitPoints` | `"avg"`, `"max"` or a number (omit for a level-1 original class — it takes max automatically) |
| `Size` | `"med"` |
| `Trait` | `["skills:ath", "skills:ins"]` — flat, across every choice pool |
| `ItemChoice` | `["<uuid>"]` or `{ uuids: [...], ability: "int" }` |
| `ItemGrant` (spell ability) | `"int"` |
| `AbilityScoreImprovement` | `{ int: 2, wis: 1 }` — the *total* per ability, fixed part included |

The creator adapter splits a flat Trait answer across the resolver's per-pool requirements
automatically; a pick no pool offers is an error rather than a silently wrong character.

## The answer book

Both adapters answer from one `AnswerBook` (`in-world/answers.mjs`) rather than reading the table
themselves. It resolves each decision **once**, keyed by `advId@level`, and hands the identical value
to whoever asks second — which is the whole guarantee. The two builds walk at different times, off
different clones, in different orders, and none of that can make them disagree about what was chosen.

A scenario with **`generate: true`** has the book invent an answer for anything its table does not
cover: `"avg"` hit points, the first configured size, the first *N* keys of each Trait pool, the
first *N* eligible uuids of an ItemChoice, the whole ASI budget spent in str/dex/con/int/wis/cha
order. Picks are sorted before slicing, so a content update that reorders a pool cannot silently
change them. The six hand-written scenarios do **not** set it and behave exactly as before.

Generation prefers the advancement's own configuration, but some pools only exist against a
character — an expertise Trait is "skills you are already proficient in", a class skill pool excludes
what your background already granted, an invocation's item prerequisites depend on what you hold. For
those the asker passes the list *it* is showing and the memo carries the result across. If the other
side then cannot offer that key, it says so: a hand-written scenario throws (its table has gone stale
against the content), a generated one reports `decision.offered.<type>.<advId>` and carries on,
because the two sides offering different pools is itself the finding.

Two things the book adds to every report:

- **`decision.raised.…`** — a decision one adapter raised and the other never did. The character diff
  shows the *consequences* of a divergence; this shows the divergence. Only answered decisions count:
  the native wizard renders a step for every advancement, automatic ones included, and the driver
  applies those without surfacing anything.
- **A totality assertion.** A decision the book should have answered and could not fails that
  scenario by name, rather than producing an unexplained difference in every scenario that touches
  the same content.

## Unanswered choices

They are now symmetric, and that is a property of the module rather than of the harness.

dnd5e's manager pre-seeds every interactive step before rendering it —
`advancement.apply(level, {}, { initial: true })` — which is how a Trait's automatic grants, an
ItemGrant's non-optional items, an ItemChoice's default casting ability and an ASI's fixed increase
all land whether or not the screen is touched. `LevelUpDriver#ingestFlow` had replaced that single
call with a hand-rolled seed per type and had **none at all for Trait**, so an untouched Trait
granted nothing on our path and everything on the native one. It now makes the same call the manager
does (`#seed`), with hit points the one documented exception.

That removed `mergeTraitGrants`, which existed only to fold the dropped grants back in, and it means
a granted trait now renders locked-and-selected in the level-up wizard from the start — as the native
flow shows it, and as the rules mean it.

## How the two sides are driven

**Native** (`in-world/native.mjs`) renders the real wizard and fills real form controls, because
`AdvancementManager` keeps `#forward`/`#complete` private and each flow applies itself from its
rendered form. Calling `advancement.apply()` directly would mean re-implementing the walk under
test, so step-ordering and mid-walk synthesis bugs would become invisible. `manager._sogromLevelUp`
(the module's own re-entry guard) is set up front so the module's takeover stands down.

**Creator** (`in-world/creator.mjs`) populates a `CreatorState` and calls the real
`assembleActor()`, exercising choice-resolver → creation manager → `LevelUpDriver` → commit. It
does not click through the wizard UI: the UI's only job is to fill that state, and UI bugs are not
what this comparison is about.

**Comparison** (`in-world/normalize.mjs`) re-keys every embedded item by its compendium source
instead of its random `_id`, rewrites id references (including `value.added` object keys and
`flags.dnd5e.advancementOrigin`), drops volatile and identity fields, and diffs both the source
document and the derived state (abilities, HP, proficiencies, scale values, item lists).

## Gotchas found the hard way

- **Do not pass `--noupnp`.** It also skips network-address discovery, leaving `express.addresses`
  null; the join then throws in `getInvitationLinks` and the client dies in `new Game()` with a
  *ReleaseData validation* error that has nothing to do with the real cause. `--noipdiscovery` is
  the flag you want.
- Foundry opens its port before the listen callback finishes, so the harness settles for 3s and
  retries the join once.
- Flows paint their frame before their content resolves. Never click Next until `flow.form` exists
  (submitting without it throws inside `FormDataExtended` and silently strands the wizard), and
  wait for a specific control to appear rather than reading the pool once. `ensureFlowRendered`
  handles the usual case, but a flow can still come up with an empty pool and time out — roughly one
  run in ten strands `human-fighter-sage` on "Versatile" with "offered: nothing". Re-run before
  chasing it. The tell is the scenario timings: a run where it happens is visibly *faster*, because a
  scenario died early.
- Never nudge with `manager.render()`. It re-runs `advancement.apply(level, {}, {initial: true})`,
  and a nudge overlapping the manager's own in-flight render gives two `apply` calls that both read
  an empty `value.added` — producing duplicated grants that look exactly like a creator bug.
- **`fillAsi` must not build its target from `data-initial`.** The flow renders that as
  `sourceValue + fixed`, and `sourceValue` already carries the fixed bump, because the manager seeds
  every step before rendering it. A scenario states the *total* per ability with the fixed part
  included, so adding it to `data-initial` counts `fixed` twice. Harmless for a 2024 background,
  whose `fixed` is all zeroes — and wrong the moment content does both, which the 2014 Half-Elf
  (+2 Charisma, then 2 points at a cap of 1) is the first to do here. It drove Charisma to **17**,
  one point past what the advancement's own "+" button permits: `canIncrease` gates on
  `assignment < cap`, and a fixed 2 already exceeds a cap of 1. The form's submit path is looser
  than its buttons, so nothing stopped it, and the resulting seven-row diff read as a creator bug
  when the reference was the wrong side. The base is now the score *before this advancement touched
  it* — `_source.abilities[key].value - value.assignments[key]`.

## The subclass sweep

Every subclass the world has, built both ways at level 20. Breadth rather than judgement: the
scenarios above each exist to exercise one mechanism and argue for their answers in a comment; this
one just covers the content.

```bash
node run.mjs --sweep                  # 122 subclasses at level 20, one level at a time (hours)
node run.mjs --sweep --level 6        # shallower
node run.mjs --sweep --jump           # the whole span in one manager, compared once at the end
node run.mjs --sweep --shard 1/20     # every 20th, for a smoke test
node run.mjs --sweep --only artificer # substring match on the id, for chasing one finding
node run.mjs --sweep --resume         # skip what is already recorded
node run.mjs --sweep --plan           # list what it would run, and what it skips
```

Origins are the same Human/Sage the scenarios above use, so anything they contribute is already
characterised and will not be mistaken for a subclass finding. The class comes from the subclass's
own `classIdentifier`, and the Subclass advancement's id is read off the class document rather than
written down — an advancement id belongs to the content version that shipped it, so a hard-coded one
goes stale the moment a module updates. That is also why the sweep covers third-party classes it has
never seen.

### What the sweep holds fixed

One axis varies — the subclass. Three others are pinned, and it is worth being explicit about what
that does *not* cover, because "122 characters to level 20" reads like more breadth than it is.

**Species: Human, and Human is the quiet one.** dnd5e's `createLevelChangeSteps` pushes species flows
at every character level (`advancement-manager.mjs`, the `raceItem` line), so the mechanism is on the
path both adapters walk — there is just nothing to walk. Human has every advancement at level 0. Of
the 15 PHB'24 species, eight do not:

| Species | Above level 1 |
| --- | --- |
| Elf — Drow / High / Wood | ItemGrant at **1, 3, 5** — the free spells, each carrying a casting-ability decision |
| Tiefling — Abyssal / Chthonic / Infernal | ItemGrant at **1, 3, 5**, same shape |
| Dragonborn | ItemGrant at **5** (Draconic Flight), plus a level-keyed Breath Weapon ScaleValue |
| Goliath | **5** (Large Form) |

A spell granted by the *species* at level 3, with an ability choice, arriving mid-walk on a class
that knows nothing about it, is the shape that has produced findings here before.

**Background: Sage — and nothing is being missed.** Every 2024 background has all of its
advancements at level 0. A background contributes at creation and never again.

**Feats: never taken.** `generateAsi` always allocates points, so every ASI at 4/8/12/16/19 spends
its budget on ability scores and no general feat is ever selected. That matters more than it looks:
feat pools gate on `prerequisites.items`, which holds the *identifiers* of required items — the same
gate that hid every fighting style at creation (fix **1** above). A general feat gated behind an
origin feat is unreachable twice over here: no feat is ever taken, and the only origin feat a sweep
character holds is Sage's Magic Initiate.

### Tasha's Cauldron of Everything

`dnd-tashas-cauldron` joined the module list on 2026-08-03, taking the sweep from 92 subclasses to
**122**. It is the largest single body of content the sweep can reach, and the only 2014-rules
content in it: thirty subclasses written against the 2014 classes, which the system still ships in
`dnd5e.classes`, so that is what they are built onto. Its own four Artificer subclasses go onto its
own Artificer — see the pairing rule below.

That makes this the first part of the sweep that is not 2024 content at all, which is where its value
lies and also where its findings come from.

**Names collide**, and the sweep already handled that — an id that is taken gains its pack as a
suffix (`sweep:rogue/phantom-dnd-tashas-cauldron-tcoe-character-options`), so the Tasha's Phantom and
the Ravenloft one are both built rather than one silently shadowing the other. What Tasha's forced
was the harder question underneath it: *which class*.

### Which class a subclass is built onto

The sweep used to keep the first class by uuid for each identifier, which is arbitrary — and with
Tasha's installed, wrong in three different ways at once. `classFor` now resolves nearest publisher
first, and `--sweep --plan` prints `[class: <pack>]` on any contested identifier so the result is
checkable by eye rather than inferred:

1. **Same pack.** A `dnd5e.classes24` subclass belongs on the 2024 class sitting beside it, not the
   2014 one in `dnd5e.classes` — module alone cannot tell those apart.
2. **The module's stated class source** (`CLASS_SOURCE`). Tasha's is 2014 content: Path of the Beast
   was written against the 2014 Barbarian, which has different features at different levels from the
   2024 one, so building it onto the Player's Handbook 2024 Barbarian would test a pairing that never
   existed. Its subclasses go onto `dnd5e.classes`.
3. **Same module**, for a module shipping both without needing to be named.
4. **The stated fallback** (`CLASS_FALLBACK`), then first by uuid.

Which resolves the Artificer three ways, deliberately:

| Subclasses | Class | Why |
| --- | --- | --- |
| Tasha's four (Alchemist, Armorer, Artillerist, Battle Smith) | Tasha's Artificer | same pack — tier 1 |
| Forge's five, including Cartographer | Forge Artificer | same module — tier 3 |
| Ravenloft's Reanimator | Forge Artificer | ships no artificer class; tier 4, and **stated** rather than inherited from `dnd-f` sorting before `dnd-t` |

The 2014-vs-2024 split is the point of tier 2, and it is not cosmetic: 38 of the 122 scenarios now
build on `dnd5e.classes` — Tasha's 26 non-Artificer subclasses plus the twelve 2014 SRD ones.

## Granted always-prepared spells: an assertion, not a comparison

```bash
node run.mjs --granted-spells
```

Some things this harness needs to check are not differences between two builds, and forcing them
into that shape makes them weaker. This is the first of those.

A class or subclass `ItemGrant` declaring `configuration.spell.prepared = 2` hands out an
always-prepared spell — Divine Smite at Paladin 2, a Life Domain's domain spells at 3 — and many are
also on the class's own list, so the player could pick the same spell again and end up with two
Items. Only the plain copy counts toward `preparation.value` (`SpellData#countsPrepared` requires
`prepared === 1`), so the duplicate permanently consumed a prepared slot for a spell the character
already always had, and being a plain copy it burned a real spell slot when clicked.

**There is no native reference for this.** dnd5e ships eight advancement types and none of them is
class-spell selection: for an ordinary caster the player drags spells out of a compendium, so the
AdvancementManager never sees the decision and the creator invents that step. Teaching `native.mjs`
to "pick class spells" would mean the harness writing its own reference and then checking we match
it. The bug is a property of one character anyway, so that is what gets asserted:

| Build | Asserts |
| --- | --- |
| Paladin 2 | the granted Divine Smite is the copy kept, `prepared === 2`, exactly one |
| Cleric of Life 3 | a spell picked at creation that the subclass grants at 3 collapses to one |
| Wizard 1 + Magic Initiate | the feat's spell and the class pick stay **two** items |

Plus, on every build: no spell name appears twice, and `preparation.value` matches the number of
`prepared === 1` leveled spells actually on the sheet.

The third case is the one worth having. A missed merge is a duplicate the player can delete; a wrong
merge silently destroys an entitlement, and Magic Initiate's free casting is a genuinely separate
thing from preparing the same spell normally. It is the assertion most likely to catch a later
"simplify the merge".

**Cases are content-driven.** The overlapping spell is discovered by walking the class and subclass
for always-prepared grants and intersecting with the class's own spell list, rather than written
down — an advancement id and a spell uuid both belong to the content version that shipped them. A
case that can no longer find an overlap **fails** rather than passing on an empty test, which is how
the original 2014 Cleric case was caught: the 2014 Life Domain grants *features* and leaves
`spell.preparation` empty, so it has no always-prepared grant to duplicate at all.

### What it found

Two things, on its first real run.

**Spell identity was keyed on the compendium source, and that never matches across packages.** A
world with the Player's Handbook module holds two copies of every spell. A subclass granting
`dnd5e.spells24`'s Bless against a player picking the module's produces two documents whose sources
differ and whose spell is identical, so the reconciler could not see the pair — in the *common*
arrangement, not an edge case. `spellKey` now keys on `system.identifier` (present on 341 of the 352
spells in the 2024 pack) with the source as fallback, and `mergeable` gained a name check to pay for
the looser key. The Paladin case failed before this and passed after, which is the evidence the check
works.

The same trap caught the harness twice more: the overlap search and then the assertion both had to
stop comparing uuids. The assertion counts **by name**, deliberately — matching on the identifier
would be asking the module to mark its own homework, since a broken `spellKey` is one of the things
this exists to catch.

**Reconciliation lives in the shell, so a driver-only path skips it.** `LevelUpShell#_finish` owns
the call because it has to run after the staged spell picks are written, which is shell state. The
product always goes through it; this adapter did not, and so built a Paladin with two Divine Smites.
`creator.mjs`'s `levelUp` now mirrors it. Worth knowing if another non-shell path is ever added.

### What it still does not cover

Prevention. The pool filter that stops the duplicate arising — hiding an already-owned spell from the
Spells step — lives in the step's `context()`, and this adapter fills `CreatorState` directly rather
than driving the UI. That stays covered by unit tests and by hand.

### The sidekicks are not swept, and that is the test

Tasha's also ships five **sidekick** classes — Expert, Warrior, and the three Spellcasters (Healer,
Mage, Prodigy). They are real `class` items with real advancements, and nothing in their data marks
them as anything else, but they are DM-run companions rather than player options. This module's
answer is to keep them out of the class grid entirely, by identifier
(`source-index.mjs`'s `SIDEKICK_IDENTIFIERS`).

So there is nothing for the sweep to do with them — a sidekick has no subclasses, and a character
the creator will not let you build cannot be compared against one it will. The whole test is a
presence check on the index the grid renders from:

```bash
node run.mjs --sidekicks
```

It asserts three things, and needs all three to mean anything: the five sidekicks are **installed**
(an empty class grid would otherwise pass); none of them is offered; and the **Artificer** — same
pack, same publisher, genuinely playable — still is, so the filter is exactly as wide as those five
identifiers and no wider. It drives the real `SourceIndex.load()`, so it covers whichever route that
takes in the world: dnd5e's Compendium Browser fetch, or the direct pack scan it falls back to.

Their ASI schedules differ from each other by design (Expert 4/8/10/12/16/19, Warrior
4/8/12/14/16/19, Spellcaster 4/8/12/16/18) — correct data, not a content bug, and irrelevant here
only because nobody can select them.

### One jump, or one level at a time

By default a sweep uses **one manager per level**, each starting from a committed actor rather than
one long-lived clone — because that is how a character is actually played. `--jump` raises the class
from 1 to its target in a single manager instead, which is what the sheet's own level selector does
and what the creator does when it carries a new character to a target level.

These are genuinely different walks, and each hides what the other exposes. The ordering that
`deferredAsi` fixes — a level-20 capstone eating points a level-4 improvement is entitled to — can
only go wrong in the jump, because in the increments level 4 is committed long before level 20
exists. Conversely anything that has to *survive* a commit is only tested by the increments, because
the jump does not commit until the end.

Neither subsumes the other, so a result is only comparable against a baseline taken the same way —
the archived `sweep-results-*.jsonl` files differ on this, and a row carries a `levels` key if and
only if it came from an incremental run. The default is the increments because an unqualified sweep
should measure the shape a real character takes; reach for `--jump` when the question is
specifically about the creator's target-level hand-off, and expect ~half the wall time.

An incremental run snapshots after every level and compares each, so a failure reports **the level it
starts at** rather than the level it was noticed at:

```
FAIL  Sweep: Artificer 6 — Battle Smith — diverges at level 3 (5 row(s)): source, derived
```

`report.levels.profile` carries the count per level (`L1=0 L2=0 L3=5 L4=5 …`), which distinguishes
one difference persisting from several accumulating. Only the first diverging level's differences are
kept — every later level repeats them plus whatever else has arrived, which is a great deal of output
saying one thing. A level one side reached and the other did not is reported separately as
`levels.missing`, since no field-by-field diff would explain that.

Roughly twice the wall time of a jump run.

**Node drives the loop**, one scenario per round trip, appending each report to
`sweep-results.jsonl` as it lands. A run this long must not lose two hours of results to one stranded
flow, and `--resume` reads that file back to decide what is left. The console gets one line per
scenario; the full difference list goes to the file. Triage by grouping on difference path — one root
cause spans many subclasses.

## Current status

`node run.mjs playwright` runs eight scenarios:

| Scenario | Covers | Start of session | Now |
| --- | --- | --- | --- |
| `human-fighter-sage` | martial level 1: weapon mastery, fighting style, background ASI | 8 | **identical** |
| `human-wizard-sage` | full caster level 1: spellcasting progression, ScaleValues, Int casting | 4 | **identical** |
| `human-wizard-sage-l3` | 1→3 in one manager: hit-point decisions, level-2 trait, subclass + its synthesised features | 6 | **identical** |
| `human-wizard-sage-l4-halffeat` | level-4 ASI answered with a feat, and the half-feat's own increase | 6 | 1 |
| `human-wizard-sage-featspells` | Magic Initiate's spells actually chosen, both routes | 18 | 11 |
| `fighter-multiclass-wizard` | a second class item: secondary advancements, a real first-level HP decision | 18 | **identical** |
| `hill-dwarf-wizard-2014` | a 2014 **species** increase that is entirely fixed (+2 CON / +1 WIS) | — | **identical** |
| `half-elf-wizard-2014` | a 2014 species that fixes *and* allocates (+2 CHA, then 2 points at cap 1) | — | **identical** |

What is left is `featspells` carrying the by-design feat-spells route, and the half-feat scenario's
one `decision.raised`. The four `source.book` rows `human-fighter-sage` used to carry are gone.

Both 2014 scenarios intermittently show one row — `system.details.background` or
`system.details.race`, native `null` against the creator's link. That is the un-awaited `_onCreate`
race documented below, where the **native** side is the unreliable one; it fires on roughly one run
in two and on either field. Not a finding, and not worth re-running for.

The half-feat scenario's single row is a `decision.raised`, not a character difference: it reports
the Actor feat's own `+1 Cha` ASI as raised by the native side only. That is the known asymmetry the
"A forced increase still has to be stated" section below describes — the creator applies a
one-open-ability allocation at ingest without ever asking, so it never raises the decision. Both
characters end up with the +1; the harness reports the structural difference rather than leaving it
to prose.

The level-3 and level-4 scenarios each matched on their first run once the adapters supported
them, which is the useful result: subclass resolution, mid-walk feature synthesis, per-level hit
points, and a half-feat's grant-and-synthesise all agree between the rendered native wizard and
`LevelUpDriver.autoResolve`.

### Fixed (found by this harness, verified by it)

**1. Fighter fighting style was never offered at creation.**
`choice-resolver.mjs` gates each `ItemChoice` pool entry on its item prerequisites and bails
entirely when nothing survives (`if ( !options.length ) return;`). Every PHB fighting style
requires the *Fighting Style* feature — which carries no advancements of its own, so
`levelOneOwners()` skipped it, `collectOwnedIdentifiers()` never saw `fighting-style`, all four
styles were gated out, and the choice vanished. A creator-built Fighter got the Fighting Style
feature and no style. Fixed by recording advancement-less features as owner *leaves*.

**2. A Small-or-Medium species was silently forced to Small.**
dnd5e's `SizeAdvancement.automaticApplicationValue` compares the `sizes` **Set** to a number:

```js
if ( this.configuration.sizes > 1 ) return false;   // never true
return this.configuration.sizes.first() ?? "med";
```

so it reports the first size as automatic even for a real choice. `manager-driver.mjs`
`#ingestFlow` trusted it, applied Small, and never surfaced the decision — the player's pick was
discarded. The native flow escapes this because `forNewItem` leaves `automaticApplication` false.
Fixed by testing `configuration.sizes.size` directly, which is what `isStepSupported` already did
— the claim gate and the applied value had been disagreeing. **This affects level-up too, not just
creation.**

**3. New characters started below maximum hit points.**
dnd5e's `HitPointsAdvancement.apply` writes *current* HP as the hit die plus the Constitution
modifier **as it stands at that instant**. In the creation walk that instant is inside `prepare()`,
where the background's ability increase is only *surfaced* — its assignment happens later, in
`autoResolve()`. So a background that raised Constitution produced a character starting 1 HP
(or 2, for a +2 background) below its own maximum: `hp.max` is derived and self-corrected, the
stored `hp.value` did not. Re-applying the hit-point decisions cannot fix it — reverse and apply
both recompute from the *new* modifier, so the round trip is a no-op — so `actor-assembler.mjs`
now sets current to the prepared maximum once the walk commits.

Only the Wizard scenario caught this, because its background puts a point into Constitution and
the Fighter's does not. Worth remembering when judging how much coverage a scenario buys.

### Remaining differences, by class

Bisected with `--probe` (where a field first appears in an item's data) and `--compare-item`
(the same item's raw source from both builds). **An earlier note here called these one bug — that
was wrong.** They are two unrelated deviations, in opposite directions.

| Difference | Read |
| --- | --- |
| `flags.dnd5e.riders` `{activity:[],effect:[]}` on creator only | **The pack stores this flag** (`--probe` shows it in `_source`, and it survives `toObject()`, `fromCompendium()`, a clone round-trip, and `createEmbeddedDocuments`). So the creator is passing it through faithfully and the *native* side is dropping it — the opposite of what the shape of the diff suggests. It is dropped only on some items (Magic Initiate loses it, Second Wind keeps it), and the ones that lose it are ones the native flow *writes to* during the walk. Empty arrays either way, so nothing behaves differently; worth understanding, not worth fixing blind. |
| `system.source.book` `""` vs `"SRD 5.2"` | **Open.** A promising lead did not survive its own isolation test — see below before picking it up again. |
| Magic Initiate `value.ability` / `value.added`, and the granted spells' `advancementOrigin`, `advancementRoot`, `sourceId` | By design, and now measured. The creator defers spell `ItemChoice`s to its feat-spells step and `applyFeatSpells` creates the spells straight onto the actor, so the advancement records nothing and the spells are not tagged as advancement output. Consequence worth knowing: nothing links those spells back to the feat, so a later "modify choices" or a level-down will not clean them up. |

**4. Magic Initiate's free cast was uncastable** (fixed in `ace355b`).
`applyFeatSpells` re-derived the casting configuration by hand and got most of it right — method,
prepared state, `uses.max`, the long-rest recovery — but the native build's level-1 spell also
carried an activity the creator's did not:

```
system.activities.<id>
  native : { type: "forward", name: "(free casting)",
             consumption: { targets: [{ type: "itemUses", … }] }, … }
  creator: <missing>
```

That activity is *how* the once-per-long-rest free cast is cast. The creator set up the counter
that backs it and never created the activity, so the character had the charge and no button to
spend it with. Fixed by handing the created spell to the system's own `applySpellChanges` when the
feat carries a spell `ItemChoice` to borrow the configuration from; the hand-rolled block remains
only for the advancement-less PHB-module copy. The spell now matches the natively-granted one
exactly.

Exactly the drift this scenario was written to catch: two implementations of one spell
configuration, one of them the system's, kept in step by hand.

### `system.source.book`: still open, and two probes disagree

The difference in built characters is real and reproducible: creator `"SRD 5.2"`, native `""`,
on class-sourced items, order-dependent across scenarios.

`--probe <uuid> --warm` appeared to pin it on `SourceIndex.warmAll()` writing the derived value
into the cached compendium document's `_source`:

```
_source, before warm   ""
prepared               "SRD 5.2"
_source, after warm    "SRD 5.2"
```

**`--probe-warm` does not reproduce that**, and it is the more careful test — it runs each warm
call against a separate untouched document, then all three against another, then the real
`warmAll()` against the granted feature the symptom was first seen on. Every one comes back
`changed: false`, `_source` still `""`.

The two probes disagree on the same measurement, which most likely means they are not reading the
same document *instance*: `--probe` holds one `fromUuid` result and reads `_source` off it, while
`--probe-warm` re-fetches each time. If compendium `fromUuid` does not hand back a single shared
instance, then "the cached document got polluted" is the wrong frame for this entirely, and the
`--probe` reading says something narrower — that *that* instance was mutated, not the cache.

So: do not treat the warm as the culprit. The next step is to establish whether `fromUuid` on a
compendium entry returns a stable instance, because the answer decides which of the two probes is
measuring the thing that actually reaches a built character.

### CLOSED: a multiclass caster gets no spellcasting ability

**Not a creator bug.** The analysis below reasoned from the un-awaited hook to a race inside
`commit()`; the real cause was that this harness read the actor before that un-awaited write landed.
See "`attributes.spellcasting` was never a creator bug" above. The scenario is now 6 differences,
none of them spellcasting. Kept for the mechanism, which is worth knowing:

```
source.actor.system.attributes.spellcasting   native: "int"   creator: ""
derived.spellcasting.dc                       native: 12      creator: 10
```

A creator-built Fighter 1 / Wizard 1 has no spellcasting ability recorded, so its spell save DC
falls back to 10 instead of 12. User-visible and wrong.

Mechanism is the same shape as the `details.background` race below — dnd5e sets the field from an
**un-awaited** hook, `ClassData._onCreate` (`data/item/class.mjs:288`):

```js
if ( !actor.system.attributes?.spellcasting && this.parent.spellcasting?.ability ) {
  await actor.update({ "system.attributes.spellcasting": this.parent.spellcasting.ability });
}
```

while `LevelUpDriver#commit` writes the actor and creates the items concurrently, and the clone's
`attributes.spellcasting` is empty. If the clone's update lands last it overwrites what the hook
just set. Creation-time single-class casters come out right (the level-1 Wizard scenario is
clean); the multiclass leg loses the race.

That reasoning was sound and the conclusion was wrong: `Promise.all` starts the actor update first,
so the hook's write lands after it and survives. The lesson worth keeping is the general one — a
field a system hook sets from an un-awaited update is not readable the instant `commit()` resolves,
so anything comparing actors has to let those writes settle first.

### `system.details.background`: a race in the system, not a creator bug

This appeared in the feat-spells scenario only — null on the native build, set on the creator's —
which is exactly what a race looks like. It is one.

dnd5e links the background from `BackgroundData._onCreate`
(`data/item/background.mjs:103`):

```js
_onCreate(data, options, userId) {
  …
  this.parent.actor.update({"system.details.background": this.parent.id});   // not awaited
}
```

Meanwhile `AdvancementManager#complete` writes the actor and creates the items **concurrently**:

```js
await Promise.all([
  this.actor.update(updates),                              // updates.system.details.background === null
  this.actor.createEmbeddedDocuments("Item", toCreate, …), // triggers the _onCreate above
  …
]);
```

The clone never had the link, so `updates` carries `background: null`. Whether the character ends
up linked depends on which of those two writes lands last. The feat-spells scenario does more work
inside the background's manager — Magic Initiate's synthesised spell steps, driven through the
compendium browser — which is enough to flip the ordering.

The creator is unaffected because it sets `system.details.background` explicitly in
`assembleActor`'s own update *before* the manager runs, rather than relying on the hook. So the
creator is right here and the native reference is the unreliable one. Nothing to fix in the module;
worth knowing that this field cannot be trusted as an oracle, and worth remembering if a user ever
reports an unlinked background on a natively-built character.

The bisect also turned up something the diff could not show, because the normaliser rewrites it:
the creator was staging origin items with the **compendium's own `_id`**, so every Sage-background
character shared one item id and granted features recorded
`advancementOrigin: "phbbgSage0000000.<advId>"` instead of an actor-local id. Fixed in `c1ec61d`
(the system does the same thing itself in `forNewItem`). It did **not** fix `source.book`.

## Levels above 1

A scenario with `targetLevel: N` runs a second leg after the level-1 build, on both sides:

- **Native** — `AdvancementManager.forLevelChange(actor, classId, N - 1)`, driven through the
  rendered wizard exactly as the level-1 leg is.
- **Creator** — the same manager driven by `LevelUpDriver.autoResolve`, answered by
  `in-world/provider.mjs`. The creator's real hand-off (`intercept.mjs#launchLevelUpTo`) passes
  1→N to the interactive `LevelUpShell`, and the shell exists only to fill the provider interface
  `autoResolve` reads — so answering it directly exercises the whole driver with just the UI left
  out. It is the same one-manager, one-commit jump the module performs.

Subclass is the one answer with no form field behind it: the flow is drop-only, so the native
adapter dispatches a real `drop` event carrying `{type: "Item", uuid}` at the flow's form, which
lands in `_onDrop` and applies the advancement. `node run.mjs --subclasses wizard` lists candidates.

Keep hit points on `"avg"` or `"max"`. A rolled die is not reproducible, so a scenario that rolls
can never be an equivalence test.

## Taking a feat at an ASI level

An ASI answer of `{ feat: "<uuid>" }` takes a feat instead of allocating points. This needed
module support: `autoResolve` previously only ever called `setAsi`, so the headless path could
spend an ASI on ability points and nothing else — which also made half-feats unreachable, since
every one of them is a general feat taken at an ASI level. `applyAsiFeat` is now the browser-free
half of `chooseAsiFeat`, and `autoResolve` routes a feat answer to it.

The native side still needs the compendium browser, because `data-action="browse"` →
`CompendiumBrowser.selectOne()` is the flow's only route to a feat. The adapter stubs `selectOne`
for exactly one call and restores it in a `finally`; the flow's own browse handler, prerequisite
check, apply and re-render all run for real around it. The stub stands in for the user's click
inside the modal, nothing more.

**A forced increase still has to be stated.** A half-feat whose increase has one legal target
(Actor's "+1 Charisma" is one point with the other five abilities locked) is applied outright by
the creator — an allocation with nothing to allocate — but the native flow renders the score
un-incremented with a live "+" button (`ability-score-improvement-flow.mjs` sets
`value: sourceValue`, `canIncrease: true`) and assigns nothing until it is clicked. So a scenario
that leaves it unanswered gets +1 from the creator and nothing from the native reference. The
creator is the one following the rules there; state the answer anyway so the scenario tests that
both sides *can* apply it rather than re-reporting a known divergence every run.

### Found by the sweep, fixed

**A class ASI applied nothing on the native side.** The first thing the sweep caught, and the worst:
every subclass would have come out short at levels 4, 8, 12, 16 and 19. Under the 2024 rules a
*class* ASI opens on a choice between points and a feat, and the flow does not render the ability
inputs at all until the points side is picked —
`showImprovement = !modernRules || !allowFeat || isASI` in `ability-score-improvement-flow.mjs`.
`fillAsi` looked for `input[name="abilities.str"]`, found nothing, and `continue`d. The build came out
two points down and the diff blamed the creator for applying an increase the native reference had
simply dropped.

Two reasons the six scenarios never saw it. A *background* increase offers no feat, so
`showImprovement` is true and the inputs are there from the start — which is the only ASI the level-1
scenarios exercise. And `human-wizard-sage-l4-halffeat`, the one scenario that reaches a class ASI,
answers it with a feat and takes the browser path instead.

`fillAsi` now ticks `asi-selected` first, and a missing input throws rather than being skipped. The
silent `continue` was the actual defect; the missing checkbox was just what it hid.

**A subclass's spell grants looked one-sided, and were not.** "Always Prepared Spells",
"Cartographer Spells" and friends reported as `decision.raised` on the native side only. They are all
`spellAbility: ["int"]` — one allowed ability, so nothing to decide, so
`automaticApplicationValue` applies them on both paths without asking anyone. The native wizard still
*renders* a step for an automatic advancement and so still asked the book; the driver applied it
silently. The book now answers a single-ability grant with `null`, the same as it does a ScaleValue or
a grants-only Trait. A false positive, but an expensive-looking one: five per prepared-caster
subclass across a level-20 run.

**Tool proficiency keys disagreed.** The Artificer's "Tool Proficiencies" choice offered
`tool:art:alchemist` natively and `tool:alchemist` from our resolver, so neither side could consume
the other's answer.

`expandToolPool` flattened deliberately: dnd5e's Trait apply pops the last `:` segment to reach
`system.tools.<id>`, so the bare key does grant the proficiency. But applying is not the only thing
the system does with a recorded key. `Trait.actorValues` reports the character's existing tools in
the prefixed form, and `unfulfilledChoices` matches `value.chosen` against pools expanded by
`Trait.mixedChoices`, which is prefixed too. A flattened key matches neither, so the fulfilled choice
never gets spliced off `available` and the pick reads as neither owned nor made — a tool chosen at
creation reappeared as pickable on a later level-up's tool screen.

We were the outlier: our own level-up path already assumed the prefixed form (see
`test/levelup-quota.test.mjs`). `expandToolPool` now keeps the category. Both Artificer subclasses
drop to `riders` alone.

### Third-party advancement types

`isStepSupported` and `#ingestFlow` used to switch on the bare `advancement.type` string, so a type a
module registered itself fell to `default` and was dropped. That is not a cosmetic failure: a
third-party type is usually a *system* type with a different screen bolted on, and its `apply` and
`reverse` are ones the driver already knows how to run.

Tasha's `TCOEReplacementGrant` is exactly that. `insertReplacements` takes a plain `ItemGrant`
already on a 2014 class, marks the replaced item `optional`, appends the alternatives, and changes
the type string. The advancement still grants everything it always did — so a 2014 Ranger silently
lost **Favored Enemy**, **Natural Explorer** and **Ranger Archetype**, for no reason but the name of
its class.

`LevelUpDriver.baseType` now resolves an unknown type to the nearest system type it subclasses,
most specific first (`ItemChoice` extends `ItemGrant`, so order matters). Both the gate and the walk
use it, or the gate would claim a step the walk then dropped.

A replacement grant is *not* driven as a plain grant, though. Its items are alternatives, so seeding
it hands the character both halves of every pair — Favored Enemy *and* Favored Foe. Not choosing
means keeping the base, so that is what applies, and the decision is recorded for a screen to offer
the swap. Three details cost a run each to find:

- **The per-item `optional` flag is the rule, not the replacement map.** One base can map to several
  items — Natural Explorer is swapped for Deft Explorer **and** Canny — while `replacements` records
  only the first, so keying off the map leaks the rest in.
- **The uuids are pre-v10** (`Compendium.<pack>.<id>`, no `.Item.` segment), the same shape the
  Ranger's "Hunter's Prey" pool uses. They need normalising on the way *out* too, since `value.added`
  records whatever it is handed.
- **The native reference was empty here**, because `fillStep` could not drive Tasha's custom flow and
  submitted it with nothing selected. Both sides applying nothing looked like a pass. `native.mjs`
  now drives the replacement flow by the same base-or-unpaired rule, so the comparison is real.

The 2014 Ranger is down to one row: `system.details.race`, which is the un-awaited `_onCreate` race
documented for `system.details.background` below — the native side is the unreliable one.

### Found by the species and feat axes

**Optional class features can now be declined.** The driver seeds them (matching dnd5e's own
pre-render seed) and records an `optionalGrantSteps` decision; the level-up wizard now has a screen
backing it — `steps/optional-grant-step.mjs`. Independent items render as toggles; a replacement
grant's base-and-alternatives render as one-of groups, because its items are alternatives rather than
a list. It never blocks Next: a default is always applied, and the screen exists so a player can say
no, which without it they could not do at all.

**A per-level maximum-HP bonus leaves the *native* build above its own maximum.** Found independently
by both axes — the Dwarf (Dwarven Toughness, +1/level) on the species axis, and every Tough-granting
background (+2/level) on the feat axis — with the gap matching the bonus exactly in all four cases,
at every level from 2 to 20.

The direction is the whole finding, and it is not the one the diff suggests:

```
Dwarf, level 6:   hp.max = 44 (both)    native value = 45    creator value = 44
```

Ours sits *at* maximum; the reference ends above it. This was misdiagnosed twice before `hp.max` was
measured — first as our bug because native was higher, then as a stale clone at seed time, with a fix
whose arithmetic matched by coincidence. Instrumenting showed the per-level bonus was live at seed
time all along. **A difference is not evidence of which side is wrong**; measure the invariant
(`value <= max`) before deciding. Same lesson as `details.background` and the cached spells, learned
again the hard way.

Two generator gaps the feat axis exposed, both now answering `null` rather than failing a scenario:

- **An exhausted pool is not a short one.** An Eberron background that *grants* the one proficiency it
  also offers leaves nothing to pick. Neither side can choose, so both apply nothing and agree.
- **An empty pool.** The 2024 Criminal ships a "Background Proficiencies" choice of 1 over no options
  at all. Recorded as a note so the oddity stays visible.

A pool genuinely *shorter* than its choice is still reported — that is content the generator cannot
satisfy, and silence would hide it.

### The driver now fires `dnd5e.preAdvancementManagerRender`

`AdvancementManager#render` fires this before processing, and content modules use it to **prune steps
a character does not qualify for**. Our wizard replaces that render, so nothing ever fired it and
every such step applied unconditionally.

Tasha's grants a Ranger **Roving** at level 6 only if they took Deft Explorer at level 1, and enforces
it by deleting the advancement in this hook. A Ranger who kept Natural Explorer was handed Roving
anyway. It was invisible until the replacement-grant fix above, because only the first diverging
level is reported and level 3 was already differing.

Two details decide whether firing it works at all:

- **Per step, not once up front.** Listeners read state the walk produces — Tasha's checks whether
  Deft Explorer is in `value.added`, which is empty until level 1 has been processed. One call before
  the walk prunes Roving for everyone, including the characters entitled to it.
- **Re-sync `steps` afterwards.** The hook may *reassign* `manager.steps` rather than splice it
  (Tasha's filters into a new array), and the driver captures its own reference in the constructor.
  Without the re-sync the pruning is invisible to the loop it is meant to shorten.

A listener returning `false` is logged; a listener that throws is caught, leaving the steps it would
have pruned in place — which is the behaviour we had before firing this at all.

Both 2014 Rangers are byte-identical after this.

### Thieves' Cant, and who records a language

**By design, and the creator is the better behaviour.** Three scenarios (every 2014 Rogue) report two
rows:

```
background …9YuEhI3iqUxEfIOk.value.chosen[]   native: languages:exotic:cant   creator: <missing>
class      …3GyyG2fRAwPbKK7n.value.chosen[]   native: <missing>              creator: languages:exotic:cant
```

The 2014 Rogue grants Thieves' Cant; the Acolyte's language choice also *offers* it. The native flow
lets the background spend a pick on a language the class hands over free. The creator's cross-source
dedupe drops that pick and reopens the slot, so a player picks something else and ends up with more
languages. Both characters know the same languages — there is no `derived.traits.languages` row — so
this is bookkeeping, not a character difference.

The harness cannot fill the slot it reopens (the answer book memoises per advancement and will not
answer twice), which is why it shows as a difference rather than as the creator having one language
more. Left as-is deliberately: matching native here would mean wasting a player's pick.

It also caused a **hang**, now fixed. The book answered `cant` on the first pass — before anything
was selected to dedupe against — the resolver stripped it, and the memo put it straight back, forever.
`distribute` now ignores greyed-out options, because filtering the pool the book is *shown* cannot
help once the memo predates the narrowing. `answerChoices` also prints what moved on each pass when
it fails to settle; that found this in one run after two wrong guesses.

### The sweep, run to run

`node report.mjs` groups the results into a ranked HTML/terminal report — a normalised signature per
cause, so one root cause is one row rather than one row per item it touched. `node report.mjs
--expect 122` adds a progress tile and a self-refresh while a run is in flight, and
`node watch-report.mjs` rebuilds the page until the run ends.

**The 92-subclass era**, before Tasha's, at ~40 s a scenario:

| | identical | differing | errored | rows | causes |
| --- | --- | --- | --- | --- | --- |
| First run | 0 | 91 | 1 | 514 | 23 |
| After the fixes below | **91** | 1 | 0 | 5 | 3 |

**With Tasha's**, 122 subclasses one level at a time, ~70 s a scenario, about 2½ hours:

| | identical | differing | errored |
| --- | --- | --- | --- |
| Run 1 — Tasha's added | 75 | 47 | 0 |
| Run 2 — after the creation-subclass and optional-grant fixes | 72 | 47 | 3 |
| Run 3 — after the rest | **109** | 13 | **0** |

Run 2 looks like a regression and is not: the fixes cleared 34 real rows while exposing three
resolver hangs the previous errors had masked, and only the first diverging level is ever reported.
Run 3 was checked scenario-by-scenario against run 2 — **no scenario regressed**, which is what
sanctioned firing `preAdvancementManagerRender` across all 122.

Of run 3's 13: **eight are upstream**, and the other five are decisions taken deliberately — three
2014 Rogues carrying the Thieves' Cant bookkeeping, and two `source.book`/`riders` singletons.

Archived per run: `sweep-results-tcoe-run{1,2,3}.jsonl`, and `sweep-results-{species,background}-l{6,20}.jsonl`
for the axes.

### The other two axes, run to run

| Axis | Level | identical | differing | errored |
| --- | --- | --- | --- | --- |
| Species | 6 | 23 | 1 | 0 |
| Species | 20 | **23** | 1 | 0 |
| Background + feats | 6 | 41 | 13 | 1 |
| Background + feats | 20 | **41** | 14 | **0** |

**Depth changes almost nothing on either.** The species axis finds the same single difference at 6
and at 20; not one background scenario moved between the two. Both axes' differences originate at
level 1 in origin content shape, not in what happens later — so level 6 is the honest smoke test for
them, and level 20 is confirmation rather than discovery.

That is worth knowing in the other direction too: taking **seven** feats instead of two adds no
divergence, so the feat-taking path itself is clean and what fails is the backgrounds' own
advancement shapes.

Two of the original 23 were the harness's own and are fixed (verified by re-running a five-subclass
subset, which came back with no errors and no language rows):

**Unordered collections were compared positionally** — 14/92 language rows and most of the 83
`itemsByType.spell[]` rows. `traits.languages.value` is a `Set` in the schema, serialised to an
array; the two builds insert in different orders, so a character who knew Draconic, Dwarvish and
Thieves' Cant read as three differences against a character who knew exactly the same three. The
same defect turned one missing spell into a row for every spell after it. `diff` now compares
primitive arrays as multisets, so a pure reordering reports nothing and a real gap reports once.

**A pre-v10 uuid was answered verbatim** — the run's only error. The Ranger's "Hunter's Prey" pool
stores `Compendium.<pack>.<id>` with no `.Item.` segment, while the rendered checkboxes use the
modern form, so the generated answer named a control that did not exist. `generateItemChoice`
already resolves each pool entry to check its prerequisites; it now answers with `doc.uuid`.

**Expertise only offered skills the same source granted** — 8/92, every Rogue and Bard, and the
most consequential thing the sweep found.

The Rogue's Expertise is `mode: "expertise"` over a pool of `skills:*`, which dnd5e intersects with
every skill the *character* is proficient in. `proficientSkillKeys` walked only the offering source's
own advancements, so a skill from the species or background was never offered. A Rogue with a Sage
background is proficient in Arcana and may take Expertise in it by the rules; the creator did not
offer it, and the character came out on proficiency 1 where the native build has 2.

Fixed by computing the pool across the whole build, beside the two things `resolveChoices` already
computes that way (`collectTakenTraitKeys`, `collectOwnedIdentifiers`) — Expertise belongs there for
the same reason. The three build-wide values now travel as one `shared` object rather than as
positional arguments. **Creation only**: the level-up path reads the system's own `actorSelected()`
and was always right.

Chasing it also exposed a harness bug worth keeping in mind: `unofferable` recorded on the first
resolver pass, but the fixed-point loop legitimately passes through empty pools on its way to the
answer — before the class's skill choice is answered, Expertise really does offer only what the
background granted. It now records the *settled* pass only. Before that, a transient was being
reported as a finding and the corrected state never surfaced.

All eight Rogue/Bard scenarios now come back with `riders` alone.

**An increase nobody decides was applied too early, and ate the player's points** — 6/92 with a real
ability difference (every Barbarian), 12/92 raising a one-sided decision (Barbarians and Monks).

`prepare()` walks *every* level before any decision is answered. A capstone's fixed increase —
Primal Champion's `+4 Strength`, Body and Mind's `+4 Dexterity/Wisdom` — was applied during that
walk, so by the time the level-4 improvement's points were allocated the score was already 19 and
four of the five placeable points clamped against the maximum and vanished. A Barbarian carried 1→20
finished on **20 Strength where the rules and the system's own wizard give 24**, because the wizard
applies one level at a time.

Fixed with `deferredAsi`: an improvement that raises no decision (a fixed increase, or a budget with
one legal target) is recorded rather than applied, and `#applyDeferredAsi` puts the set back on top
in level order — idempotently, so every ability edit suspends them first (`#withOwnHeadroom`) and
restores them after. `asiState` discounts them, so an ASI screen prices the player's budget against
their own score rather than against a capstone that has not happened yet. The Review screen still
reads the true total, because the increases *are* on the clone between edits.

Worth knowing when reading that code: reversing an ASI is only clean for `type: "asi"`. Reversing a
feat one deletes the granted item, which is why `#reverseSynth` prunes `deferredAsi` rather than
leaving records pointing at advancements that no longer exist.

Both classes then still reported a one-sided `decision.raised.AbilityScoreImprovement` — a ledger
false positive of the same kind as a grants-only Trait: the native wizard renders a step for an
automatic advancement and so asks the book, while the driver applies it without asking. `generateAsi`
now answers `null` when there is no allocation to make. Barbarians and Monks come back with the
`riders` family alone.

**`attributes.spellcasting` was never a creator bug — the harness read too early.** 2/92 (Eldritch
Knight, Arcane Trickster) plus the long-standing `fighter-multiclass-wizard` failure below.

`SubclassData._onCreate` and `ClassData._onCreate` set the field from an `actor.update` that
**subclass.mjs does not await**, so it lands a tick after `commit()` resolves. The native adapter
already waited for exactly this (`await sleep(300)` once its manager closes); the creator adapter
returned immediately, so the comparison was between a settled actor and an unsettled one. The
creator adapter now waits too, and all three come back with the `riders` family alone. The Arcane
Trickster's duplicate Mage Hand went with it — downstream of the missing casting ability.

Worth recording because the fix that suggested itself was wrong. `commit()` writes
`clone.toObject()` wholesale, which looks like it must race the hook, and the note below proposed
writing only changed keys instead. Built and measured, that changed nothing: `Promise.all` starts
the actor update first, so the hook's write always lands after and survives. Reverted, and
`commit()` left as the faithful port of `#complete`. **The multiclass entry below is closed by the
same finding** — that scenario is now 6 differences, all `riders`/`source.book`.

**An empty `riders` flag drowned everything else**, on 91 of 92 subclasses — enough that no scenario
could report identical and the pass/fail column carried no information at all. Measured across the
full run, all 242 rows held nothing on either side.

The mechanism, chased down afterwards: `flags.dnd5e.riders` records which of an item's activities and
effects ride along with an enchantment, and the system maintains it in `preUpdateActivities`
(`data/item/templates/activities.mjs`), which recomputes it on **update** and deletes whatever comes
out empty — the whole flag, or an individual empty list, which is why an item could differ on
`riders.effect` alone. Packs ship items whose flag is already empty. The native manager re-writes
*every* item the actor owns, so it clears them for free; `commit()` skips items that are
byte-identical (the Apply-speed optimisation) and so never gave the hook anything to fire on.

Fixed in `manager-driver.mjs`: an item carrying an empty rider list no longer counts as unchanged, so
it goes through one ordinary update and the system's own hook decides what to remove. Reusing the
rule rather than re-implementing it matters here — the partial `-=effect` case is easy to get wrong.
The cost is one extra write per affected item, once.

**This only reaches builds that level up.** At level 1 every item is *created* and never updated, so
`preUpdateActivities` has nothing to fire on; native's items are clean there purely because it runs
one manager per origin and each re-writes the previous one's items. `normalize.mjs` therefore still
strips empty rider lists, and `node run.mjs --keep-riders` turns that off to show what is underneath
— currently 9 rows, all on the three level-1-only scenarios. Cleaning those would mean stripping the
flag ourselves on creation, which is a rule the system does not have.

**Expertise was applied before the proficiency it upgrades.** Rogue Phantom, 1/92 — `skills.ani` came
out 2 natively and 1 for us.

`TraitAdvancement#apply` writes nothing for an expertise-mode trait unless the character is *already*
proficient (it skips when the current value is 0). Both sides recorded the same picks — level 1
`acr, arc`, level 6 `ani, ath` — so the difference was purely when they were applied. Animal Handling
is not on the Rogue's skill list at all; it comes from *Whispers of the Dead*, the level-3 feature the
Phantom grants, whose Trait choice is any skill.

`autoResolve` drained `traitSteps` in insertion order. Everything `prepare()` found goes in during
the main walk, but a decision a subclass or feat *synthesises* is appended after all of it — so the
level-3 feature's choice sat behind the level-6 Expertise, the upgrade ran while the skill was still
unproficient, and dnd5e silently declined to write it. Traits now drain in level order
(`screenLevel ?? level`, so a feat's own level-0 advancements sort at the level the feat was taken).

**Duplicate items were paired by position, not content.** Sorcerer Shadow Sorcery, and intermittent —
it passed one run and failed the next.

A character can hold two items sharing one compendium source with *different* data: a Shadow Sorcerer
carries two copies of Summon Beast, one enchantment-modified. `buildIdMap` numbers same-identity
duplicates `#1`, `#2` by array order, so whenever the two builds created them in opposite order the
diff paired `#1` against `#2` and reported every field of both as different — when the pair was in
fact identical, just crossed. `normalize.mjs` now breaks the tie on a content digest that ignores
ids, timestamps and flags, so a duplicate always takes the same number as its counterpart.

That fix holds. **Shadow Sorcery's *current* difference is not this bug** — it is the upstream
cached-spell drop above, clean-room confirmed. Do not read a Summon Beast row as this returning
without probing first; assuming the familiar cause is what kept it mis-filed for a week.

Only traits are ordered by level, because they are the type here with an intra-type dependency. Note
the interactive shell has the same latent hazard — it applies picks as the player clicks, so visiting
the level-6 screen before the level-3 one would reproduce it. The screens are presented in level
order, so it takes deliberate back-and-forth; a proper fix would re-evaluate expertise when an
underlying proficiency changes.

### Found by the incremental sweep — a known dnd5e issue, confirmed in a clean room

The first `--incremental` run — an eight-subclass spread — turned up two divergences that the
jump-mode sweep reports as **passing**. That is the mode justifying itself: these are not subtle
edge cases, they are on the path every real character takes.

Both are dnd5e's, and that is not an inference. `playwright-clean` is the same content with this
module **not enabled**, and `--probe-native` builds only the reference in it and counts an item at
each level. Both reproduce there, with nothing of ours in the room:

```bash
node run.mjs playwright-clean --probe-native "sweep:ranger/winter-walker/Hunter's Mark" --level 6
#   L1–L4  2 copies … L5  1 copy      ← the cached copy is dropped at 5
node run.mjs playwright-clean --probe-native "sweep:artificer/alchemist/Tasha's Bubbling Cauldron" --level 18
#   L15–L16  1 copy … L17  0 copies   ← gained at 15, dropped at 17
```

**The native build drops Cast-activity cached spells at a later level.** Both divergences the first
incremental shard found are this one cause, and the Tasha's sweep turned up three more subclasses
with the same signature:

| Subclass | Spell | Level | Copies | Upstream issue |
| --- | --- | --- | --- | --- |
| Ranger Winter Walker | Hunter's Mark (Favored Enemy) | 5 | 2 → 1 | [premium-content#1704](https://github.com/foundryvtt/foundryvtt-premium-content/issues/1704) |
| Artificer Alchemist | Tasha's Bubbling Cauldron | 17 | 1 → 0 | [premium-content#1706](https://github.com/foundryvtt/foundryvtt-premium-content/issues/1706) |
| **Warlock Undead Patron** (Ravenloft) | Mage Armor | 5 | **1 → 0** | [premium-content#1709](https://github.com/foundryvtt/foundryvtt-premium-content/issues/1709) |
| Ranger Hollow Warden (Ravenloft) | Hunter's Mark | 5 | 2 → 1 | clean-room confirmed, not raised — same spell and level as #1704 |
| Artificer Reanimator (Ravenloft) | Raise Dead | 17 | — | signature matches; **not probed** |
| Sorcerer Shadow Sorcery (Ravenloft) | Summon Beast | 7 | **2 → 0** | clean-room confirmed 2026-08-06; not on the 6.0 list |
| Cleric Grave Domain (Ravenloft) | Spare the Dying | 5 | 2 → 1 | clean-room confirmed 2026-08-06; not on the 6.0 list |

The rows that reach **zero** copies are the ones that bite hardest: the character loses the cast
button outright rather than losing a spare. Alchemist and Shadow Sorcery are both in that group.

**The first five are fixed in dnd5e 6.0**, confirmed by the maintainers. Nothing to do here — but
**re-run the sweep after upgrading** rather than assuming, both to confirm they clear and because a
change in this area could move other things. `module.json` declares dnd5e 5.3.3 as its verified
version, so that needs revisiting for a 6.0 world too.

**Grave Domain and Shadow Sorcery are not on that list**, and both are now confirmed as the same
cause — so they are worth raising, or asking whether the 6.0 fix already covers them.

### Two readings that were wrong, and why

Both of these sat in the "probably ours, do not raise" pile for a while on reasoning that does not
survive contact with `--probe-native`. Recorded because the *shape* of the mistake is easy to repeat.

**"All the rows are creator-only, so it is our duplicate-pairing."** That was the argument for Shadow
Sorcery, and it is backwards. All-creator-only is exactly what a drop to **zero** looks like; the
both-sides shape only appears when native keeps one copy. The rule was induced from two examples that
happened to be 2 → 1, then applied to a 2 → 0 case it never covered.

**"The two builds disagree about which feature granted the spell."** That was Grave Domain, read off
`system.sourceItem` and `flags.dnd5e.advancementOrigin` rows. Those are *pairing noise*: comparing
one native copy against two creator copies has to mismatch fields somewhere, and the normaliser had
lined the granted copy up against the cached one. The disagreement was an artefact of the count
difference, not a finding of its own.

The probe settles either question in about a minute, and prints the flags that identify each copy:

```bash
node run.mjs playwright-clean --probe-native "sweep:cleric/grave-domain/Spare the Dying" --level 6
#   L3–L4  2 copies — one advOrigin=… (granted), one cachedFor=… (the Cast-activity copy)
#   L5     1 copy   — the cached one is gone
node run.mjs playwright-clean --probe-native "sweep:sorcerer/shadow-sorcery/Summon Beast" --level 8
#   L6  2 copies … L7  0 copies
```

**Reach for the clean room before reasoning from the diff's shape.** The diff says *what* differs; only
the probe says *which side is wrong*, and this file now has three separate entries — the HP direction,
these two — where the shape argued convincingly for the wrong answer.

The shape of the diff reads as "the creator has a spare copy", and that reading is wrong. Count the
copies on each side either side of the boundary and the direction reverses:

```bash
node run.mjs --compare-item "sweep:ranger/winter-walker/Hunter's Mark" --level 4 --incremental
#   native 2, creator 2          ← both hold it
node run.mjs --compare-item "sweep:ranger/winter-walker/Hunter's Mark" --level 5 --incremental
#   native 1, creator 2          ← native drops it

node run.mjs --compare-item "sweep:artificer/alchemist/Tasha's Bubbling Cauldron" --level 16 --incremental
#   native 1, creator 1
node run.mjs --compare-item "sweep:artificer/alchemist/Tasha's Bubbling Cauldron" --level 17 --incremental
#   native 0, creator 1
```

The copy is *supposed* to be there. When an item carries a Cast activity, dnd5e keeps a local cached
copy of the spell it references (`ActivitiesTemplate`'s create hook, guarded by `!a.cachedSpell`);
it is flagged `cachedFor`, sits at `prepared: 0`, and is what the sheet's cast button drives. Both
builds hold it right up to the level where the native one loses it.

It is not immediate: the Alchemist's copy arrives with its level-15 feature, survives level 16, and
is gone at 17. So something at one particular later level removes it rather than it never settling.

The likely shape is `#complete`'s `toDelete`, which begins as every item on the actor and keeps only
those present on the manager's clone — a cached copy created by that deliberately un-awaited hook
after the clone was taken is not on it. Our `commit()` computes `toDelete` by identical logic, so
what differs is timing; we keep the copy, and keeping it is correct.

**Raised with the dnd5e maintainers and confirmed by them as a known issue** — logged as
[premium-content#1704](https://github.com/foundryvtt/foundryvtt-premium-content/issues/1704) (Winter
Walker) and [#1706](https://github.com/foundryvtt/foundryvtt-premium-content/issues/1706)
(Alchemist). The same maintainers hold both the system and the premium content, and that tracker is
where they want these logged. Nothing to change here. The user-visible consequence upstream is that a character
levelled one level at a time silently loses the cast button for a spell one of its features grants
it.

### Found by the sweep — a known dnd5e issue, fix in progress upstream

**Artificer Battle Smith: native never applies a level-3 spell grant, so the creator's character has
two spells the reference does not** (`Heroism`, `Shield`). 1/92, and the only remaining difference in
the whole sweep.

**Raised with the dnd5e maintainers and confirmed by them as a known issue they are working on** —
logged as [premium-content#1705](https://github.com/foundryvtt/foundryvtt-premium-content/issues/1705). So
this needs nothing here, and the sweep should clear it on a content update — worth re-running it
after one rather than assuming, since a fix in this area could move other things too.

The subclass grants a *Battle Smith Spells* feature at level 3, and that feature carries five
ItemGrants, at levels 3, 5, 9, 13 and 17. On the native build the level-3 one has `value: {}` while
all four later ones are populated; the creator applies all five. It reproduces at `--level 3`, so it
is not an artefact of the long walk — the pattern is that an advancement at level N, on a feature
that *arrives* at level N, is missed by dnd5e's mid-walk step synthesis. The Cartographer's
equivalent grants sit directly on the subclass rather than on a granted feature, which is why they
apply.

Left alone deliberately: matching native here would mean dropping two spells the content says a
level-3 Battle Smith has. Same category as the `riders` flag and the `details.background` race — the
reference is the unreliable one. Confirmed in the clean room as well, so it is dnd5e's and not an
artefact of this module being loaded:

```bash
node run.mjs --compare-item "sweep:artificer/battle-smith/Battle Smith Spells"
node run.mjs playwright-clean --probe-native "sweep:artificer/battle-smith/Heroism" --level 5
#   0 copies at every level — the grant is never applied
```

## Ember

Ember is the one flow where this module does not build the character. Ember's builder assembles
ancestry, culture, path and class itself, stages them onto a single manager's clone and renders it;
`intercept.mjs` claims that manager and runs the level-up wizard over it.

Three scenarios cover it — `ember-sorcerer`, `ember-fighter`, `ember-warlock` — pinned to
`playwright-ember` and answered by the generator. They are a full caster, a martial with no
spellcasting at all, and a warlock's pact progression: exactly the three the implementation notes
flagged as unverified beyond one hand-checked sorcerer. All three come back identical.

```bash
node run.mjs playwright-ember
```

`in-world/ember.mjs` stages the hand-off rather than driving Ember's builder. That builder lives in a
~6 MB bundle with no API whose internals move between releases; a test driving it would break on
every Ember update for reasons unrelated to this module. The hand-off *shape* is twenty mechanical
lines (`createAdvancementManager`) and is what `isEmberCreationManager` fingerprints, so the harness
reproduces that and both adapters are pointed at a genuine Ember-shaped manager. The creator side
asserts the fingerprint rather than assuming it — a staged manager the module would not claim is
testing nothing.

**What this cannot reach**, and needs a person in Foundry: detection against a manager Ember
*actually* built (this stages what we believe Ember stages, so it agrees with itself); Ember's own
completion, where it returns `false` from `preAdvancementManagerComplete` and applies the diff
itself; and Cancel.

Detection and Cancel were checked by hand and both work; Cancel returns cleanly to Ember's builder.

Cancel turned up a bug the harness could never have seen, which is the argument for doing those
passes at all: `abandonEmberCreation` closed the manager *without* `skipConfirmation`, so dnd5e's own
"Stop advancement / Continue" prompt appeared on top of the discard dialog our shell had already
asked — and since the close was not awaited, the release event fired first, leaving that second
prompt orphaned over Ember's already-returned builder, its buttons unable to change anything. Fixed,
unit-pinned in `test/ember-creation.test.mjs`, and re-verified in Foundry.

Two things the Ember work turned up that apply well beyond it:

**A manager built with `automaticApplication` forwards asynchronously.** Ember passes it; nothing
else here does. The check is `await getAutomaticApplicationValue()`, so the manager can leave a step
*while the harness is waiting for that step's flow to paint* — and filling a step it has left applies
to a clone that no longer exists. Ember's "Path Skills" picks silently went nowhere that way, and the
symptom was a fifteen-second timeout with no hint of the cause. `driveManager` now re-reads
`manager.step` before filling, and `ensureFlowRendered` treats the manager moving on as settled
rather than waiting the full timeout for a form an automatic step will never paint.

**Ember replaces the language list.** Its world offers Arcden, Cascal, Imperial and the rest, and
none of `languages:standard:elvish` or its neighbours. The six hand-written scenarios name those
keys literally, so they cannot run there — which is why every scenario now declares a `world` and the
base world is the default. Anything naming specific content is portable only to the world holding it.
