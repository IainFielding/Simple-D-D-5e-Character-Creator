import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import { invalidateSources } from "../scripts/data/source-cache.mjs";
import { findRestrictedItems } from "../scripts/data/choice-resolver.mjs";
import { toolChoices } from "../scripts/data/tool-source.mjs";
import { phbWeaponIcon } from "../scripts/data/weapon-source.mjs";

/**
 * Cache invalidation when the world's enabled compendium sources change.
 *
 * `SourceIndex`, `SpellSource` and friends hang off the shared cache and go with it. Three memos do
 * not — they live at module scope in their own files — and all three are built by scanning the
 * *enabled* packs: the `allowDrops` restriction scan, the tool-category expansion, and the PHB
 * weapon-icon map. Each test below primes one against a pack set, changes which packs are enabled,
 * and checks that the memo is still there (proving it is a memo at all) and that
 * `invalidateSources()` clears it — otherwise a GM switching a pack off keeps being offered its
 * content for the rest of the session.
 */
describe("enabled-source invalidation", () => {

  /** A stand-in compendium pack whose index is a fixed entry list. */
  function pack(collection, entries) {
    return {
      collection,
      visible: true,
      documentName: "Item",
      metadata: { type: "Item", system: "dnd5e" },
      getIndex: async () => entries
    };
  }

  /** Switch off exactly the named packs, as dnd5e's source configuration records it. */
  function disable(...collections) {
    game.settings._values.packSourceConfiguration =
      Object.fromEntries(collections.map(c => [c, false]));
  }

  beforeEach(() => {
    installFoundryShims();
    invalidateSources();
  });

  /* -------------------------------------------- */

  it("re-scans allowDrops pools after the enabled set changes", async () => {
    const feat = (id, name) => ({ uuid: `Compendium.${id}.Item.x`, name, type: "feat", img: "", system: {} });
    game.packs = [
      pack("mod-a.feats", [feat("mod-a.feats", "Feat A")]),
      pack("mod-b.feats", [feat("mod-b.feats", "Feat B")])
    ];
    const cfg = { type: "feat", restriction: {} };

    disable("mod-b.feats");
    expect((await findRestrictedItems(cfg)).map(r => r.label)).toEqual(["Feat A"]);

    // The scan is memoised, so flipping the configuration alone changes nothing...
    disable("mod-a.feats");
    expect((await findRestrictedItems(cfg)).map(r => r.label)).toEqual(["Feat A"]);

    // ...until the cache is invalidated, which is what the shells do on a staleness check.
    invalidateSources();
    expect((await findRestrictedItems(cfg)).map(r => r.label)).toEqual(["Feat B"]);
  });

  it("re-fetches tool categories after the enabled set changes", async () => {
    // Tool choices come through the Compendium Browser, which applies the source configuration
    // itself — so the stand-in filters on the same setting the real one honours.
    const tool = (collection, name, baseItem) => ({
      uuid: `Compendium.${collection}.Item.${baseItem}`, name, img: "",
      system: { type: { value: "art", baseItem } }
    });
    const all = [tool("mod-a.tools", "Alchemist's Supplies", "alchemist"),
      tool("mod-b.tools", "Brewer's Supplies", "brewer")];
    dnd5e.applications = {
      CompendiumBrowser: {
        fetch: async () => {
          const off = game.settings._values.packSourceConfiguration ?? {};
          return all.filter(e => off[e.uuid.split(".").slice(1, 3).join(".")] !== false);
        }
      }
    };

    disable("mod-b.tools");
    expect((await toolChoices("art")).map(c => c.baseItem)).toEqual(["alchemist"]);

    disable("mod-a.tools");
    expect((await toolChoices("art")).map(c => c.baseItem)).toEqual(["alchemist"]);

    invalidateSources();
    expect((await toolChoices("art")).map(c => c.baseItem)).toEqual(["brewer"]);
  });

  it("rebuilds the PHB weapon-icon map after the enabled set changes", async () => {
    game.packs = [pack("dnd-players-handbook.equipment", [{
      name: "Longsword", type: "weapon", img: "phb/longsword.webp",
      system: { type: { baseItem: "longsword" } }
    }])];

    expect(await phbWeaponIcon("weapon:mar:longsword")).toBe("phb/longsword.webp");

    // A PHB present but switched off must stop supplying art — but only once invalidated.
    disable("dnd-players-handbook.equipment");
    expect(await phbWeaponIcon("weapon:mar:longsword")).toBe("phb/longsword.webp");

    invalidateSources();
    expect(await phbWeaponIcon("weapon:mar:longsword")).toBeNull();
  });
});
