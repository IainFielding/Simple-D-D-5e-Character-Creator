import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFoundryShims } from "./helpers/foundry-shims.mjs";
import {
  MIN_PDF_VERSION, exportApi, exportCharacterPdf, pdfExportAvailable, pdfExportContext,
  sheetLayoutFor
} from "../scripts/build/pdf-export.mjs";

/**
 * The bridge to a companion module that can print an official character sheet.
 *
 * Everything worth testing here is about *not being there*. The whole feature is optional, and the
 * ways it can be absent are more numerous than the ways it can be present: not installed,
 * installed but disabled, installed but too old to expose anything, present but still starting up.
 * Each of those has to end in the control simply not rendering, never a thrown error inside
 * somebody's character build.
 *
 * The second group is the layout choice. A 2014 character on a 2024 sheet is a sheet with the
 * wrong boxes on it, so which edition the character was built to is read off the class — the same
 * thing that decides the edition everywhere else in this module.
 *
 * Nothing here exercises the PDF itself. Producing one is the other module's job, and a test that
 * mocked its way to a byte array would be asserting our own mock.
 */

/** Install a fake companion module at a given version, with a given API (or none). */
function installPdfModule({ version = "2.2.0", active = true, api = {} } = {}) {
  game.modules = {
    get: id => (id === "sogrom-dnd5e-character-sheet-pdf" ? { active, version, api } : null)
  };
  return api;
}

/** An actor whose only class declares (or doesn't) a rules edition. */
const actorWithRules = rules => ({
  items: [{ type: "class", system: { source: rules === undefined ? {} : { rules } } }]
});

beforeEach(() => {
  installFoundryShims();
  globalThis.ui = { notifications: { warn: () => {} } };
});

describe("whether a sheet can be produced at all", () => {
  it("says no when the module isn't installed", () => {
    expect(exportApi()).toBeNull();
    expect(pdfExportAvailable()).toBe(false);
  });

  it("says no when it is installed but disabled", () => {
    installPdfModule({ active: false });
    expect(pdfExportAvailable()).toBe(false);
  });

  it("says no below the version that first published an API", () => {
    installPdfModule({ version: "2.1.9" });
    expect(pdfExportAvailable()).toBe(false);
  });

  it("says yes at exactly the minimum version, and above it", () => {
    installPdfModule({ version: MIN_PDF_VERSION });
    expect(pdfExportAvailable()).toBe(true);
    installPdfModule({ version: "3.0.0" });
    expect(pdfExportAvailable()).toBe(true);
    // A shorter version string is not a smaller one: 2.2 is 2.2.0.
    installPdfModule({ version: "2.2" });
    expect(pdfExportAvailable()).toBe(true);
  });

  it("says no when a new enough module hasn't published its API yet", () => {
    installPdfModule({ api: null });
    expect(pdfExportAvailable()).toBe(false);
  });

  it("survives a version string it cannot read", () => {
    installPdfModule({ version: "not-a-version" });
    expect(() => pdfExportAvailable()).not.toThrow();
    expect(pdfExportAvailable()).toBe(false);
  });
});

describe("the control on the review screens", () => {
  it("is offered, and can be switched on, once a module can print", () => {
    installPdfModule();
    const ctx = pdfExportContext(true, "pdfExport.noteCreation");
    expect(ctx.active).toBe(true);
    expect(ctx.note).toContain("pdfExport.noteCreation");
  });

  it("says when the sheet will be produced, which differs between the two wizards", () => {
    installPdfModule();
    expect(pdfExportContext(false, "pdfExport.noteLevelUp").note).toContain("pdfExport.noteLevelUp");
  });

  it("is not rendered at all when nothing can print", () => {
    // Null, not a disabled view-model: the template's one guard drops the whole block, so a
    // player with no PDF module sees the review screen exactly as it read before the feature.
    expect(pdfExportContext(true, "pdfExport.noteCreation")).toBeNull();
    installPdfModule({ version: "2.1.9" });
    expect(pdfExportContext(true, "pdfExport.noteCreation")).toBeNull();
  });
});

describe("which sheet layout suits the character", () => {
  it("reads the edition off the class", () => {
    expect(sheetLayoutFor(actorWithRules("2014"))).toBe("2014");
    expect(sheetLayoutFor(actorWithRules("2024"))).toBe("2024");
  });

  it("normalises an edition stored as a number", () => {
    expect(sheetLayoutFor(actorWithRules(2024))).toBe("2024");
  });

  it("yields nothing for content that declares no edition, rather than guessing one", () => {
    expect(sheetLayoutFor(actorWithRules(undefined))).toBeNull();
    expect(sheetLayoutFor(actorWithRules(""))).toBeNull();
    expect(sheetLayoutFor({ items: [] })).toBeNull();
    expect(sheetLayoutFor(null)).toBeNull();
  });
});

describe("asking for the sheet", () => {
  const templates = [{ key: "2014" }, { key: "2024" }];

  /** A companion API recording what it was asked for. */
  function fakeApi({ availableKeys = ["2014", "2024"] } = {}) {
    return {
      getTemplates: () => templates,
      isTemplateAvailable: key => availableKeys.includes(key),
      generatePdf: vi.fn(async () => ({ downloaded: true })),
      promptPdf: vi.fn(async () => ({ downloaded: true }))
    };
  }

  it("does nothing, quietly, when nothing can print", async () => {
    await expect(exportCharacterPdf(actorWithRules("2024"))).resolves.toBe(false);
  });

  it("prints a 2014 character on the 2014 sheet", async () => {
    const api = fakeApi();
    installPdfModule({ api });
    await exportCharacterPdf(actorWithRules("2014"));
    expect(api.generatePdf).toHaveBeenCalledWith(expect.anything(), { template: "2014" });
  });

  it("leaves the layout to the other module when the character declares no edition", async () => {
    const api = fakeApi();
    installPdfModule({ api });
    await exportCharacterPdf(actorWithRules(undefined));
    // No template named, so it falls back to whichever the user last used.
    expect(api.generatePdf).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("ignores an edition the other module has no layout for", async () => {
    const api = fakeApi();
    installPdfModule({ api });
    await exportCharacterPdf(actorWithRules("1977"));
    expect(api.generatePdf).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("asks the user for a sheet they have never supplied, pre-set to the one needed", async () => {
    const api = fakeApi({ availableKeys: ["2024"] });
    installPdfModule({ api });
    await exportCharacterPdf(actorWithRules("2014"));
    expect(api.generatePdf).not.toHaveBeenCalled();
    expect(api.promptPdf).toHaveBeenCalledWith(expect.anything(), { template: "2014" });
  });

  it("never lets a failed export throw into the build that called it", async () => {
    installPdfModule({
      api: { getTemplates: () => templates, isTemplateAvailable: () => true,
        generatePdf: async () => { throw new Error("boom"); } }
    });
    await expect(exportCharacterPdf(actorWithRules("2024"))).resolves.toBe(false);
  });

  it("survives an API that has changed shape underneath it", async () => {
    installPdfModule({ api: {} });
    await expect(exportCharacterPdf(actorWithRules("2024"))).resolves.toBe(false);
  });
});
