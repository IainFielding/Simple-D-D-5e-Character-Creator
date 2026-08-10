/**
 * Scenarios: one decision script per character, consumed by *both* build adapters.
 *
 * A scenario names the origins and the base ability scores, then answers every choice those
 * origins raise. Answers are keyed by **advancement id** — the id in the compendium item's
 * `system.advancement` array — because that is the one identifier both adapters see: the native
 * wizard reads it off `manager.step.flow.advancement.id`, and the creator's choice resolver
 * stamps it on every requirement as `advId`.
 *
 * Answer shapes, by advancement type:
 *   HitPoints                 "avg" | "max" | <number>   (omit for a level-1 original class)
 *   Size                      "sm" | "med" | …
 *   Trait                     ["skills:ath", "skills:ins"]   — flat, across every choice pool
 *   ItemChoice                ["<uuid>", …]  or  { uuids: [...], ability: "int" }
 *   ItemGrant (spell ability) "int"
 *   AbilityScoreImprovement   { int: 2, con: 1 }   — the *total* per ability, fixed part included
 *
 * Finding the ids: `node run.mjs <world> --ids <uuid>` prints an item's advancements with their
 * ids, titles and options, which is how these tables are written and kept in step with content
 * updates.
 *
 * Every scenario here states all of its own answers. A scenario may instead set `generate: true` and
 * have the {@link AnswerBook} invent whatever its table leaves out — that is how the subclass sweep
 * (`sweep.mjs`) covers ninety-odd characters without ninety-odd tables. These six deliberately do
 * not: each exists to exercise one mechanism, its answers are argued for below, and a generated pick
 * would quietly change what is being tested. Their difference counts are recorded in the README and
 * are only comparable run to run because the answers are fixed.
 */

/** PHB'24 compendium uuids used below, named so the scenarios stay readable. */
export const UUID = {
  fighter: "Compendium.dnd5e.classes24.Item.phbftrFighter000",
  wizard: "Compendium.dnd5e.classes24.Item.phbwzdWizard0000",
  evoker: "Compendium.dnd5e.classes24.Item.phbwzdEvoker0000",
  // A half-feat, and the data shape that makes them awkward: a single-stat increase modelled as
  // 1 point with every other ability locked, rather than as a `fixed` bonus.
  actor: "Compendium.dnd-players-handbook.feats.Item.phbftActor000000",
  // Magic Initiate (Wizard) picks, for the feat-spells scenario.
  magicInitiate: "Compendium.dnd5e.feats24.Item.phbftMagicInitia",
  fireBolt: "Compendium.dnd5e.spells24.Item.phbsplFireBolt00",
  prestidigitation: "Compendium.dnd5e.spells24.Item.phbsplPrestidigi",
  magicMissile: "Compendium.dnd5e.spells24.Item.phbsplMagicMissi",
  human: "Compendium.dnd5e.origins24.Item.phbspHuman000000",
  sage: "Compendium.dnd5e.origins24.Item.phbbgSage0000000",
  // Human "Versatile" origin-feat options.
  alert: "Compendium.dnd5e.feats24.Item.phbftAlert000000",
  savageAttacker: "Compendium.dnd5e.feats24.Item.phbftSavageAttac",
  // Fighter fighting styles.
  archery: "Compendium.dnd5e.feats24.Item.phbfstArchery000",
  defense: "Compendium.dnd5e.feats24.Item.phbfstDefense000"
};

/**
 * 2014 SRD uuids, for the species-ability-increase scenarios at the end of this file.
 *
 * The system still ships the 2014 origins beside the 2014 classes, and they are the only content
 * that puts an ability increase on the **species** — under the 2024 rules it sits on the background
 * instead. Both are built with the 2014 Wizard and Acolyte, so the edition is consistent: pairing a
 * 2014 species with a 2024 class is the mixed-edition character the creator's scoping exists to
 * prevent, and its disagreements would be about the pairing rather than about the increase.
 *
 * The 2014 Wizard rather than the Fighter because it chooses its Arcane Tradition at level 2, so a
 * level-1 build raises no subclass decision — the fewest moving parts around the thing under test.
 */
