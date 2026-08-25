/**
 * What a results file is: the header a sweep writes into it, and what can be recovered from the
 * files written before headers existed.
 *
 * A sweep produces `sweep-results.jsonl`, which is then renamed to something like
 * `sweep-results-final-2.4.0.jsonl` and kept as a baseline for the next run to diff against. The
 * scenario records carry no run-level facts at all — not the flags, not the versions, not the day —
 * so a directory of these files is a directory of anonymous 2 MB blobs whose meaning lives only in
 * the name somebody typed. That was survivable while every run meant the same thing. It stopped
 * being survivable when `--sweep` changed its default from a single jump to one level at a time:
 * the older files became non-comparable with the newer ones, look identical, and say nothing.
 *
 * So a run now opens its file with a `_meta` line. Two rules make it worth having:
 *
 *   - It goes *inside* the jsonl, not in a sidecar. Archiving a baseline is a rename, and a rename
 *     leaves a sidecar behind — the sidecar would be lost in exactly the case it is needed for.
 *   - It carries no `id`. Every reader keys scenario records by `id`, so a header is skipped by
 *     construction, and a file without one stays as readable as it ever was.
 *
 * {@link deriveMeta} is the other half: the twenty-odd headerless baselines already on disk are not
 * a lost cause, because a run leaves fingerprints in its records. An incremental run records a
 * per-level `levels.profile`; a jump run has nothing to record until the end and leaves it empty.
 * The axis is in the id prefix, the level in the profile. Derived facts are marked as derived —
 * they are good enough to sort a directory out, not good enough to trust as provenance.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { MODULE_ID, MODULE_SOURCE } from "../config.mjs";

/**
 * Read a results file's header, if it has one.
 * @param {URL|string} path
 * @returns {object|null}   The `_meta` payload, or null for a headerless (pre-provenance) file.
 */
export function readMeta(path) {
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0];
    const parsed = JSON.parse(first);
    return parsed?._meta ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a results file as its header plus its scenario records.
 * @param {URL|string} path
 * @returns {{meta: object|null, records: object[]}}
 */
export function readResults(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const records = [];
  let meta = null;
  for ( const line of lines ) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if ( parsed?._meta ) meta = parsed._meta;
    else if ( parsed?.id ) records.push(parsed);
  }
  return { meta, records };
}

/**
 * Build the header for a run about to start.
 *
 * The versions come from the world itself rather than from `config.mjs`, because config says which
 * versions the harness *asks* for and the world says which ones it got. The git state is the
 * working tree, not the last commit: a baseline taken over uncommitted work is reproducible only by
 * the person holding that tree, and `dirty` is what says so.
 * @param {import("./session.mjs").Session} session   The open world session.
 * @param {object} run   Resolved run shape: mode, level, axis, world, scenarios, shard, only.
 * @returns {Promise<{_meta: object}>}
 */
export async function sweepMeta(session, run) {
  const versions = await session.eval(id => ({
    foundry: game.version,
    system: `${game.system.id} ${game.system.version}`,
    module: game.modules.get(id)?.version ?? null
  }), MODULE_ID).catch(() => null);

  return { _meta: { kind: "sweep", startedAt: new Date().toISOString(), ...run, versions, git: gitState() } };
}

/** The working tree the run measures: branch, commit, and whether it had uncommitted changes. */
function gitState() {
  const git = args => execFileSync("git", args, { cwd: MODULE_SOURCE, encoding: "utf8" }).trim();
  try {
    return {
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      sha: git(["rev-parse", "--short", "HEAD"]),
      dirty: git(["status", "--porcelain"]) !== ""
    };
  } catch {
    return null;                                  // no git, or not a checkout — not worth failing a run over
  }
}

/**
 * Recover what a headerless results file was, from the records themselves.
 *
 * Every field here is a guess with a reason:
 *   - `mode`   an incremental run compares at every level and writes a `levels.profile` per
 *              scenario; a jump run compares once at the end and leaves it empty.
 *   - `axis`   the id prefix — `sweep:` for the subclass axis, `species:`, `background:`.
 *   - `level`  the deepest level any profile reached, falling back to the level in the scenario
 *              name (`Sweep: Artificer 20 — Alchemist`).
 *   - `duplicated` scenarios recorded more than once, which means two runs were appended into one
 *              file. Such a file is not one baseline and cannot be read as one.
 * @param {object[]} records
 * @returns {object}   The same shape as a header, plus `derived: true`.
 */
