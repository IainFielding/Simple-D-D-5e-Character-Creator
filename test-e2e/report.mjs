/**
 * Turn `sweep-results.jsonl` into a self-contained HTML triage report.
 *
 *   node report.mjs                    # -> sweep-report.html
 *   node report.mjs --in other.jsonl --out other.html
 *   node report.mjs --watch            # regenerate every 30s while a sweep is running
 *   node report.mjs --expect 122       # show progress against a known total
 *
 * `--watch` is for reading a run in flight: results stream into the jsonl one scenario at a time, so
 * a report built mid-run is simply a report of what has finished. The page auto-refreshes itself
 * while it is incomplete and stops once `--expect` is reached, so a finished run does not keep
 * reloading in a tab left open overnight.
 *
 * The console output of a sweep is a progress log: fine for watching, useless for
 * triage. Ninety-two scenarios each carrying a dozen differences is a thousand rows, and
 * essentially all of them are the same handful of causes repeated — the interesting question is
 * never "what differs on the Alchemist" but "what differs, and how much of the content does it
 * reach". So the report groups by a **normalised signature**: the difference path with the item
 * identity, advancement id and array index taken out, which is as close to "root cause" as a path
 * can get. One row per cause, ordered by how many subclasses it touches.
 *
 * Two things it deliberately collapses, because both inflate a small cause into a big-looking one:
 *
 *   • Positional array diffs. `derived.itemsByType.spell[6..12]` is one missing spell shifting
 *     every later index, not seven differences.
 *   • Per-item repeats. `flags.dnd5e.riders` on nine items is one cause, not nine.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const inPath = new URL(value("in", "./sweep-results.jsonl"), import.meta.url);
const outPath = new URL(value("out", "./sweep-report.html"), import.meta.url);

if ( !existsSync(inPath) ) throw new Error(`no results at ${inPath.pathname} — run \`node run.mjs --sweep\` first`);

const reports = readFileSync(inPath, "utf8").split("\n").filter(Boolean).map((line, i) => {
  try { return JSON.parse(line); } catch { throw new Error(`line ${i + 1} of the results file is not JSON`); }
});

/* -------------------------------------------- */
/*  Signatures                                   */
/* -------------------------------------------- */

/** A Foundry document id, and the compendium-uuid shape the normaliser keys items by. */
const ID_RE = /^[A-Za-z0-9]{16}$/;

/**
 * Reduce a difference path to its cause.
 *
 * `source.items.Compendium.dnd5e.feats24.Item.phbftAlert000000.flags.dnd5e.riders`
 *   -> `source.items.*.flags.dnd5e.riders`
 * `source.items.Compendium.dnd5e.spells24.Item.phbsplLesserRest`
 *   -> `source.items.* (item on one side only)`
 * `derived.itemsByType.spell[6]`      -> `derived.itemsByType.spell[]`
 * `decision.raised.Trait.aBcD…@3`     -> `decision.raised.Trait`
 */
function signature(path) {
  if ( path.startsWith("decision.") ) return path.split(".").slice(0, 3).join(".");

  if ( path.startsWith("source.items.") ) {
    const parts = path.slice("source.items.".length).split(".");
    // The item identity is a 5-segment compendium uuid (`Compendium.<scope>.<pack>.Item.<id>`, with
    // a `#2` occurrence suffix when a build holds the same item twice), or one `local:type:name`.
    const idLen = (parts[0] === "Compendium") ? 5 : 1;
    const rest = parts.slice(idLen);
    if ( !rest.length ) return "source.items.* (whole item on one side only)";
    return `source.items.*.${generalise(rest.join("."))}`;
  }
  return generalise(path);
}

