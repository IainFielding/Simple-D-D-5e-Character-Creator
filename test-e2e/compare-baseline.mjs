/**
 * Diff a fresh sweep run against an archived baseline, scenario by scenario.
 *   node compare-baseline.mjs sweep-results.jsonl sweep-results-final-2.4.0.jsonl
 * Only ids present in *both* files are compared, so a shard diffs cleanly against a full baseline.
 *
 * Every line this prints is read as "this changed because the code changed", and that reading holds
 * only where the two runs asked the same question. They often did not: `--sweep` used to mean a
 * single jump to the target level and now means one level at a time, so a file from before that
 * change and a file from after it disagree about scenarios where nothing in the module moved. The
 * banner at the top says what each side was, and `describeDrift` names the ways they are not
 * comparable — see `lib/provenance.mjs` for why a results file carries a header at all.
 *
 * A pre-provenance file has no header to check. It is still diffable; it is just diffable on trust,
 * and the banner says so rather than implying a match.
 */
import { statSync } from "node:fs";

import { describeDrift, describeMeta, deriveMeta, readResults, tally } from "./lib/provenance.mjs";

const [nowPath, basePath] = process.argv.slice(2);
if ( !nowPath || !basePath ) throw new Error("usage: node compare-baseline.mjs <now.jsonl> <baseline.jsonl>");

const read = path => {
  const { meta, records } = readResults(path);
  const derived = deriveMeta(records);
  // A headerless file has no recorded start time; its mtime is when the last scenario landed, which
  // is what the reader actually wants to know about a file this old.
  if ( !meta ) derived.startedAt = statSync(path).mtime.toISOString();
  return { meta: meta ?? derived, records, byId: new Map(records.map(r => [r.id, r])) };
};

const now = read(nowPath);
const base = read(basePath);

console.log(`now      ${nowPath}\n         ${describeMeta(now.meta)}`);
console.log(`baseline ${basePath}\n         ${describeMeta(base.meta)}\n`);

const drift = describeDrift(base.meta, now.meta);
if ( drift.length ) {
  console.log(`!! these runs are not comparable — they differ in ${drift.join(", ")}.`);
  console.log("!! differences below are at least partly the run shape, not the module.\n");
}
for ( const side of [now, base] ) {
  if ( side.meta.duplicated?.length ) {
    console.log(`!! ${side === now ? nowPath : basePath} holds ${side.meta.duplicated.length} scenario(s) `
      + "recorded twice — it is two runs appended into one file, and the later record wins.\n");
  }
}

const verdict = r => r.error ? "ERROR" : r.ok ? "PASS" : "FAIL";
const at = r => r.levels?.firstDivergence?.level ?? null;

let changed = 0;
for ( const [id, n] of now.byId ) {
  const b = base.byId.get(id);
  if ( !b ) { console.log(`${id}\n    (not in baseline)  now ${verdict(n)}`); continue; }
  const same = (verdict(n) === verdict(b)) && (at(n) === at(b))
    && (n.differences?.length === b.differences?.length);
  if ( same ) { console.log(`  same   ${verdict(n).padEnd(5)} ${id}`); continue; }
  changed++;
  console.log(`  CHANGED ${id}`);
  console.log(`      baseline: ${verdict(b).padEnd(5)} diverges@${at(b) ?? "-"} `
    + `${b.differences?.length ?? 0} diff(s)${b.error ? ` — ${b.error.split("\n")[0]}` : ""}`);
  console.log(`      now:      ${verdict(n).padEnd(5)} diverges@${at(n) ?? "-"} `
    + `${n.differences?.length ?? 0} diff(s)${n.error ? ` — ${n.error.split("\n")[0]}` : ""}`);
}

const t = tally(now.records);
console.log(`\n${now.byId.size} scenario(s) compared, ${changed} changed`
  + `  (now: ${t.pass} pass, ${t.fail} fail, ${t.error} error)`);
