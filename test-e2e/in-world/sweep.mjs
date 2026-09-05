/**
 * The sweeps: generated scenarios that vary **one** thing across everything the world installs.
 *
 * The hand-written scenarios in `scenarios.mjs` are chosen — each one exists to exercise a specific
 * mechanism, and its answers are argued for in a comment. These are the opposite: breadth, no
 * judgement, built both ways and diffed.
 *
 * Three axes, selected with `run.mjs --sweep --axis <name>`:
 *
 * | Axis | Varies | Holds fixed |
 * | --- | --- | --- |
 * | `subclass` (default) | every subclass installed | Human/Sage origins, points at every ASI |
 * | `species` | every 2024 species | Wizard/Evoker, Sage |
 * | `background` | every 2024 background | Fighter/Champion, Human — **a feat at every ASI** |
 *
 * The second and third exist because the first holds three things still that turned out to matter:
 * Human is the one PHB'24 species with no advancement above level 0, backgrounds were never varied
 * at all, and `generateAsi` spends every improvement on ability scores so no feat is ever taken.
 *
 * Whatever an axis holds fixed is deliberately the characterised choice — the same origins the six
 * hand-written scenarios use — so a difference is about the thing being varied and not about its
 * companions.
 *
 * Answers come from the {@link AnswerBook} generator (`generate: true`), with exactly one override:
 * the subclass itself, which is the variable being swept and the one decision generation refuses to
 * make for you.
 *
 * Level 20 because the interesting content is spread across it. A subclass grants features at four
 * or five levels, the class's ability-score improvements land at 4/8/12/16/19 (plus the Fighter's
 * and Rogue's extras), spell progression runs the whole way, and a level-3 build would test the
 * first tranche and nothing else. It is a long run — see `run.mjs --sweep`, which streams results
 * so a crash costs one scenario rather than all of them.
 */

/** Base ability scores, spread so no class is crippled and every ASI has somewhere to go. */
const ABILITIES = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };

/**
 * The characterised origins, per rules edition — see the file header.
 *
 * A 2014 class gets 2014 origins. Pairing Tasha's Path of the Beast with the 2024 Human and the 2024
 * Sage builds a character no edition describes: three origin items and a class that were never
 * written to sit together, whose disagreements are then reported as findings about the subclass. The
 * system ships the 2014 SRD origins alongside the 2014 classes, so each edition can be built with
 * its own.
 *
 * Human and Sage stay the 2024 pair the six hand-written scenarios use, so anything they contribute
 * is already characterised. The 2014 side takes SRD Human (a flat +1 to every ability, so no
 * allocation decision) and Acolyte — the only background the 2014 SRD ships.
 */
const ORIGINS = {
  2024: {
    species: "Compendium.dnd5e.origins24.Item.phbspHuman000000",
    background: "Compendium.dnd5e.origins24.Item.phbbgSage0000000"
  },
  2014: {
    species: "Compendium.dnd5e.races.Item.ydP3QzCmur55mtY2",
    background: "Compendium.dnd5e.backgrounds.Item.IgJkSnLiLJOWH7eK"
  }
};

/** The origins to build a class of this rules edition with; unmarked content is treated as 2024. */
function originsFor(rules) {
  return ORIGINS[String(rules) === "2014" ? 2014 : 2024];
}

/** A subclass name to an id-safe slug. */
function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* -------------------------------------------- */

/**
 * The module a pack belongs to. A pack collection is `<packageId>.<packName>`, so this is the
 * publisher — `dnd-tashas-cauldron`, `dnd-forge-artificer`, `dnd5e` for the system's own.
 */
function packageOf(packCollection) {
  return String(packCollection).split(".")[0];
}

/**
 * Every class item in the world, keyed by its identifier — **all** candidates per identifier,
 * sorted by uuid.
 *
 * Index-scanned rather than loaded: a class document is large and all this needs is the uuid and the
 * identifier its subclasses point at.
 *
 * Two modules can publish a class under one identifier — `dnd-forge-artificer` and
 * `dnd-tashas-cauldron` both ship `artificer` — and they are *different classes*, with different
 * features at different levels. Which one a subclass is built onto is not a detail: a Tasha's
 * Artillerist grew up alongside Tasha's Artificer, and pairing it with the Forge one tests a
 * combination its author never wrote. So the choice is made per subclass rather than once per
 * identifier — see {@link classFor}.
 */
