import { beforeEach, describe, expect, it } from "vitest";
import { sourcePageFor, hasSourcePage, invalidateJournalIndex } from "../scripts/data/journal-source.mjs";

/**
 * Finding a class or subclass's own page in the source book.
 *
 * The link only runs page → item (`page.system.item` holds the item UUID) and `system.item` is not
 * in the compendium index, so the map has to be built by loading pages. Two properties matter and
 * both are pinned here: it must **narrow using the index** where it can — the Player's Handbook
 * journal pack holds several hundred entries of which about a dozen are class pages, and loading
 * all of them on every class click would be unusable — and it must still be **correct** on a pack
 * whose index carries no page list, by falling back to loading the lot.
 */

const PALADIN = "Compendium.dnd-players-handbook.classes.Item.phbclsPaladin00";
const DEVOTION = "Compendium.dnd-players-handbook.classes.Item.phbsubDevotion0";

/** A journal page stub. */
function page(id, type, itemUuid, name = "Paladin") {
  return { id, name, type, system: { item: itemUuid } };
}

/**
 * A compendium pack stub. `index` is what `getIndex()` returns; `loaded` records which entries were
 * actually fetched, which is how the narrowing is observed.
 */
function pack({ collection = "dnd-players-handbook.content", documentName = "JournalEntry",
  system = "dnd5e", entries = [], indexPages = true } = {}) {
  const loaded = [];
  return {
    collection,
    documentName,
    metadata: { system },
    loaded,
    async getIndex() {
      return entries.map(e => (indexPages
        ? { _id: e.id, name: e.name, pages: e.pages.map(p => ({ _id: p.id, name: p.name, type: p.type })) }
        : { _id: e.id, name: e.name }));
    },
    async getDocument(id) {
      loaded.push(id);
      return entries.find(e => e.id === id) ?? null;
    },
    async getDocuments() {
      loaded.push(...entries.map(e => e.id));
      return entries;
    }
  };
}

/** A journal entry stub holding pages. */
function journal(id, name, pages) {
  return { id, name, pages };
}

beforeEach(() => {
  invalidateJournalIndex();
  game.packs = [];
});

/* -------------------------------------------- */

describe("sourcePageFor", () => {
  it("finds the page whose system.item names the class", async () => {
    game.packs = [pack({
      entries: [journal("j1", "Paladin", [page("p1", "class", PALADIN)])]
    })];
    const found = await sourcePageFor({ uuid: PALADIN });
    expect(found?.id).toBe("p1");
  });

  it("finds a subclass page the same way", async () => {
    game.packs = [pack({
      entries: [journal("j1", "Paladin", [
        page("p1", "class", PALADIN),
        page("p2", "subclass", DEVOTION, "Oath of Devotion")
      ])]
    })];
    expect((await sourcePageFor({ uuid: DEVOTION }))?.id).toBe("p2");
  });

  it("loads only the entries the index says hold a class page", async () => {
    const p = pack({
      entries: [
        journal("art", "Art Handout", [page("a1", "image", "")]),
        journal("ch1", "Chapter 1", [page("c1", "text", "")]),
        journal("pal", "Paladin", [page("p1", "class", PALADIN)])
      ]
    });
    game.packs = [p];
    await sourcePageFor({ uuid: PALADIN });
    // The two non-class entries were never fetched — this is the difference between a usable
    // lookup and reading an entire book off disk on the first class click.
    expect(p.loaded).toEqual(["pal"]);
  });

  it("falls back to loading everything when the index carries no page list", async () => {
    const p = pack({
      indexPages: false,
      entries: [
        journal("art", "Art Handout", [page("a1", "image", "")]),
        journal("pal", "Paladin", [page("p1", "class", PALADIN)])
      ]
    });
    game.packs = [p];
    expect((await sourcePageFor({ uuid: PALADIN }))?.id).toBe("p1");
    expect(p.loaded).toEqual(["art", "pal"]);
  });

  it("reads the item's compendium source in preference to its own uuid", async () => {
    // A class *on an actor* has its own actor-scoped uuid; the page names the compendium one.
    game.packs = [pack({ entries: [journal("j1", "Paladin", [page("p1", "class", PALADIN)])] })];
    const onActor = { uuid: "Actor.abc.Item.def", _stats: { compendiumSource: PALADIN } };
    expect((await sourcePageFor(onActor))?.id).toBe("p1");
  });

  it("reports nothing for content with no book page — SRD-only worlds and homebrew", async () => {
    game.packs = [pack({ entries: [journal("j1", "Paladin", [page("p1", "class", PALADIN)])] })];
    expect(await sourcePageFor({ uuid: "Compendium.world.homebrew.Item.myClass" })).toBe(null);
    expect(await sourcePageFor(null)).toBe(null);
    expect(await sourcePageFor({})).toBe(null);
  });

  it("ignores packs that hold something other than journals, or belong to another system", async () => {
    game.packs = [
      pack({ documentName: "Item", entries: [journal("j1", "x", [page("p1", "class", PALADIN)])] }),
      pack({ system: "pf2e", entries: [journal("j2", "y", [page("p2", "class", PALADIN)])] })
    ];
    expect(await sourcePageFor({ uuid: PALADIN })).toBe(null);
  });

  it("survives a pack that cannot be read, keeping the pages from the others", async () => {
    const broken = pack({ collection: "broken.pack" });
    broken.getIndex = async () => { throw new Error("pack offline"); };
    game.packs = [broken, pack({ entries: [journal("j1", "Paladin", [page("p1", "class", PALADIN)])] })];
    expect((await sourcePageFor({ uuid: PALADIN }))?.id).toBe("p1");
  });

  it("scans once and serves every later lookup from the cache", async () => {
    const p = pack({
      entries: [journal("pal", "Paladin", [page("p1", "class", PALADIN), page("p2", "subclass", DEVOTION)])]
    });
    game.packs = [p];
    await sourcePageFor({ uuid: PALADIN });
    await sourcePageFor({ uuid: DEVOTION });
    await sourcePageFor({ uuid: PALADIN });
    expect(p.loaded).toEqual(["pal"]);
  });

  it("rescans after the enabled packages change", async () => {
    game.packs = [pack({ entries: [] })];
    expect(await sourcePageFor({ uuid: PALADIN })).toBe(null);

    // The GM enables the Player's Handbook; the cache must not keep answering "no page".
    invalidateJournalIndex();
    game.packs = [pack({ entries: [journal("j1", "Paladin", [page("p1", "class", PALADIN)])] })];
    expect((await sourcePageFor({ uuid: PALADIN }))?.id).toBe("p1");
  });
});

describe("hasSourcePage", () => {
  it("answers the question a step asks before offering its Full Details control", async () => {
    game.packs = [pack({ entries: [journal("j1", "Paladin", [page("p1", "class", PALADIN)])] })];
    expect(await hasSourcePage(PALADIN)).toBe(true);
    expect(await hasSourcePage("Compendium.world.homebrew.Item.myClass")).toBe(false);
  });
});