/** Replace document ids with `*` and array indices with `[]` (the diff already emits a bare `[]`). */
function generalise(path) {
  // A uuid can appear as a *key* rather than a path segment — `value.added` is a map keyed by the
  // granted item's uuid, so its entries arrive as
  // `…value.added.Compendium.dnd-players-handbook.spells.Item.phbsplHuntersMar#2`. Collapsing those
  // first is what keeps one cause from splitting into one row per spell it happened to touch, which
  // is the whole point of grouping by signature.
  const collapsed = path.replace(/Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]+(#\d+)?/g, "*");
  return collapsed.split(".").map(p => {
    const bare = p.replace(/\[\d*\]$/, "").replace(/#\d+$/, "");
    return (ID_RE.test(bare) ? "*" : bare) + (p.endsWith("]") ? "[]" : "");
  }).join(".");
}

/* -------------------------------------------- */
/*  Aggregation                                  */
/* -------------------------------------------- */

const total = reports.length;
const passed = reports.filter(r => r.ok).length;
const errored = reports.filter(r => r.error).length;
const differing = total - passed - errored;
const totalRows = reports.reduce((n, r) => n + (r.differences?.length ?? 0), 0);

const causes = new Map();
for ( const r of reports ) {
  for ( const d of r.differences ?? [] ) {
    const sig = signature(d.path);
    let cause = causes.get(sig);
    if ( !cause ) causes.set(sig, cause = { sig, rows: 0, scenarios: new Set(), samples: [] });
    cause.rows++;
    cause.scenarios.add(r.id);
    if ( cause.samples.length < 3 ) cause.samples.push({ id: r.id, ...d });
  }
}
const ranked = [...causes.values()].sort((a, b) =>
  (b.scenarios.size - a.scenarios.size) || (b.rows - a.rows) || a.sig.localeCompare(b.sig));

/**
 * Causes already understood and written up in the README.
 *
 * Marking them is the difference between a report you read once and one you can re-read every run:
 * a sweep where the only rows are documented ones is a *clean* sweep, and without the label that
 * reads identically to a sweep full of new problems. The note is the one-line version — the README
 * is the source of truth, and "documented" never means "ignore".
 */
const KNOWN = [
  // `flags.dnd5e.riders` used to head this list at 91/92. The normaliser now drops it when it holds
  // no rider, which is what it always held — see `normalize.mjs`. If it reappears here it is
  // carrying content, and that is a finding rather than a documented nuisance.
  // Artificer Battle Smith, and the only difference left in the sweep. dnd5e's mid-walk synthesis
  // misses an advancement at level N on a feature *granted* at level N, so the native reference is
  // short two spells the content gives a level-3 Battle Smith. Ours is the correct character, and
  // the dnd5e maintainers have confirmed it as a known issue with a fix in progress — so this
  // should disappear on a system update rather than needing anything here.
  // Two distinct upstream bugs share these signatures, and both are known to the dnd5e maintainers:
  // the Battle Smith missed grant, and — on an `--incremental` run — a Cast-activity cached spell
  // the native build deletes at a later level (Winter Walker, Alchemist).
  { sig: "source.items.* (whole item on one side only)",
    note: "An item present on one build only, and in both known cases it is the *reference* that is "
      + "short: Battle Smith's level-3 grant is never applied, and on an incremental run native "
      + "deletes a Cast-activity cached spell at a later level. Both known dnd5e issues. See the "
      + "README before assuming the direction — it is not the one the diff suggests." },
  { sig: "source.items.*.system.advancement.*.value.added",
    note: "The empty `value.added` behind the same Battle Smith grant." },
  { sig: "derived.itemsByType.spell[]",
    note: "The spells above, seen from the derived side." },
  { sig: "source.items.*.system.source.book",
    note: "Open, and order-dependent across scenarios — creator \"SRD 5.2\", native empty." },
  { sig: "derived.itemsByType.spell[]",
    note: "Positional: the lists are compared index by index, so one missing entry shifts every "
      + "later one. Read the count of *items* on either side, not the number of rows." },
  { sig: "derived.itemsByType.feat[]", note: "Positional — see the spell list note." },

  // Added after the Tasha's work, when the sweep reached 2014-rules content and two new axes. Each
  // of these was chased to a cause and written up; they are here so a clean run reads as clean.
  { sig: "source.items.*.flags.dnd5e.advancementOrigin",
    note: "Which advancement is recorded as having granted an item. Travels with the cached-spell "
      + "and duplicate-pairing causes above rather than being a cause of its own." },
  { sig: "source.items.*.flags.dnd5e.advancementRoot",
    note: "As `advancementOrigin` — the same item, seen from its root." },
  { sig: "source.items.*.flags.dnd5e.sourceId",
    note: "As `advancementOrigin`; appears when the two builds create a duplicate pair in opposite "
      + "order, so the normaliser numbers them the other way round." },
  { sig: "source.items.*.effects[]",
    note: "An enchantment effect (\"Spell Changes\") on the copy one build holds and the other does "
      + "not — part of the upstream cached-spell drop, not a difference of its own. Clean-room "
      + "confirmed." },
  { sig: "source.actor.system.attributes.hp.value",
    note: "Current hit points, with a per-level maximum-HP bonus in play (Dwarven Toughness, the "
      + "Tough feat). Measured against `hp.max`, ours sits *at* maximum and the native reference "
      + "ends above it, by exactly the bonus. The reference is the unreliable side here." },
  { sig: "source.actor.system.details.race",
    note: "Set from `RaceData._onCreate`, which dnd5e does not await, while the manager writes null "
      + "concurrently — the same race as `system.details.background`. Ours is the correct value." },
  { sig: "source.actor.system.traits.languages.value[]",
    note: "A language the class grants and a background also offers. Our cross-source dedupe declines "
      + "to spend the background's pick on it and reopens the slot; native spends it. Same languages "
      + "either way — bookkeeping, and deliberately ours. See the Thieves' Cant section." },
  { sig: "derived.traits.languages[]", note: "The languages above, seen from the derived side." },
  { sig: "source.items.*.system.advancement.*.value.chosen[]",
    note: "The recorded picks behind the language note above." },
  { sig: "source.items.*.flags.dnd5e.cachedFor",
    note: "The flag marking a Cast-activity cached spell — the copy the native build deletes at a "
      + "later level. Travels with that cause." },
  { sig: "source.items.*.system.advancement.*.value.added.*",
    note: "Individual entries of the `value.added` map — the uuid sits in the key, so these are one "
      + "row per item the cause touched rather than a cause of their own." },
  { sig: "source.items.*.system.prepared",
    note: "A cached spell sits at `prepared: 0`; this appears wherever one build holds that copy and "
      + "the other does not. Travels with the cached-spell cause." },
  { sig: "source.items.*.system.sourceItem",
    note: "Which feature a spell is attributed to. Appears where one build holds a copy the other "
      + "lost, so the normaliser lines the granted copy up against the cached one — pairing noise "
      + "downstream of the cached-spell drop, not an attribution disagreement." },
  { sig: "source.items.*.flags.dnd5e.riders.effect",
    note: "The partial form of the empty-riders flag the driver now clears on update. One item, and "
      + "empty on both sides — see the riders note in the README." },
  { sig: "decision.offered.Trait",
    note: "A Trait pool one side offered and the other did not — reported rather than silently "
      + "answered. Currently the expertise pools, where a tool key (thieves' tools on a 2014 Rogue) "
      + "is legal on one path and not the other." }
];
for ( const c of ranked ) c.known = KNOWN.find(k => k.sig === c.sig) ?? null;

const newCauses = ranked.filter(c => !c.known);

// Errors are their own kind of finding — a scenario that threw produced no differences at all.
const errors = new Map();
for ( const r of reports.filter(x => x.error) ) {
  const first = String(r.error).split("\n")[0].replace(/^Error:\s*/, "");
  // Strip the variable parts so two scenarios failing the same way group together.
  const key = first.replace(/"[^"]*"/g, '"…"').replace(/Compendium\.[\w.-]+/g, "…");
  const entry = errors.get(key) ?? { key, scenarios: [], sample: first };
  entry.scenarios.push(r.id);
  errors.set(key, entry);
}

/** `sweep:wizard/evoker` -> `{ cls: "wizard", sub: "evoker" }`. */
function split(id) {
  const m = /^sweep:([^/]+)\/(.+)$/.exec(id);
  return m ? { cls: m[1], sub: m[2] } : { cls: "?", sub: id };
}

const byClass = new Map();
for ( const r of reports ) {
  const { cls, sub } = split(r.id);
  const list = byClass.get(cls) ?? [];
  list.push({
    sub, id: r.id, ms: r.ms,
    state: r.error ? "error" : (r.ok ? "pass" : "fail"),
    count: r.differences?.length ?? 0
  });
  byClass.set(cls, list);
}
const classes = [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0]));

