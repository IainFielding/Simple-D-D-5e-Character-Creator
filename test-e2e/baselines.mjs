/**
 * Say what every results file in this directory is.
 *
 *   node baselines.mjs              # print the manifest
 *   node baselines.mjs --write      # also write BASELINES.md next to the files
 *   node baselines.mjs --stale      # only the ones nothing should be diffed against
 *
 * The harness's most valuable output is also its least legible: two dozen `sweep-results-*.jsonl`
 * files, 2 MB each, named by whoever made them, from different flags and different builds, with no
 * record of which is current. They are gitignored — they quote paid-pack item text and are far too
 * big — so the repo cannot hold the answer, and nothing on disk held it either.
 *
 * This is the answer, and it is generated rather than written by hand for the reason the hand-written
 * one never existed: a manifest maintained by discipline is a manifest that goes stale the first
 * busy afternoon. Runs made from now on carry their own header (`lib/provenance.mjs`) and are simply
 * reported. Older files are read for their fingerprints instead — an incremental run leaves a
 * per-level profile behind, a jump run does not — and everything recovered that way is marked
 * `derived`, because a good guess about provenance is not provenance.
 *
 * What it flags, in the order the flags matter:
 *
 *   spliced   the file holds a scenario twice, so it is two runs appended into one and cannot be
 *             read as a single baseline. `--sweep` never truncated its output file, so this
 *             happened to anyone who re-ran without `--resume`; run.mjs now refuses instead.
 *   jump      recorded before `--sweep` meant "one level at a time". Not comparable with anything
 *             recorded after, however similar the name looks.
 *   partial   fewer scenarios than the axis has, i.e. a shard or an abandoned run.
 *
 * The generated file is itself gitignored: it describes one machine's working directory, and on a
 * fresh clone there is nothing for it to describe.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

import { deriveMeta, describeMeta, readResults, tally } from "./lib/provenance.mjs";

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);

const here = new URL("./", import.meta.url);
const files = readdirSync(here).filter(f => f.startsWith("sweep-results") && f.endsWith(".jsonl")).sort();
if ( !files.length ) throw new Error("no sweep-results*.jsonl in test-e2e — nothing to describe");

/**
 * What a full run of each axis came to when this was written — a floor, not a truth: the real
 * count follows the content modules the world has installed, so it drifts. Anything larger found
 * on disk wins over these, which is what keeps "partial" meaningful after the next content update.
 */
const FULL = { subclass: 122, species: 24, background: 55 };

const read = files.map(name => {
  const path = new URL(name, here);
  const { meta, records } = readResults(path);
  const stat = statSync(path);
  const derived = deriveMeta(records);
  // A derived file has no recorded start time, but it does have an mtime, and for an append-only
  // results file that is the moment the last scenario landed. Close enough to sort by, and it is
  // reported under the same `derived` caveat as everything else inferred.
  if ( !meta ) derived.startedAt = stat.mtime.toISOString();
  // Two names for one run is the other way this directory misleads: `sweep-results-final-2.4.0` and
  // `sweep-results-preaudit-1002` are the same 2.6 MB, saved twice under names that read like two
  // different milestones. Nothing about the content says so, so the content is hashed.
  const hash = createHash("md5").update(readFileSync(path)).digest("hex");
  return { name, meta, records, derived, m: meta ?? derived, stat, hash };
});

const byHash = new Map();
for ( const r of read ) byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), r.name]);

const expected = { ...FULL };
for ( const r of read ) expected[r.m.axis] = Math.max(expected[r.m.axis] ?? 0, r.derived.scenarios);

const rows = read.map(({ name, meta, records, derived, m, stat, hash }) => {
  const full = expected[m.axis];

  const flags = [];
  if ( derived.duplicated.length ) flags.push(`spliced (${derived.duplicated.length} scenario(s) twice)`);
  if ( m.mode?.startsWith("jump") ) flags.push("jump — not comparable with an incremental run");
  if ( full && (derived.scenarios < full) ) flags.push(`partial (${derived.scenarios} of ${full})`);
  if ( meta?.git?.dirty ) flags.push("built from a dirty tree");

  const copies = byHash.get(hash).filter(n => n !== name);
  return { name, m, meta, records, size: stat.size, mtime: stat.mtime, tally: tally(records), flags, copies };
});

// Newest first: the question this file exists to answer is "which one is current", and the answer is
// almost always at the top.
rows.sort((a, b) => b.mtime - a.mtime);

// The reference baseline is the newest file a fresh run can honestly be diffed against: a whole
// axis, one run, one level at a time. The newest file in the directory is usually not that — it is
// a shard from chasing something — so both are reported when they differ, because "what is current"
// and "what is comparable" are different questions and answering only the first is how a shard ends
// up being used as a baseline.
const usable = rows.filter(r => !r.flags.length);
const lines = [];
const out = s => { lines.push(s); console.log(s); };

out(`# Sweep baselines\n`);
out(`Generated by \`node baselines.mjs --write\` on `
  + `${new Date().toISOString().slice(0, 16).replace("T", " ")}. Do not edit by hand.\n`);
out(`${rows.length} results file(s), ${(rows.reduce((n, r) => n + r.size, 0) / 1e6).toFixed(0)} MB. `
  + `${usable.length} carry no caveat.\n`);
if ( usable.length ) {
  out(`**Reference baseline: \`${usable[0].name}\`** — ${describeMeta(usable[0].m)}\n`);
  if ( rows[0] !== usable[0] ) {
    out(`The newest file is \`${rows[0].name}\`, which is not a reference: ${rows[0].flags.join("; ")}.\n`);
  }
} else out(`**No file here is a usable reference** — every one is partial, spliced, or a jump run.\n`);

for ( const r of rows ) {
  if ( flag("stale") && !r.flags.length ) continue;
  out(`## ${r.name}`);
  out(`- ${describeMeta(r.m)}`);
  out(`- ${r.tally.pass} pass, ${r.tally.fail} fail, ${r.tally.error} error`
    + ` · ${(r.size / 1e6).toFixed(1)} MB · modified ${r.mtime.toISOString().slice(0, 10)}`);
  if ( !r.meta ) out(`- no header: everything above is inferred from the records`);
  if ( r.copies.length ) out(`- byte-identical to ${r.copies.map(n => `\`${n}\``).join(", ")} — one run, saved twice`);
  for ( const f of r.flags ) out(`- **${f}**`);
  out("");
}

if ( flag("write") ) {
  writeFileSync(new URL("./BASELINES.md", here), `${lines.join("\n")}\n`, "utf8");
  console.log("written to test-e2e/BASELINES.md");
}