export function deriveMeta(records) {
  const withProfile = records.filter(r => r.levels?.profile?.length).length;
  const ids = records.map(r => r.id);
  const seen = new Set();
  const duplicated = new Set(ids.filter(id => seen.has(id) || (seen.add(id), false)));

  const levels = records.flatMap(r => (r.levels?.profile ?? []).map(l => l.level));
  const named = records.map(r => Number(r.name?.match(/\s(\d+)\s—/)?.[1])).filter(Boolean);
  const axes = new Set(ids.map(id => id.split(":")[0]));

  return {
    derived: true,
    kind: "sweep",
    // One scenario with a profile is enough to know the run was incremental: a jump run compares
    // once at the end and never writes one. Where only some scenarios have it, the rest errored
    // before they could — a fact about those scenarios, not about the mode, so it is reported
    // separately rather than blurring the one field `describeDrift` compares.
    mode: withProfile ? "incremental" : "jump",
    profiled: withProfile === records.length ? null : `${withProfile}/${records.length}`,
    level: levels.length ? Math.max(...levels) : (named.length ? Math.max(...named) : null),
    // `sweep:` was the original id prefix, from when the subclass axis was the only axis.
    axis: [...axes].map(a => ({ sweep: "subclass" }[a] ?? a)).sort().join("+"),
    scenarios: seen.size,
    duplicated: [...duplicated],
    verdicts: {
      pass: records.filter(r => r.ok).length,
      fail: records.filter(r => !r.ok && !r.error).length,
      error: records.filter(r => r.error).length
    }
  };
}

/** Both tallies in one place, for a file that has a header (which records no verdicts of its own). */
export function tally(records) {
  return {
    pass: records.filter(r => r.ok).length,
    fail: records.filter(r => !r.ok && !r.error).length,
    error: records.filter(r => r.error).length
  };
}

/**
 * One line describing a run, for a console that is about to overwrite or compare it.
 * @param {object} meta   A header, or a {@link deriveMeta} guess.
 */
export function describeMeta(meta) {
  if ( !meta ) return "no header (pre-provenance file)";
  const when = meta.startedAt ? meta.startedAt.slice(0, 16).replace("T", " ") : "date unknown";
  const v = meta.versions;
  const git = meta.git ? `${meta.git.branch}@${meta.git.sha}${meta.git.dirty ? "+dirty" : ""}` : null;
  return [
    `${meta.axis ?? "?"} axis, ${meta.mode ?? "?"}, level ${meta.level ?? "?"}`,
    `${meta.scenarios ?? "?"} scenario(s)`,
    meta.profiled ? `only ${meta.profiled} reached a per-level comparison` : null,
    meta.shard ? `shard ${meta.shard}` : null,
    when,
    v ? `${v.foundry ?? "?"} / ${v.system ?? "?"}${v.module ? ` / module ${v.module}` : ""}` : null,
    git,
    meta.derived ? "(derived, not recorded)" : null
  ].filter(Boolean).join(" · ");
}

/**
 * The ways two runs are not comparable, named.
 *
 * `compare-baseline.mjs` diffs verdicts scenario by scenario, and every difference it prints is
 * read as "this changed because the code changed". That reading is only sound when the two runs
 * asked the same question. A jump run and an incremental run over the same subclasses genuinely
 * disagree — the increments catch a level-5 divergence that a later level papers over, the jump
 * catches a capstone applied out of order — so diffing across them reports the mode, dressed up as
 * a regression. Same for a level-6 file against a level-20 one, or two different axes.
 * @param {object} a   The baseline's header.
 * @param {object} b   The current run's shape.
 * @returns {string[]} One phrase per incomparable field, empty when the two runs match.
 */
export function describeDrift(a, b) {
  const differs = (key, label = key) =>
    (a[key] && b[key] && (a[key] !== b[key])) ? `${label} (${b[key]} now, ${a[key]} there)` : null;
  return [differs("mode"), differs("level"), differs("axis")].filter(Boolean);
}
