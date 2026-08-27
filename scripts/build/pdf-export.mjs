import { log, t } from "../config.mjs";

/**
 * Handing a finished character to a companion module that can print it onto an official
 * character-sheet PDF.
 *
 * The sheets themselves are copyrighted, so no module can ship them — a user supplies their own
 * copy and the printing module fills it in. That is a whole problem of its own (form-field maps
 * per layout, font fallbacks, a place to keep the user's file), and it is not this module's
 * problem: we know what a character is, not what a PDF is. So this file is a *bridge*. It asks
 * whether a module able to do the printing is present, tells it which layout suits the character,
 * and gets out of the way.
 *
 * Everything here is optional by construction. With no such module installed the export control is
 * not rendered at all, and nothing else in the creator changes — the review screens read exactly as
 * they did before the feature existed.
 *
 * For a junior dev: never import from the other module. The only contract is the object it hangs
 * off its own module entry, reached through {@link exportApi}; treating anything else as available
 * would couple us to its internals and break the moment it reorganises.
 */

/** The module id of the companion that owns PDF generation. */
export const PDF_MODULE_ID = "sogrom-dnd5e-character-sheet-pdf";

/**
 * The first version of that module that published an integration API. Earlier releases do the same
 * job through their own UI but expose nothing to call, so to us they are indistinguishable from
 * the module being absent — hence a version floor rather than a plain "is it active" check.
 */
export const MIN_PDF_VERSION = "2.2.0";

/**
 * Compare two dotted version strings, so `a >= b` can be asked without assuming Foundry's helper
 * is present (it isn't under the test runner). Missing segments count as zero, and a non-numeric
 * segment sorts as zero rather than throwing — a version string we can't read should cost the
 * player the export button, not the window.
 * @returns {boolean}  Whether `a` is at least `b`.
 */
function atLeastVersion(a, b) {
  const parse = v => String(v ?? "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for ( let i = 0; i < Math.max(left.length, right.length); i++ ) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if ( diff !== 0 ) return diff > 0;
  }
  return true;
}

/**
 * The companion module's published API, or null when it can't be used — not installed, not
 * enabled, too old to have one, or present but not yet initialised.
 * @returns {object|null}
 */
export function exportApi() {
  const module = game.modules?.get(PDF_MODULE_ID);
  if ( !module?.active ) return null;
  if ( !atLeastVersion(module.version, MIN_PDF_VERSION) ) return null;
  return module.api ?? null;
}

/** Whether a sheet PDF can be produced right now. @returns {boolean} */
export function pdfExportAvailable() {
  return !!exportApi();
}

/**
 * The view-model for the export control on either review screen, or **null when there is nothing
 * that could print a sheet** — in which case the template renders no control at all.
 *
 * Hidden rather than disabled, deliberately. A player with no PDF module installed is not deciding
 * whether to export; they have no such decision to make, and a permanently dead control on the
 * last screen before Create is one more thing to read past. The review screen reads exactly as it
 * did before the feature existed.
 * @param {boolean} active    Whether the player has asked for a PDF.
 * @param {string} noteKey    i18n key for the line under the control saying when the sheet will
 *                            be produced — the two wizards finish at different moments.
 * @returns {{active: boolean, tooltip: string, note: string}|null}
 */
export function pdfExportContext(active, noteKey) {
  if ( !pdfExportAvailable() ) return null;
  return {
    active: !!active,
    note: t(noteKey),
    tooltip: t("pdfExport.tooltip")
  };
}

/**
 * Which sheet layout suits this character: `"2014"` or `"2024"`.
 *
 * Read off the class, because the class is what decides a build's edition everywhere else in this
 * module — the origin grids scope to it, the advancement choices scope to it — and the two sheets
 * differ in exactly the places the two rule sets do. A multiclass character is read from its first
 * class item, which is the one that started the build.
 *
 * Content that declares no edition (homebrew and third-party packs frequently don't) yields null,
 * and the caller falls back to the companion module's own default rather than guessing.
 * @param {Actor5e} actor
 * @returns {string|null}
 */
export function sheetLayoutFor(actor) {
  const classItem = actor?.items?.find(i => i.type === "class");
  const rules = classItem?.system?.source?.rules;
  return (rules == null) || (rules === "") ? null : String(rules);
}

/**
 * Produce and download a character-sheet PDF, matching the layout to the character's edition.
 *
 * Two ways this can go, and both are handled here rather than pushed onto the caller:
 *  - The layout is ready (the user has supplied that official sheet) — generate it straight to
 *    their downloads folder.
 *  - It isn't — open the companion module's own window, which is the only thing that can walk them
 *    through supplying the file. Asking them for it ourselves would mean reimplementing a flow
 *    that already exists, and storing the answer somewhere the module that needs it can't read.
 *
 * Never throws. A character that was built must not appear to have failed because a PDF didn't
 * print, so every failure is reported to the player as a notification and swallowed here.
 * @param {Actor5e} actor
 * @returns {Promise<boolean>}  Whether a sheet was generated.
 */
export async function exportCharacterPdf(actor) {
  const api = exportApi();
  if ( !api || !actor ) return false;
  try {
    const layout = sheetLayoutFor(actor);
    // An edition we can't read, or one that module doesn't have a layout for, falls through to
    // whichever the user last used — a wrong-but-printable sheet beats a refusal to print.
    const known = layout && api.getTemplates?.().some(entry => entry.key === layout);
    const template = known ? layout : undefined;
    if ( template && !api.isTemplateAvailable?.(template) ) {
      // They have never supplied this official sheet. Pre-select the layout the character needs so
      // the window opens on the right one instead of on whatever they used last.
      const result = await api.promptPdf(actor, { template });
      return !!result;
    }
    const result = await api.generatePdf(actor, template ? { template } : {});
    return !!result;
  } catch ( err ) {
    // The companion module reports its own failures; this catches the ones it can't, such as the
    // API changing shape under us.
    log("pdf export failed", err);
    ui.notifications?.warn(t("pdfExport.failed"));
    return false;
  }
}
