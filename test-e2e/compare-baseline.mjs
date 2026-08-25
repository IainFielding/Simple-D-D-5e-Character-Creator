/**
 * Diff a fresh sweep run against an archived baseline, scenario by scenario.
 *   node compare-baseline.mjs sweep-results.jsonl sweep-results-final-2.4.0.jsonl
 * Only ids present in *both* files are compared, so a shard diffs cleanly against a full baseline.
 */
import { readFileSync } from "node:fs";

const load = f => new Map(readFileSync(f, "utf8").split("\n").filter(Boolean)
  .map(l => JSON.parse(l)).map(r => [r.id, r]));

const [now, base] = process.argv.slice(2).map(load);
const verdict = r => r.error ? "ERROR" : r.ok ? "PASS" : "FAIL";
const at = r => r.levels?.firstDivergence?.level ?? null;

let changed = 0;
for ( const [id, n] of now ) {
  const b = base.get(id);
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
console.log(`\n${now.size} scenario(s) compared, ${changed} changed`);