export const SRD2014 = {
  wizard: "Compendium.dnd5e.classes.Item.wZK2Q0rXB0AQo8h3",
  acolyte: "Compendium.dnd5e.backgrounds.Item.IgJkSnLiLJOWH7eK",
  hillDwarf: "Compendium.dnd5e.races.Item.UQiRQUTBcsz8gZU1",
  halfElf: "Compendium.dnd5e.races.Item.Hye5IZwPOSwV0qRR"
};

/**
 * The 2014 Acolyte + Wizard answers, shared by both species scenarios so the species is the only
 * variable between them. The Acolyte grants Insight and Religion outright and has **no ability
 * increase** — which is the whole point of the pairing.
 *
 * Celestial is an *exotic* language in the 2014 list, not a standard one; both picks are also kept
 * clear of anything either species grants (Dwarvish for the dwarf, Elvish for the half-elf), since
 * the creator's cross-source dedupe would reopen a slot the answer book will not fill twice.
 */
const ACOLYTE_WIZARD_2014 = {
  "9YuEhI3iqUxEfIOk": ["languages:exotic:celestial",          // Acolyte: choose 2 languages
    "languages:standard:draconic"],
  "6blzmKC4EON0KM2e": ["skills:arc", "skills:inv"]            // Wizard: choose 2 skills
};

/**
 * The Human + Sage origin answers, shared by the scenarios that pair them with different classes
 * so a class swap is the only variable between two runs.
 *
 * Sage grants Magic Initiate, whose two spell `ItemChoice`s the creator deliberately defers to its
 * feat-spells step; leaving them unanswered here is why both scenarios show the same two known
 * `value.ability` differences.
 */
const HUMAN_SAGE = {
  dLxv96vt2B2KOEe2: "med",                                   // Human size: Small or Medium
  KB8IQLwyuL6SOFnv: [UUID.alert],                            // Human Versatile: an origin feat
  "3O61L5uTy5jRCqJb": { int: 2, con: 1 },                    // Sage ability increase (str/dex/cha locked)
  pLGiyOjTP7nwuwTl: ["languages:standard:elvish",            // Sage: choose 2 languages
    "languages:standard:dwarvish"]
};

/**
 * Ember content, for the hand-off scenarios at the end of this file.
 *
 * Ember's builder asks for an ancestry, a culture and a path, and merges the latter two into one
 * background (`in-world/ember.mjs`). Its cultures are the peoples — the `emberBkg*` items — and its
 * paths are the vocations; that split is taken from the naming, since the module exposes no API to
 * ask. Pairing them the other way round would still produce a manager both adapters could build, so
 * a mistake here costs realism rather than correctness.
 */
const EMBER = {
  ancestry: "Compendium.ember.character.Item.emberAncHuman000",
  culture: "Compendium.ember.character.Item.emberBkgStrider0",
  path: "Compendium.ember.character.Item.monsterHunter000",
  sorcerer: "Compendium.dnd-players-handbook.classes.Item.phbscrSorcerer00",
  fighter: "Compendium.dnd-players-handbook.classes.Item.phbftrFighter000",
  warlock: "Compendium.dnd-players-handbook.classes.Item.phbwlkWarlock000"
};