async function classesByIdentifier() {
  const out = new Map();
  const found = [];
  for ( const pack of game.packs.filter(p => p.documentName === "Item") ) {
    const index = await pack.getIndex({ fields: ["system.identifier", "system.source"] });
    for ( const entry of index ) {
      if ( entry.type !== "class" ) continue;
      const identifier = entry.system?.identifier;
      if ( identifier ) found.push({
        identifier, uuid: entry.uuid, name: entry.name, pack: pack.collection,
        rules: entry.system?.source?.rules ?? null
      });
    }
  }
  found.sort((a, b) => a.uuid.localeCompare(b.uuid));
  for ( const cls of found ) {
    if ( !out.has(cls.identifier) ) out.set(cls.identifier, []);
    out.get(cls.identifier).push(cls);
  }
  return out;
}

/**
 * Which classes a module's subclasses belong on, when the module does not ship the class itself.
 * Keyed by the subclass's package, valued with a pack collection.
 *
 * Tasha's Cauldron is 2014 content. Its Path of the Beast was written against the 2014 Barbarian —
 * different features at different levels from the 2024 one — so building it onto the Player's
 * Handbook 2024 Barbarian would be testing a pairing that never existed. The system still ships the
 * 2014 classes in `dnd5e.classes`, so that is where they go. Its *own* Artificer is unaffected: the
 * same-pack tier in {@link classFor} runs first and keeps Tasha's four Artificer subclasses on
 * Tasha's Artificer.
 */
const CLASS_SOURCE = { "dnd-tashas-cauldron": "dnd5e.classes" };

/**
 * Where a subclass lands when its own module ships no class for it and the identifier is contested.
 *
 * Only `artificer` needs saying: three modules publish Artificer subclasses and two publish an
 * Artificer class, so Ravenloft's Reanimator — which ships neither — would otherwise be decided by
 * whichever module id sorts first. It does currently resolve to the Forge Artificer that way, which
 * is the right answer; this states the intent rather than inheriting it from the alphabet, so a
 * module named `dnd-a…` appearing later cannot silently move it.
 */
const CLASS_FALLBACK = { artificer: "dnd-forge-artificer" };

/**
 * The class a subclass should be built onto, nearest publisher first.
 *
 * A subclass and the class it was written for travel together, so proximity is the tie-break that
 * matters. Three tiers, narrowest first:
 *
 *  1. **Same pack.** Decides the two the system itself ships: a `dnd5e.classes24` subclass belongs
 *     on the 2024 class beside it, not on the 2014 one in `dnd5e.classes`, and package alone cannot
 *     tell those apart.
 *  2. **The module's stated class source** in {@link CLASS_SOURCE} — Tasha's subclasses onto the
 *     2014 classes the system still ships, because that is the edition they were written for.
 *  3. **Same module**, for a module that ships both without needing to be named here.
 *  4. **The stated fallback** in {@link CLASS_FALLBACK}, then first by uuid — stable across runs,
 *     and what every uncontested identifier resolves to. This is where a subclass whose module ships
 *     no class of its own lands: Ravenloft's Reanimator onto the Forge Artificer, every 2014 SRD
 *     subclass onto the 2014 SRD class.
 * @param {object[]} candidates    Class records for one identifier, uuid-sorted.
 * @param {string} subclassPack    The subclass's pack collection.
 */
function classFor(candidates, subclassPack) {
  const home = packageOf(subclassPack);
  const source = CLASS_SOURCE[home];
  const fallback = CLASS_FALLBACK[candidates[0].identifier];
  return candidates.find(c => c.pack === subclassPack)
    ?? (source ? candidates.find(c => c.pack === source) : null)
    ?? candidates.find(c => packageOf(c.pack) === home)
    ?? (fallback ? candidates.find(c => packageOf(c.pack) === fallback) : null)
    ?? candidates[0];
}

/** Every subclass in the world, sorted by uuid so the sweep runs in the same order every time. */
async function allSubclasses() {
  const out = [];
  for ( const pack of game.packs.filter(p => p.documentName === "Item") ) {
    const index = await pack.getIndex({ fields: ["system.classIdentifier"] });
    for ( const entry of index ) {
      if ( entry.type !== "subclass" ) continue;
      out.push({
        name: entry.name, uuid: entry.uuid, pack: pack.collection,
        classIdentifier: entry.system?.classIdentifier ?? null
      });
    }
  }
  return out.sort((a, b) => a.uuid.localeCompare(b.uuid));
}