/* -------------------------------------------- */
/*  Rendering                                    */
/* -------------------------------------------- */

const esc = s => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Difference values carry whole item bodies; show enough to recognise, not enough to drown in. */
const clip = (s, n = 180) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const maxScenarios = ranked[0]?.scenarios.size ?? 1;

const STATE = {
  pass: { label: "identical", icon: "✓" },
  fail: { label: "differing", icon: "▲" },
  error: { label: "errored", icon: "✕" }
};

// Progress against an expected total, for a report generated while the sweep is still running.
const expected = Number(value("expect", 0)) || 0;
const inFlight = expected > total;
const elapsedMin = Math.round(reports.reduce((n, r) => n + (r.ms ?? 0), 0) / 60000);
const etaMin = (inFlight && total) ? Math.round((elapsedMin / total) * (expected - total)) : 0;

const tiles = [
  { label: inFlight ? "Run so far" : "Subclasses run",
    value: inFlight ? `${total}/${expected}` : total,
    note: inFlight ? `still running · ~${etaMin} min left` : `${totalRows} difference rows` },
  { label: "Identical", value: passed, state: "pass" },
  { label: "Differing", value: differing, state: "fail" },
  { label: "Errored", value: errored, state: "error" },
  { label: "Undocumented causes", value: newCauses.length, state: newCauses.length ? "fail" : "pass",
    note: `of ${ranked.length} total` }
];