const SCENARIO_LIST = [
  {
    id: "human-fighter-sage",
    name: "Equivalence: Human Fighter (Sage)",
    speciesUuid: UUID.human,
    backgroundUuid: UUID.sage,
    classUuid: UUID.fighter,
    abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    answers: {
      // — Human (species) —
      dLxv96vt2B2KOEe2: "med",                                  // Size: Small or Medium
      xIdIaWtTj1cBERln: ["skills:sur"],                          // Skillful: any one skill
      KB8IQLwyuL6SOFnv: [UUID.savageAttacker],                   // Versatile: an origin feat

      // — Sage (background) —
      "3O61L5uTy5jRCqJb": { int: 2, wis: 1 },                    // Background ability increase
      pLGiyOjTP7nwuwTl: ["languages:standard:elvish",            // Choose 2 languages
        "languages:standard:dwarvish"],

      // — Fighter (class) —
      UaSYMl2io5kbXNOY: ["skills:ath", "skills:ins"],            // Skill proficiencies (choose 2)
      mJnrjhWpEz2lMDq4: ["weapon:mar:longsword",                 // Weapon Mastery (choose 3)
        "weapon:sim:handaxe", "weapon:mar:greatsword"],
      EmTANp6x6GfXFTmU: [UUID.archery]                           // Fighting Style
    }
  },

  /**
   * The same origins with a full caster in place of the martial, so the diff isolates the class.
   * Covers what the Fighter cannot: spellcasting progression, the `max-prepared` and
   * `cantrips-known` ScaleValues, and an Intelligence-based spellcasting ability.
   *
   * No spells are chosen. Picking a Wizard's level-1 spells is not an advancement — dnd5e's native
   * flow never asks, the player just adds them to the sheet — so spell selection has no native
   * counterpart to compare against and would only show up as creator-only extra items. What *is*
   * comparable is everything the class's advancements produce, which is what this checks.
   */
  {
    id: "human-wizard-sage",
    name: "Equivalence: Human Wizard (Sage)",
    speciesUuid: UUID.human,
    backgroundUuid: UUID.sage,
    classUuid: UUID.wizard,
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    answers: {
      ...HUMAN_SAGE,
      // Sage already grants Arcana and History, so Skillful and the class picks avoid them.
      xIdIaWtTj1cBERln: ["skills:ath"],                          // Human Skillful: any one skill
      "73lag0NN0ElcSq94": ["skills:ins", "skills:inv"]            // Wizard skills (choose 2)
    }
  },

  /**
   * The same Wizard carried to level 3, which is where the interesting machinery lives: gained
   * levels with a hit-point decision, the level-2 Scholar trait, and a subclass whose own features
   * are synthesised into the walk mid-flight.
   *
   * Both sides do this as a *single* 1→3 jump on one manager, not one level at a time — the native
   * side through `forLevelChange` + the rendered wizard, the creator through the same manager
   * driven by `LevelUpDriver.autoResolve`. That mirrors the creator's real post-creation hand-off
   * (`intercept.mjs#launchLevelUpTo`) with only the interactive shell replaced.
   *
   * Hit points are stated once and apply to every gained level; `{ 2: "avg", 3: "max" }` would set
   * them per level instead. Keep them off "roll" — a rolled die is not reproducible, so a scenario
   * that rolls can never be an equivalence test.
   */
  {
    id: "human-wizard-sage-l3",
    name: "Equivalence: Human Wizard (Sage) at level 3",
    speciesUuid: UUID.human,
    backgroundUuid: UUID.sage,
    classUuid: UUID.wizard,
    targetLevel: 3,
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    answers: {
      ...HUMAN_SAGE,
      xIdIaWtTj1cBERln: ["skills:ath"],                          // Human Skillful
      "73lag0NN0ElcSq94": ["skills:ins", "skills:inv"],           // Wizard skills, level 1

      // — gained on the way to 3 —
      a16u6wgnJQq8HMoq: "avg",                                   // Hit points, every gained level
      S1H3INPWaAiRkB6G: ["skills:inv"],                          // Scholar, level 2
      KTYjh1MKLvOtrZ3u: UUID.evoker                              // Subclass, level 3
    }
  },

  /**
   * Level 4, where the class's ability-score improvement is answered with a **feat** rather than
   * with points — the other half of what that screen offers, and the only route to a half-feat.
   *
   * Actor is deliberately the pick: its "+1 Charisma" is modelled as one point with every other
   * ability locked rather than as a `fixed` bonus, which is the shape the driver has a dedicated
   * branch for (a single open ability is an allocation with nothing to allocate, so it applies
   * outright instead of surfacing a choice with one option). Charisma is useless to a Wizard,
   * which is precisely why it is easy to see whether the bonus landed.
   *
   * The feat's own increase is stated explicitly (`Ki2HGAzrFwLX0HNG`) even though it is forced,
   * because the two sides reach it differently and the scenario should not depend on that. The
   * creator applies a one-open-ability allocation outright — there is nothing to allocate — while
   * the native flow renders the score un-incremented with a live "+" button
   * (`ability-score-improvement-flow.mjs` sets `value: sourceValue`, `canIncrease: true`) and
   * assigns nothing until it is clicked. Left unanswered, the creator lands +1 Charisma and the
   * native lands none; the creator is the one following the rules there, and a player using the
   * system's own wizard can simply forget to click. Stating the answer makes both sides do the
   * correct thing, so the scenario tests that they *can* rather than re-reporting a known
   * divergence on every run.
   */
  {
    id: "human-wizard-sage-l4-halffeat",
    name: "Equivalence: Human Wizard (Sage) at level 4 with a half-feat",
    speciesUuid: UUID.human,
    backgroundUuid: UUID.sage,
    classUuid: UUID.wizard,
    targetLevel: 4,
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    answers: {
      ...HUMAN_SAGE,
      xIdIaWtTj1cBERln: ["skills:ath"],                          // Human Skillful
      "73lag0NN0ElcSq94": ["skills:ins", "skills:inv"],           // Wizard skills, level 1
      a16u6wgnJQq8HMoq: "avg",                                   // Hit points, every gained level
      S1H3INPWaAiRkB6G: ["skills:inv"],                          // Scholar, level 2
      KTYjh1MKLvOtrZ3u: UUID.evoker,                             // Subclass, level 3
      bwCLOdauuzoHofil: { feat: UUID.actor },                    // Level-4 ASI: take a feat instead
      Ki2HGAzrFwLX0HNG: { cha: 1 }                               // Actor's own +1 Cha (see above)
    }
  },

  /**
   * The Sage's granted Magic Initiate, with its spells actually chosen — the one path the other
   * scenarios leave unexercised, and the reason they all report the same two
   * `value.ability` differences.
   *
   * The two builds reach these spells by genuinely different routes, which is the point of
   * comparing them. The native flow applies the feat's own spell `ItemChoice`s, so dnd5e's
   * `applySpellChanges` configures the granted spells and the advancement records them in
   * `value.added`. The creator defers them to its feat-spells step and `applyFeatSpells` creates
   * them straight onto the actor, hand-applying the same casting configuration
   * (`method`, `prepared`, once-per-long-rest uses, the chosen ability). That hand-application is
   * a standing drift risk against the system's own — this scenario is what would catch it.
   *
   * Expect differences here rather than a clean match: the creator's spells are not tracked by
   * the advancement. What matters is that the *spells themselves* come out configured the same.
   */
  {
    id: "human-wizard-sage-featspells",
    name: "Equivalence: Human Wizard (Sage) with Magic Initiate spells chosen",
    speciesUuid: UUID.human,
    backgroundUuid: UUID.sage,
    classUuid: UUID.wizard,
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    answers: {
      ...HUMAN_SAGE,
      xIdIaWtTj1cBERln: ["skills:ath"],                          // Human Skillful
      "73lag0NN0ElcSq94": ["skills:ins", "skills:inv"],           // Wizard skills

      // The native side answers Magic Initiate's own spell choices; the creator side takes the
      // same picks from `featSpells` below.
      ElkyDafWSUXOkPdJ: { uuids: [UUID.fireBolt, UUID.prestidigitation], ability: "int" },
      ZbKHs2FVCkJVNW8p: { uuids: [UUID.magicMissile], ability: "int" }
    },
    featSpells: {
      [UUID.magicInitiate]: {
        ability: "int",
        cantrips: [UUID.fireBolt, UUID.prestidigitation],
        spells: [UUID.magicMissile]
      }
    }
  },

  /**
   * A level-1 Fighter who multiclasses into Wizard — a *second class item*, not a level change,
   * which is a different entry point (`forNewItem`) and a different set of advancements.
   *
   * Two things only this covers. A secondary class contributes its `classRestriction: "secondary"`
   * advancements instead of its primary ones (a multiclass Wizard gets no skill choice and a
   * narrower proficiency set), so this is the one scenario where that restriction is exercised at
   * all. And the new class's first level is a genuine hit-point decision — `isOriginalClass` is
   * false — where every other scenario's level 1 takes the automatic maximum, so the driver's
   * "always ask, never inherit a prior avg" behaviour is finally under test.
   */
  {
    id: "fighter-multiclass-wizard",
    name: "Equivalence: Human Fighter 1 / Wizard 1 (Sage)",
    speciesUuid: UUID.human,
    backgroundUuid: UUID.sage,
    classUuid: UUID.fighter,
    multiclass: { classUuid: UUID.wizard, levels: 1 },
    abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    answers: {
      ...HUMAN_SAGE,
      xIdIaWtTj1cBERln: ["skills:sur"],                          // Human Skillful
      UaSYMl2io5kbXNOY: ["skills:ath", "skills:ins"],            // Fighter skills
      mJnrjhWpEz2lMDq4: ["weapon:mar:longsword",                 // Weapon Mastery
        "weapon:sim:handaxe", "weapon:mar:greatsword"],
      EmTANp6x6GfXFTmU: [UUID.archery],                          // Fighting Style
      a16u6wgnJQq8HMoq: "avg"                                    // Wizard's first level: a real roll
    }
  },

  /**
   * A 2014 species whose ability increase is entirely **fixed**: Hill Dwarf's +2 Constitution and
   * +1 Wisdom, with no points to place.
   *
   * Nothing here is a decision, which is exactly why it needs a test. The creator reads the increase
   * (`SourceIndex#readAsi` used to discard a `points: 0` advancement outright) and shows it read-only
   * on the Species step, while the driver applies it through `deferredAsi` without ever consulting
   * the provider. The native wizard renders the same advancement pre-filled from its `fixed` map.
   * Two different routes to the same six scores — and Constitution among them, so this also covers
   * the hit-point interaction that `actor-assembler.mjs` corrects for.
   *
   * The tool choice is the dwarf's own (brewer/mason/smith); the language grant is automatic.
   */
  {
    id: "hill-dwarf-wizard-2014",
    name: "Equivalence: Hill Dwarf Wizard (Acolyte), 2014 rules",
    speciesUuid: SRD2014.hillDwarf,
    backgroundUuid: SRD2014.acolyte,
    classUuid: SRD2014.wizard,
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    answers: {
      ...ACOLYTE_WIZARD_2014,
      "9CYW7Bj53L9G8Zsw": ["tool:art:smith"]                   // Dwarven artisan's tools (choose 1)
      // The ASI (Z9hvZFkWUNvowbQX) is deliberately unanswered: `points: 0` means there is nothing
      // to allocate, and both sides apply the fixed +2 CON / +1 WIS from the configuration alone.
    }
  },

  /**
   * A 2014 species that fixes *and* allocates: Half-Elf's +2 Charisma plus 2 free points at a cap
   * of 1 each. The shape the creator got wrong.
   *
   * The driver classifies this as a real allocation and raises the decision, but
   * `CreationChoiceProvider#asi` only ever answered the *background's* increase — so those two
   * points were silently never spent and a creator-built Half-Elf came out two points short. This
   * scenario is the regression test for that.
   *
   * The answer states the **total** per ability, fixed part included, as the native ASI form takes
   * it: +2 Charisma is the advancement's own, +1 Dexterity and +1 Constitution are the placed
   * points. Charisma takes none of them — its fixed bump already meets the cap of 1, which is how
   * dnd5e's own flow gates it and now how the creator's panel does too.
   */
  {
    id: "half-elf-wizard-2014",
    name: "Equivalence: Half-Elf Wizard (Acolyte), 2014 rules",
    speciesUuid: SRD2014.halfElf,
    backgroundUuid: SRD2014.acolyte,
    classUuid: SRD2014.wizard,
    abilities: { str: 8, dex: 13, con: 12, int: 15, wis: 10, cha: 14 },
    answers: {
      ...ACOLYTE_WIZARD_2014,
      Z9hvZFkWUNvowbQX: { cha: 2, dex: 1, con: 1 },             // +2 fixed, 2 points placed
      CormRQZ5momyvS2I: ["skills:per", "skills:prc"],           // Skill Versatility (choose 2)
      U3OO7jLU0nm0Z7zw: ["languages:standard:dwarvish"]         // Choose 1 extra language
    }
  },

  /**
   * Ember's creation hand-off — the one flow where this module does not build the character at all.
   * Ember assembles ancestry, culture, path and class itself, stages them onto one manager's clone
   * and renders it; `intercept.mjs` claims that manager and runs the level-up wizard over it.
   *
   * These three scenarios stage the same manager Ember does (`in-world/ember.mjs` — see its header
   * for what that can and cannot stand in for) and compare our driver against the system's own
   * wizard over it. They answer generated, because there is no hand-written table that would survive
   * an Ember content update, and because the interesting question is whether the two walks agree
   * rather than what a particular character picked.
   *
   * The three exist because the implementation notes flag exactly these as unverified beyond one
   * hand-checked sorcerer: a full caster, a martial with no spellcasting at all, and a warlock, whose
   * pact slots are a different spellcasting progression from either.
   *
   * `world` pins them to `playwright-ember`; nothing here resolves in a world without Ember.
   */
  {
    id: "ember-sorcerer",
    name: "Ember: Human Strider Monster Hunter Sorcerer",
    world: "playwright-ember",
    generate: true,
    ember: { ancestryUuid: EMBER.ancestry, cultureUuid: EMBER.culture, pathUuid: EMBER.path },
    classUuid: EMBER.sorcerer,
    abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 }
  },
  {
    id: "ember-fighter",
    name: "Ember: Human Strider Monster Hunter Fighter",
    world: "playwright-ember",
    generate: true,
    ember: { ancestryUuid: EMBER.ancestry, cultureUuid: EMBER.culture, pathUuid: EMBER.path },
    classUuid: EMBER.fighter,
    abilities: { str: 15, dex: 14, con: 13, int: 10, wis: 12, cha: 8 }
  },
  {
    id: "ember-warlock",
    name: "Ember: Human Strider Monster Hunter Warlock",
    world: "playwright-ember",
    generate: true,
    ember: { ancestryUuid: EMBER.ancestry, cultureUuid: EMBER.culture, pathUuid: EMBER.path },
    classUuid: EMBER.warlock,
    abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 }
  }
];

/**
 * Every scenario belongs to a world, and the base world is the default.
 *
 * That is not just tidiness: the hand-written scenarios above answer trait choices with literal keys
 * like `languages:standard:elvish`, and **Ember replaces the language list** — its world offers
 * Arcden, Cascal, Imperial and the rest, and none of the standard ones. Running them there fails on
 * a key the pool has never heard of, which looks alarming and means nothing. Anything naming
 * specific content is portable only to the world that content is in.
 */
export const SCENARIOS = SCENARIO_LIST.map(s => ({ world: "playwright", ...s }));