/**
 * The id of a class's Subclass advancement — the decision the scenario has to answer.
 *
 * Read off the document rather than hard-coded, because an advancement id is specific to the content
 * version that shipped it: a module update reshuffles them and every hand-written id goes stale at
 * once. This is also why the sweep can cover third-party classes it has never seen.
 */
function subclassAdvancementId(classDoc) {
  const adv = Object.values(classDoc.advancement?.byId ?? {}).find(a => a.type === "Subclass");
  return adv?.id ?? null;
}

/* -------------------------------------------- */
/*  The species axis                             */
/* -------------------------------------------- */

/**
 * The class every species scenario is built on, and the subclass it takes.
 *
 * The Wizard, deliberately. Six of the eight species with advancement above level 1 grant *spells*
 * at levels 1, 3 and 5, and every one of those carries a casting-ability decision — so the class
 * needs a spellcasting ability of its own for the resolver's "align it with your class" hint to be
 * exercised at all. On a Fighter that hint is null and the most interesting half of the decision
 * never runs.
 */
const SPECIES_AXIS = { classIdentifier: "wizard", subclass: "Evoker" };

/**
 * Resolve an axis's fixed class and subclass to live uuids, by identifier and name.
 *
 * Not hard-coded uuids, for the reason {@link subclassAdvancementId} gives about advancement ids: an
 * id belongs to the content version that shipped it, and a written-down one goes stale the moment a
 * module updates. Resolving here also means an axis names what it wants ("a 2024 Wizard, Evoker")
 * rather than which pack happens to hold it today.
 * @param {{classIdentifier: string, subclass: string}} spec
 * @returns {Promise<{cls: object, subclassUuid: string|null, advId: string|null}|null>}
 */
async function resolveAxisClass(spec) {
  const classes = await classesByIdentifier();
  const candidates = classes.get(spec.classIdentifier) ?? [];
  // The 2024 class, since both axes vary a 2024 origin against it.
  const cls = candidates.find(c => String(c.rules) !== "2014") ?? candidates[0];
  if ( !cls ) return null;

  const doc = await fromUuid(cls.uuid).catch(() => null);
  if ( !doc ) return null;

  const subs = await allSubclasses();
  const sub = subs.find(s => (s.classIdentifier === spec.classIdentifier)
    && (s.name === spec.subclass) && (s.pack === cls.pack))
    ?? subs.find(s => (s.classIdentifier === spec.classIdentifier) && (s.name === spec.subclass));
  return { cls, subclassUuid: sub?.uuid ?? null, advId: subclassAdvancementId(doc) };
}

/** Every species in the world, sorted by uuid so the axis runs in the same order every time. */
async function allSpecies() {
  const out = [];
  for ( const pack of game.packs.filter(p => p.documentName === "Item") ) {
    const index = await pack.getIndex({ fields: ["system.source"] });
    for ( const entry of index ) {
      // dnd5e's item type for a species is historically "race".
      if ( entry.type !== "race" ) continue;
      out.push({
        name: entry.name, uuid: entry.uuid, pack: pack.collection,
        rules: entry.system?.source?.rules ?? null
      });
    }
  }
  return out.sort((a, b) => a.uuid.localeCompare(b.uuid));
}

/**
 * One scenario per species, on a fixed class — the axis the subclass sweep holds still.
 *
 * The subclass sweep pins Human, which is the one PHB'24 species whose every advancement sits at
 * level 0. Eight of the fifteen do not: the three Elves and three Tieflings grant spells at levels 1,
 * 3 and 5, Dragonborn gains Draconic Flight at 5 on top of a level-keyed Breath Weapon scale, and
 * Goliath gains Large Form at 5. None of that was reachable before this axis existed.
 *
 * Species advancements are keyed to *character* level and dnd5e pushes their flows at every level
 * (`createLevelChangeSteps`), so a species grant arrives mid-walk on a class that knows nothing about
 * it — the shape that has produced findings here before.
 */