const html = `<title>dnd5e subclass sweep — level 20 equivalence</title>
${inFlight ? '<meta http-equiv="refresh" content="30">' : ""}
<style>
  .root {
    color-scheme: light;
    --surface: #fcfcfb; --plane: #f9f9f7;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --rule: #e1e0d9; --ring: rgba(11,11,11,0.10);
    --bar: #2a78d6; --bar-track: #e1e0d9;
    --good: #0ca30c; --critical: #d03b3b; --serious: #ec835a;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .root {
      color-scheme: dark;
      --surface: #1a1a19; --plane: #0d0d0d;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --rule: #2c2c2a; --ring: rgba(255,255,255,0.10);
      --bar: #3987e5; --bar-track: #2c2c2a;
    }
  }
  :root[data-theme="dark"] .root {
    color-scheme: dark;
    --surface: #1a1a19; --plane: #0d0d0d;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --rule: #2c2c2a; --ring: rgba(255,255,255,0.10);
    --bar: #3987e5; --bar-track: #2c2c2a;
  }

  .root {
    background: var(--plane); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 32px 20px 64px; min-height: 100vh;
  }
  .wrap { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 650; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--ink-2); margin: 0 0 28px; }
  h2 { font-size: 15px; font-weight: 650; margin: 36px 0 6px; letter-spacing: 0.02em; text-transform: uppercase; }
  h2 + p { color: var(--ink-2); margin: 0 0 14px; font-size: 14px; }

  .tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 14px 16px; }
  .tile .v { font-size: 34px; font-weight: 620; line-height: 1.1; }
  .tile .l { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
  .tile .n { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .s-pass .v { color: var(--good); } .s-fail .v { color: var(--serious); } .s-error .v { color: var(--critical); }

  .card { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; overflow: hidden; }
  details { border-bottom: 1px solid var(--rule); }
  details:last-child { border-bottom: 0; }
  summary { display: grid; grid-template-columns: 1fr 132px 56px; gap: 14px; align-items: center;
            padding: 11px 16px; cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
  summary:focus-visible { outline: 2px solid var(--bar); outline-offset: -2px; }
  .sig { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-word; }
  .chip { font-family: system-ui, sans-serif; font-size: 11px; letter-spacing: 0.04em;
          text-transform: uppercase; color: var(--muted); border: 1px solid var(--rule);
          border-radius: 999px; padding: 1px 7px; margin-left: 8px; white-space: nowrap; }
  .note { color: var(--ink-2); font-size: 13px; margin: 12px 0 0; max-width: 68ch; }
  .banner { background: var(--surface); border: 1px solid var(--ring); border-left: 3px solid var(--bar);
            border-radius: 6px; padding: 12px 14px; margin: 0 0 24px; color: var(--ink-2);
            font-size: 14px; max-width: 78ch; }
  @media (max-width: 620px) {
    summary { grid-template-columns: 1fr 56px; }
    summary .meter { display: none; }
  }
  .meter { height: 8px; border-radius: 4px; background: var(--bar-track); overflow: hidden; }
  .meter > i { display: block; height: 100%; border-radius: 4px; background: var(--bar); }
  .cnt { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); font-size: 13px; }
  .body { padding: 4px 16px 16px; border-top: 1px solid var(--rule); background: var(--plane); }
  .who { color: var(--ink-2); font-size: 13px; margin: 10px 0; word-break: break-word; }
  .pair { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
          border-left: 2px solid var(--rule); padding-left: 12px; margin: 10px 0; }
  .pair div { padding: 2px 0; word-break: break-word; }
  .pair b { color: var(--muted); font-weight: 500; display: inline-block; min-width: 66px; }

  .grid { display: grid; gap: 18px 24px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .cls h3 { font-size: 13px; font-weight: 620; margin: 0 0 6px; text-transform: capitalize; }
  .cls ul { list-style: none; margin: 0; padding: 0; }
  .cls li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-size: 13px; color: var(--ink-2); }
  .cls li b { font-weight: 500; font-variant-numeric: tabular-nums; margin-left: auto; color: var(--muted); }
  .dot { font-size: 11px; width: 12px; flex: none; }
  .p-pass { color: var(--good); } .p-fail { color: var(--serious); } .p-error { color: var(--critical); }

  .legend { display: flex; flex-wrap: wrap; gap: 16px; color: var(--ink-2); font-size: 13px; margin: 0 0 14px; }
  .scroll { overflow-x: auto; }
  footer { color: var(--muted); font-size: 12px; margin-top: 40px; }
</style>

<div class="root"><div class="wrap">
  <h1>dnd5e subclass sweep — level 20</h1>
  <p class="sub">Every subclass built twice in a live world — once through the system's own
     AdvancementManager, once through the Simple Character Creator — and diffed.</p>
  ${value("note", "") ? `<p class="banner">${esc(value("note", ""))}</p>` : ""}

  <div class="tiles">
    ${tiles.map(t => `<div class="tile ${t.state ? `s-${t.state}` : ""}">
      <div class="v">${t.value}</div>
      <div class="l">${esc(t.label)}</div>
      ${t.note ? `<div class="n">${esc(t.note)}</div>` : ""}
    </div>`).join("")}
  </div>

  <h2>Root causes</h2>
  <p>Difference paths with the item, advancement id and array index removed, so one cause is one
     row. The bar is how much of the sweep each reaches. Causes already written up in the harness
     README are marked and collapsed; anything else opens expanded.</p>
  <div class="card">
    ${ranked.length ? ranked.map(c => `<details${c.known ? "" : " open"}>
      <summary>
        <span class="sig">${esc(c.sig)}${c.known ? `<span class="chip">documented</span>` : ""}</span>
        <span class="meter" title="${c.scenarios.size} of ${total} subclasses"><i style="width:${
          Math.max(2, Math.round((c.scenarios.size / maxScenarios) * 100))}%"></i></span>
        <span class="cnt">${c.scenarios.size}/${total}</span>
      </summary>
      <div class="body">
        ${c.known ? `<p class="note">${esc(c.known.note)}</p>` : ""}
        <p class="who"><b>${c.rows}</b> row${c.rows === 1 ? "" : "s"} across:
           ${esc([...c.scenarios].map(id => split(id).sub).sort().join(", "))}</p>
        ${c.samples.map(s => `<div class="pair">
          <div style="color:var(--muted)">${esc(s.path)} &mdash; ${esc(split(s.id).sub)}</div>
          <div><b>native</b> ${esc(clip(s.native))}</div>
          <div><b>creator</b> ${esc(clip(s.creator))}</div>
        </div>`).join("")}
      </div>
    </details>`).join("") : `<div class="body"><p class="note">No differences recorded.</p></div>`}
  </div>

  ${errors.size ? `<h2>Errors</h2>
  <p>A scenario that threw produced no comparison at all, so it contributes nothing above.</p>
  <div class="card">
    ${[...errors.values()].sort((a, b) => b.scenarios.length - a.scenarios.length).map(e => `<details>
      <summary>
        <span class="sig">${esc(clip(e.sample, 120))}</span>
        <span class="meter"><i style="width:${Math.max(2, Math.round((e.scenarios.length / total) * 100))}%"></i></span>
        <span class="cnt">${e.scenarios.length}/${total}</span>
      </summary>
      <div class="body"><p class="who">${esc(e.scenarios.map(id => split(id).sub).sort().join(", "))}</p></div>
    </details>`).join("")}
  </div>` : ""}

  <h2>By class</h2>
  <div class="legend">
    <span><span class="dot p-pass">✓</span> identical</span>
    <span><span class="dot p-fail">▲</span> differing</span>
    <span><span class="dot p-error">✕</span> errored</span>
    <span style="color:var(--muted)">the number is that subclass's difference count</span>
  </div>
  <div class="grid">
    ${classes.map(([cls, subs]) => `<div class="cls">
      <h3>${esc(cls)}</h3>
      <ul>${subs.sort((a, b) => a.sub.localeCompare(b.sub)).map(s => `<li>
        <span class="dot p-${s.state}" title="${STATE[s.state].label}">${STATE[s.state].icon}</span>
        <span>${esc(s.sub)}</span>
        <b>${s.state === "error" ? "err" : s.count}</b>
      </li>`).join("")}</ul>
    </div>`).join("")}
  </div>

  <footer>${inFlight ? `IN PROGRESS — ${total} of ${expected}, this page refreshes every 30s · ` : ""}${total} subclass${total === 1 ? "" : "es"} ·
    ${Math.round(reports.reduce((n, r) => n + (r.ms ?? 0), 0) / 60000)} minutes of build time ·
    generated ${new Date().toISOString().replace("T", " ").slice(0, 16)}</footer>
</div></div>
`;

writeFileSync(outPath, html, "utf8");

// The same ranking on the terminal, because the answer is usually short enough not to need a
// browser — the HTML is for reading the samples and the per-class spread.
console.log(`\n${total} subclass(es): ${passed} identical, ${differing} differing, ${errored} errored`);
console.log(`${totalRows} difference row(s) -> ${ranked.length} distinct cause(s)\n`);
for ( const c of ranked ) {
  console.log(`  ${String(c.scenarios.size).padStart(3)}/${total}  ${String(c.rows).padStart(4)} rows  `
    + `${c.known ? "        " : " NEW -> "}${c.sig}`);
}
for ( const e of [...errors.values()].sort((a, b) => b.scenarios.length - a.scenarios.length) ) {
  console.log(`  ${String(e.scenarios.length).padStart(3)}/${total}   ERROR       ${clip(e.sample, 100)}`);
}
console.log(`\nwritten to ${outPath.pathname.split("/").pop()}`);
