import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rulesPageFor, hasRulesPage, invalidateRulesPages, RULE_TOPICS } from "../scripts/data/rules-source.mjs";

/**
 * Resolving a wizard step's topic to the rulebook's own page.
 *
 * The two editions are shaped completely differently, and that asymmetry is the whole point of the
 * module — so it is what these tests pin down:
 *
 *  - **2024** puts all of character creation in one entry with the *stable* id `phbCreatingAChar`,
 *    so it resolves by id, and it exists in two packs (the PHB module's fuller copy and the
 *    system's free-rules one) with a real preference between them.
 *  - **2014** spreads the same ground across chapter entries whose ids are **random**, verified
 *    against the installed system content — so those must resolve by entry *name*, and a test that
 *    let them resolve by id would pass here and fail in a real world.
 *
 * The packs are faked at the `game.packs` seam because that is exactly the boundary the module
 * treats as untrusted: it must return null, never throw, for a world missing the book entirely.
 */
describe("rulesPageFor resolves a topic to a rulebook page", () => {
  const page = name => ({ name });

  /** A fake compendium whose index and documents behave like Foundry's. */
  const pack = entries => ({
    getIndex: async () => ({
      get: id => entries.find(e => e._id === id),
      find: fn => entries.find(fn)
    }),
    getDocument: async id => entries.find(e => e._id === id)
  });

  /** The system's free-rules wording. */
  const MODERN = {
    _id: "phbCreatingAChar",
    name: "Character Creation",
    pages: [page("Step 1: Choose a Class"), page("Step 2: Character Origin"),
      page("Step 3: Ability Scores"), page("Step 4: Alignment"), page("Multiclassing"),
      page("Gaining a Level")]
  };
  /**
   * The Player's Handbook module's wording of the *same entry id*. Verified against the installed
   * module: it names four of these pages differently, which is what made them resolve to nothing
   * the moment the module was installed.
   */
  const MODERN_PHB = {
    _id: "phbCreatingAChar",
    name: "Creating a Character",
    pages: [page("Introduction"), page("Step 1: Choose a Class"), page("Step 2: Determine Origin"),
      page("Step 3: Determine Ability Scores"), page("Step 4: Choose an Alignment"),
      page("Step 5: Fill In Details"), page("Multiclassing"), page("Gaining a Level")]
  };
  const LEGACY = [
    { _id: "5LoAJLkfIYBAgWTW", name: "Chapter 1: Beyond 1st Level", pages: [page("Beyond 1st Level")] },
    { _id: "aRaNDomId00000001", name: "Chapter 2: Races", pages: [page("Races")] },
    { _id: "aRaNDomId00000002", name: "Chapter 3: Classes", pages: [page("Overview")] },
    { _id: "aRaNDomId00000003", name: "Chapter 4: Personality and Background",
      pages: [page("Alignment"), page("Backgrounds")] },
    { _id: "aRaNDomId00000004", name: "Chapter 6: Customization Options",
      pages: [page("Multiclassing")] },
    { _id: "aRaNDomId00000005", name: "Chapter 7: Using Ability Scores",
      pages: [page("Ability Scores and Modifiers")] }
  ];

  let packs;
  const install = () => { globalThis.game = { packs: { get: id => packs[id] ?? null } }; };

  beforeEach(() => {
    invalidateRulesPages();
    packs = {
      "dnd5e.content24": pack([{ ...MODERN }]),
      "dnd5e.rules": pack(LEGACY)
    };
    install();
  });

  afterEach(() => { invalidateRulesPages(); delete globalThis.game; });

  it("resolves a 2024 topic to its step-named page", async () => {
    expect((await rulesPageFor("class", "2024")).name).toBe("Step 1: Choose a Class");
    expect((await rulesPageFor("abilities", "2024")).name).toBe("Step 3: Ability Scores");
  });

  it("lands species and background on 2024's single shared origin page", async () => {
    expect((await rulesPageFor("species", "2024")).name).toBe("Step 2: Character Origin");
    expect((await rulesPageFor("background", "2024")).name).toBe("Step 2: Character Origin");
  });

  /** The chapter ids are random, so name is the only thing that can find them. */
  it("resolves a 2014 topic through its chapter's name", async () => {
    expect((await rulesPageFor("species", "2014")).name).toBe("Races");
    expect((await rulesPageFor("background", "2014")).name).toBe("Backgrounds");
    expect((await rulesPageFor("alignment", "2014")).name).toBe("Alignment");
    expect((await rulesPageFor("multiclassing", "2014")).name).toBe("Multiclassing");
  });

  it("picks the right page when one chapter holds several topics", async () => {
    // Chapter 4 carries both Alignment and Backgrounds, and they are different topics.
    expect((await rulesPageFor("alignment", "2014")).name).toBe("Alignment");
    expect((await rulesPageFor("background", "2014")).name).toBe("Backgrounds");
  });

  /**
   * Feats are deliberately not a topic: 2014 has a real page for them, but the 2024 entry has none
   * (origin feats live in a separate Feats entry), and opening "Character Creation Details" when a
   * player asked about feats is worse than offering nothing.
   */
  it("has no feats topic, rather than one pointing at the wrong 2024 page", async () => {
    expect(RULE_TOPICS).not.toContain("feats");
    expect(await rulesPageFor("feats", "2014")).toBeNull();
  });

  it("prefers the Player's Handbook module's copy over the system's free rules", async () => {
    packs["dnd-players-handbook.content"] = pack([MODERN_PHB]);
    invalidateRulesPages();
    // The PHB's own wording proves which pack answered — both carry a page for this topic.
    expect((await rulesPageFor("species", "2024")).name).toBe("Step 2: Determine Origin");
  });

  /**
   * The two 2024 packs share one entry id but word four of its pages differently. Resolving by a
   * single hardcoded name left species, background, abilities and alignment dead in any world with
   * the Player's Handbook installed — which is most of them.
   */
  it("resolves against either pack's wording of the same page", async () => {
    packs = { "dnd-players-handbook.content": pack([MODERN_PHB]) };
    invalidateRulesPages();
    expect((await rulesPageFor("species", "2024")).name).toBe("Step 2: Determine Origin");
    expect((await rulesPageFor("abilities", "2024")).name).toBe("Step 3: Determine Ability Scores");
    expect((await rulesPageFor("alignment", "2024")).name).toBe("Step 4: Choose an Alignment");

    packs = { "dnd5e.content24": pack([MODERN]) };
    invalidateRulesPages();
    expect((await rulesPageFor("species", "2024")).name).toBe("Step 2: Character Origin");
    expect((await rulesPageFor("abilities", "2024")).name).toBe("Step 3: Ability Scores");
    expect((await rulesPageFor("alignment", "2024")).name).toBe("Step 4: Alignment");
  });

  /**
   * The step *numbers* are fixed by the rules; only the wording is the publisher's. So a book that
   * words its headings a third way still resolves, rather than silently losing its control.
   */
  it("falls back to the step number when a book words its heading a new way", async () => {
    packs = { "dnd5e.content24": pack([{
      _id: "phbCreatingAChar", name: "Character Creation",
      pages: [page("Step 2: Where You Came From"), page("Step 3: Rolling Your Stats")]
    }]) };
    invalidateRulesPages();
    expect((await rulesPageFor("species", "2024")).name).toBe("Step 2: Where You Came From");
    expect((await rulesPageFor("abilities", "2024")).name).toBe("Step 3: Rolling Your Stats");
  });

  // The fallback is only for the numbered steps — an unnumbered topic must not grab a stray page.
  it("does not guess for a topic with no step number", async () => {
    packs = { "dnd5e.content24": pack([{
      _id: "phbCreatingAChar", name: "Character Creation", pages: [page("Something Else Entirely")]
    }]) };
    invalidateRulesPages();
    expect(await rulesPageFor("multiclassing", "2024")).toBeNull();
    expect(await rulesPageFor("levelUp", "2024")).toBeNull();
  });

  it("falls back to the system pack when the module is absent", async () => {
    expect(await hasRulesPage("class", "2024")).toBe(true);
  });

  it("defaults to 2024 when no edition is known, matching dnd5e's own modern default", async () => {
    for ( const edition of [null, undefined, ""] ) {
      expect((await rulesPageFor("class", edition)).name).toBe("Step 1: Choose a Class");
    }
  });

  it("returns null for an unknown topic rather than throwing", async () => {
    expect(await rulesPageFor("elevenses", "2024")).toBeNull();
    expect(await hasRulesPage("elevenses", "2024")).toBe(false);
  });

  // An SRD-only or homebrew-only world: the control must hide, not offer a button that opens nothing.
  it("returns null when the world has no book covering the topic", async () => {
    packs = {};
    invalidateRulesPages();
    expect(await rulesPageFor("class", "2024")).toBeNull();
    expect(await rulesPageFor("species", "2014")).toBeNull();
  });

  it("returns null when the entry exists but lacks the wanted page", async () => {
    packs["dnd5e.content24"] = pack([{ ...MODERN, pages: [page("Trinkets")] }]);
    invalidateRulesPages();
    expect(await rulesPageFor("class", "2024")).toBeNull();
  });

  it("survives a pack that throws while being read", async () => {
    packs["dnd5e.content24"] = { getIndex: async () => { throw new Error("pack is broken"); } };
    invalidateRulesPages();
    expect(await rulesPageFor("class", "2024")).toBeNull();
  });

  it("survives a world with no compendium collection at all", async () => {
    globalThis.game = {};
    invalidateRulesPages();
    expect(await rulesPageFor("class", "2024")).toBeNull();
  });

  it("caches a resolved page, and forgets it when the enabled packs change", async () => {
    let reads = 0;
    packs["dnd5e.content24"] = {
      getIndex: async () => { reads++; return { get: id => (id === MODERN._id ? MODERN : undefined) }; },
      getDocument: async () => MODERN
    };
    invalidateRulesPages();
    await rulesPageFor("class", "2024");
    await rulesPageFor("class", "2024");
    expect(reads).toBe(1);
    invalidateRulesPages();
    await rulesPageFor("class", "2024");
    expect(reads).toBe(2);
  });

  it("caches a miss too, so an SRD-only world is not re-scanned on every render", async () => {
    let reads = 0;
    packs["dnd5e.content24"] = {
      getIndex: async () => { reads++; return { get: () => undefined }; },
      getDocument: async () => null
    };
    invalidateRulesPages();
    expect(await rulesPageFor("class", "2024")).toBeNull();
    expect(await rulesPageFor("class", "2024")).toBeNull();
    expect(reads).toBe(1);
  });

  // Every topic must resolve under both editions with the real content installed; a typo in either
  // half of the map would otherwise only show up as a silently missing button in a live world.
  it("has a page for every topic in both editions", async () => {
    for ( const topic of RULE_TOPICS ) {
      expect(await hasRulesPage(topic, "2024"), `${topic} (2024)`).toBe(true);
      expect(await hasRulesPage(topic, "2014"), `${topic} (2014)`).toBe(true);
    }
  });
});