async function speciesScenarios({ level, incremental }) {
  const species = await allSpecies();
  const axis = await resolveAxisClass(SPECIES_AXIS);
  if ( !axis ) {
    return { scenarios: [], skipped: [{ subclass: "species axis", reason: `no "${SPECIES_AXIS.classIdentifier}" class is installed` }] };
  }

  // The Player's Handbook module and the system's own `origins24` ship the *same* 2024 species, so
  // an undeduped axis builds every one of them twice — 38 scenarios to test 19 species. Deduped by
  // name, preferring `dnd5e.origins24` because that is where the subclass sweep's characterised
  // Human comes from, so the two axes agree about what "Human" means.
  const byName = new Map();
  for ( const sp of species ) {
    const seen = byName.get(sp.name);
    if ( !seen || ((seen.pack !== "dnd5e.origins24") && (sp.pack === "dnd5e.origins24")) ) byName.set(sp.name, sp);
  }

  const scenarios = [];
  const skipped = [];
  for ( const sp of byName.values() ) {
    // A 2014 species on the 2024 Wizard would reintroduce exactly the mixed-edition pairing the
    // origins split above exists to avoid, and the 2014 species are already covered as the origins
    // of every 2014-class scenario in the subclass sweep.
    if ( String(sp.rules) === "2014" ) {
      skipped.push({ subclass: sp.name, uuid: sp.uuid, reason: "2014 species; the axis class is 2024" });
      continue;
    }
    const id = `species:${slug(sp.name)}`;
    scenarios.push({
      id,
      name: `Species: ${sp.name} ${level} — ${axis.cls.name}/${SPECIES_AXIS.subclass} (${sp.pack})`,
      generate: true,
      incremental,
      speciesUuid: sp.uuid,
      backgroundUuid: ORIGINS[2024].background,
      classUuid: axis.cls.uuid,
      targetLevel: level,
      abilities: { ...ABILITIES },
      answers: (axis.advId && axis.subclassUuid) ? { [axis.advId]: axis.subclassUuid } : {}
    });
  }
  return { scenarios, skipped };
}

/* -------------------------------------------- */
/*  The background / feat axis                   */
/* -------------------------------------------- */

/**
 * The class every background scenario is built on, and the subclass it takes.
 *
 * The Fighter: a martial with no spellcasting of its own, so nothing a feat brings can be confused
 * with class spell progression — and the class with the *most* ability-score improvements in the
 * game (4, 6, 8, 12, 14, 16, 19), which on this axis means the most feats taken per character.
 */
const FEAT_AXIS = { classIdentifier: "fighter", subclass: "Champion" };

/** Every background in the world, sorted by uuid so the axis runs in the same order every time. */
async function allBackgrounds() {
  const out = [];
  for ( const pack of game.packs.filter(p => p.documentName === "Item") ) {
    const index = await pack.getIndex({ fields: ["system.source"] });
    for ( const entry of index ) {
      if ( entry.type !== "background" ) continue;
      out.push({
        name: entry.name, uuid: entry.uuid, pack: pack.collection,
        rules: entry.system?.source?.rules ?? null
      });
    }
  }
  return out.sort((a, b) => a.uuid.localeCompare(b.uuid));
}

/**
 * One scenario per background, with **every ASI answered by taking a feat**.
 *
 * Two gaps in one axis, both of which the subclass sweep leaves wide open:
 *
 * - **No feat is ever taken.** `generateAsi` allocates points, so across 122 level-20 characters not
 *   one general feat is selected and nothing a feat *brings* — its own half-feat increase, its
 *   grants, its spell choices — is ever compared. Here a Fighter takes seven.
 * - **One background.** Sage is the only origin the sweep uses, so its origin feat (Magic Initiate)
 *   is the only one any character holds.
 *
 * Backgrounds themselves have every advancement at level 0 — there is no per-level behaviour to
 * cover — so varying the background is worth doing *because* of what it changes about the feats,
 * not for the background's own sake.
 */
