import { log } from "../config.mjs";
import { sourcePageFor } from "../data/journal-source.mjs";

/**
 * Rendering a class or subclass's own page from the source book, inside our window.
 *
 * dnd5e already knows how to present one: `JournalClassPageSheet` builds the progression table, the
 * per-level features with their enriched descriptions, the starting equipment, and (for a class) a
 * summary of each subclass, then renders `templates/journal/page-{class|subclass}-view.hbs`. Rather
 * than reproduce any of that — or copy book text into the module — we borrow the sheet's own
 * prepared context and its own template, and drop the resulting HTML into our overlay.
 *
 * **Styling is the fragile join**, and it is not dnd5e's alone. The system scopes its journal rules
 * under `.sheet.dnd5e2-journal` and its palette under `.themed.theme-dark.dnd5e2`, and each content
 * package layers its own on top: the Player's Handbook registers a JournalEntry sheet carrying
 * `phb` and keys every colour off `.theme-dark.phb` / `.theme-light.phb`. Hardcoding that list would
 * style the PHB and nothing else, so {@link bodyClasses} reads the classes off the live sheet
 * options for the page *and its parent journal* — which is exactly where a package declares them —
 * and hands them to the wrapper. A third-party book therefore styles its own page here the same way
 * it does in Foundry, without us knowing anything about it.
 *
 * Any failure degrades rather than breaks: it falls back to the item's own enriched description,
 * which is what the detail pane already shows.
 *
 * This approach was taken from **Character Builder (DnD 5e)** by Raphael Andrade (MIT).
 */

/**
 * Build the overlay payload for a class or subclass item.
 *
 * @param {Item5e} item   The class or subclass whose book page is wanted.
 * @returns {Promise<{name: string, img: string, pageName: string, html: string, fallback: boolean}|null>}
 *   `null` when there is nothing worth showing — the caller then leaves its control hidden.
 */
export async function sourceDetails(item) {
  if ( !item ) return null;
  const page = await sourcePageFor(item);

  let html = "";
  if ( page ) {
    try { html = await renderSourcePage(page); }
    catch ( err ) { log(`could not render the source page for ${item.name}`, err); }
  }

  const fallback = !html;
  if ( fallback ) html = await enrich(item.system?.description?.value ?? "", item);
  if ( !html ) return null;

  return {
    name: item.name ?? "",
    img: item.img ?? "icons/svg/book.svg",
    pageName: page?.name ?? "",
    pageType: page?.type ?? "",
    bodyClasses: bodyClasses(page),
    html,
    fallback
  };
}

/**
 * Build the overlay payload for a plain rulebook page (see {@link module:data/rules-source}).
 *
 * Unlike a class or subclass page, these carry no dnd5e view template — they are ordinary text
 * pages — so the body is the page's own enriched content rather than a rendered sheet. Everything
 * else (the wrapper classes that let the book's stylesheet reach it, the overlay shape) is shared
 * with {@link sourceDetails}, so the two open into the same overlay and look like one feature.
 * @param {JournalEntryPage} page
 * @returns {Promise<{name: string, img: string, pageName: string, html: string, fallback: boolean}|null>}
 *   `null` when the page has no content worth showing.
 */
export async function rulesDetails(page) {
  if ( !page ) return null;
  const html = await enrich(page.text?.content ?? "", page);
  if ( !html ) return null;

  return {
    // The book's own name heads the overlay — the page name alone ("Step 1: Choose a Class") reads
    // as one of our own step labels rather than as something quoted from a rulebook.
    name: page.parent?.name ?? page.name ?? "",
    img: "icons/svg/book.svg",
    pageName: page.name ?? "",
    pageType: page.type ?? "",
    bodyClasses: bodyClasses(page),
    html,
    fallback: false
  };
}

/**
 * The class list the rendered page needs on its wrapper for the system's and the content package's
 * stylesheets to reach it.
 *
 * Three sources, in the order they matter:
 *  - the **page's own sheet** and **its parent journal's sheet** — this is where a package declares
 *    its hook (`classes: ["phb"]` on the Player's Handbook's `JournalEntrySheet5e` subclass), and
 *    where dnd5e declares `dnd5e2` / `dnd5e2-journal`;
 *  - `sheet` and `journal-entry-page`, which dnd5e's own selectors open with and which belong to the
 *    window frame we are not rendering. They go on a child of our scroll container, never on it:
 *    `.journal-entry-page.sheet.class` carries `min-block-size: 600px`, which on the scroll
 *    container itself breaks the height chain and leaves the page clipped with no way to scroll;
 *  - the theme. Pinned dark rather than following the reader's Foundry setting, because the surface
 *    underneath is ours and is always dark — the book's light palette puts near-black body text on
 *    our black panel. `themed` is what promotes the theme class from an ancestor rule to this
 *    element (`.themed.theme-dark.dnd5e2`), and the package selectors that exclude it
 *    (`.theme-dark .phb:not(.themed)`) have a same-element twin (`.theme-dark.phb`) that still hits.
 *
 * @param {JournalEntryPage|null} page
 * @returns {string}
 */
function bodyClasses(page) {
  const classes = new Set(["sheet", "journal-entry-page", "themed", "theme-dark"]);
  for ( const sheet of [page?.parent?.sheet, page?.sheet] ) {
    for ( const name of sheet?.options?.classes ?? [] ) classes.add(name);
  }
  if ( page?.type ) classes.add(page.type);
  return [...classes].join(" ");
}

/**
 * Render one class/subclass Journal page through dnd5e's own view template.
 * @param {JournalEntryPage} page
 * @returns {Promise<string>}
 */
async function renderSourcePage(page) {
  const sheet = page.sheet;
  if ( !sheet?._prepareContext ) return "";
  const context = await sheet._prepareContext({ isFirstRender: true });
  const renderTemplate = foundry.applications.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  if ( typeof renderTemplate !== "function" ) return "";
  return renderTemplate(`systems/dnd5e/templates/journal/page-${page.type}-view.hbs`, context);
}

/** Enrich raw item description HTML, falling back to the raw text if enrichment fails. */
async function enrich(raw, relativeTo) {
  const text = String(raw ?? "").trim();
  if ( !text ) return "";
  try {
    return await foundry.applications.ux.TextEditor.implementation.enrichHTML(text, {
      relativeTo, secrets: false
    });
  } catch ( err ) {
    log("could not enrich a source description", err);
    return text;
  }
}