async function backgroundScenarios({ level, incremental }) {
  const backgrounds = await allBackgrounds();
  const axis = await resolveAxisClass(FEAT_AXIS);
  if ( !axis ) {
    return { scenarios: [], skipped: [{ subclass: "background axis", reason: `no "${FEAT_AXIS.classIdentifier}" class is installed` }] };
  }

  // Deduped by name for the same reason the species axis is: the Player's Handbook module and the
  // system's own `origins24` ship the same 2024 backgrounds, so an undeduped axis builds each twice.
  const byName = new Map();
  for ( const bg of backgrounds ) {
    const seen = byName.get(bg.name);
    if ( !seen || ((seen.pack !== "dnd5e.origins24") && (bg.pack === "dnd5e.origins24")) ) byName.set(bg.name, bg);
  }

  const scenarios = [];
  const skipped = [];
  for ( const bg of byName.values() ) {
    if ( String(bg.rules) === "2014" ) {
      skipped.push({ subclass: bg.name, uuid: bg.uuid, reason: "2014 background; the axis class is 2024" });
      continue;
    }
    const id = `background:${slug(bg.name)}`;
    scenarios.push({
      id,
      name: `Background: ${bg.name} ${level} — ${axis.cls.name}/${FEAT_AXIS.subclass}, feats at every ASI (${bg.pack})`,
      generate: true,
      // The axis itself: every ability-score improvement is answered with a feat.
      asiFeats: true,
      incremental,
      speciesUuid: ORIGINS[2024].species,
      backgroundUuid: bg.uuid,
      classUuid: axis.cls.uuid,
      targetLevel: level,
      abilities: { ...ABILITIES },
      answers: (axis.advId && axis.subclassUuid) ? { [axis.advId]: axis.subclassUuid } : {}
    });
  }
  return { scenarios, skipped };
}

/* -------------------------------------------- */

/**
 * Build a sweep's scenario list.
 * @param {object} [options]
 * @param {number} [options.level]    Level to carry each build to.
 * @param {string} [options.axis]     "subclass" (the default), "species" or "background".
 * @returns {Promise<{scenarios: object[], skipped: object[]}>}
 */
export async function sweepScenarios({ level = 20, incremental = false, axis = "subclass" } = {}) {
  if ( axis === "species" ) return speciesScenarios({ level, incremental });
  if ( axis === "background" ) return backgroundScenarios({ level, incremental });
  const classes = await classesByIdentifier();
  const subclasses = await allSubclasses();

  const scenarios = [];
  const skipped = [];
  const advIds = new Map();   // class uuid -> subclass advancement id, resolved once per class

  for ( const sub of subclasses ) {
    const candidates = sub.classIdentifier ? classes.get(sub.classIdentifier) : null;
    const cls = candidates?.length ? classFor(candidates, sub.pack) : null;
    if ( !cls ) {
      // A subclass whose class is not installed — common when a module ships content for a class
      // from a book the world does not have. Reported, not thrown: the sweep is about what is here.
      skipped.push({ subclass: sub.name, uuid: sub.uuid, reason: `no class "${sub.classIdentifier}" is installed` });
      continue;
    }

    if ( !advIds.has(cls.uuid) ) {
      const doc = await fromUuid(cls.uuid).catch(() => null);
      advIds.set(cls.uuid, doc ? subclassAdvancementId(doc) : null);
    }
    const advId = advIds.get(cls.uuid);
    if ( !advId ) {
      skipped.push({ subclass: sub.name, uuid: sub.uuid, reason: `"${cls.name}" has no Subclass advancement` });
      continue;
    }

    // Two packs can ship the same subclass name under the same class identifier — the SRD's Thief
    // and the Player's Handbook's, say. They are different documents and both are worth building, so
    // the collision is broken with the pack rather than dropped: an id has to be unique or `--resume`
    // would skip a scenario it never ran and `sweepOne` would build the wrong one.
    let id = `sweep:${sub.classIdentifier}/${slug(sub.name)}`;
    if ( scenarios.some(s => s.id === id) ) id += `-${slug(sub.pack)}`;

    const origins = originsFor(cls.rules);

    scenarios.push({
      id,
      // The class pack is named only when the identifier was contested, because that is the only
      // time a reader could be wrong about which class the subclass was built onto. The edition is
      // named whenever it is not the 2024 default, since it changes the origins too.
      name: `Sweep: ${cls.name} ${level} — ${sub.name} (${sub.pack})`
        + (candidates.length > 1 ? ` [class: ${cls.pack}]` : "")
        + (String(cls.rules) === "2014" ? " [2014]" : ""),
      generate: true,
      // One manager per level rather than one for the jump, snapshotted at each — see
      // `harness.mjs#compareLevels`.
      incremental,
      speciesUuid: origins.species,
      backgroundUuid: origins.background,
      classUuid: cls.uuid,
      targetLevel: level,
      abilities: { ...ABILITIES },
      // The one stated answer. Everything else is generated.
      answers: { [advId]: sub.uuid }
    });
  }

  return { scenarios, skipped };
}
