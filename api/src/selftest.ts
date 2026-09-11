/**
 * Correctness guards.
 *
 *   bun api/src/selftest.ts
 *
 * 1. Serato crate write -> parse round-trips exactly (the double-prefix bug).
 * 2. Every video id the parser reports is actually present in that file's bytes.
 *    This is the check that caught cross-file buffer contamination: an id that
 *    does not appear anywhere in the file it was read from is fabricated.
 * 3. No module mutates anything outside data/. Hard rule, not a preference: a
 *    crate rewrite already cost every crate's column layout once, and moving a
 *    file to _TRASH removes it from Serato just as effectively.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { LIB } from "./paths";
import * as serato from "./serato";
import { read } from "./tags";

const AUDIO = new Set([".m4a", ".webm"]);
const SKIP = new Set(["_TRASH", "_Serato_", "_Serato_Backup", "PioneerDJ", "rekordbox"]);

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (AUDIO.has(extname(e.name).toLowerCase())) yield full;
  }
}

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };

// ---- 1. crate round-trip ----
{
  const files = [...walk(LIB)].slice(0, 40);
  const r = serato.selfTest(files);
  if (!r.ok) fail(`crate round-trip: wrote ${r.wrote}, read back ${r.readBack}\n` +
    `        in:  ${r.firstIn}\n        out: ${r.firstOut}`);
  else console.log(`  ok    crate round-trip (${r.wrote} paths, byte-identical)`);

  const rel = serato.relPath("/mnt/c/Users/you/Music/tracks/Dub/x.m4a");
  if (rel !== "Users/you/Music/tracks/Dub/x.m4a") fail(`relPath double-prefix: ${rel}`);
  else console.log(`  ok    relPath -> ${rel}`);
}

// ---- 2. video ids must exist in their own file ----
{
  const files = [...walk(LIB)];
  let checked = 0, withId = 0, bogus = 0;
  const dupIds = new Map<string, string[]>();

  for (const f of files) {
    const size = statSync(f).size;
    const md = await read(f, size);
    checked++;
    if (!md.videoId) continue;
    withId++;
    const list = dupIds.get(md.videoId);
    if (list) list.push(f); else dupIds.set(md.videoId, [f]);

    if (f.toLowerCase().endsWith(".m4a")) {
      const head = readFileSync(f).subarray(0, Math.min(size, 1_500_000));
      if (!head.includes(Buffer.from(md.videoId, "latin1"))) {
        bogus++;
        if (bogus <= 5) fail(`id ${md.videoId} not present in ${f.split("/").pop()}`);
      }
    }
  }

  if (bogus) fail(`${bogus}/${withId} files carry a video id not found in their own bytes`);
  else console.log(`  ok    ${withId}/${checked} video ids verified against file bytes`);

  const shared = [...dupIds.entries()].filter(([, v]) => v.length > 1);
  console.log(`  info  ${shared.length} video ids appear in more than one file` +
    ` (real duplicates, expected to be small)`);
  for (const [id, paths] of shared.slice(0, 6)) {
    console.log(`        ${id}  x${paths.length}  ${paths.map((p) => p.split("/").pop()!.slice(0, 44)).join(" | ")}`);
  }
}

// ---- 3. no writer may point at the library or the Serato folder ----
{
  const MUTATORS =
    /\b(writeFileSync|writeFile|renameSync|unlinkSync|rmSync|rmdirSync|copyFileSync|Bun\.write)\s*\(/;
  // db.ts and snapshots.ts write inside data/ only (op log, sqlite snapshots).
  const DATA_ONLY = new Set(["db.ts", "snapshots.ts"]);
  const offenders: string[] = [];
  for (const fn of readdirSync(import.meta.dir)) {
    if (!fn.endsWith(".ts") || DATA_ONLY.has(fn)) continue;
    readFileSync(join(import.meta.dir, fn), "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/^\s*\*/.test(line)) return;
      if (MUTATORS.test(code)) offenders.push(`${fn}:${i + 1}  ${line.trim()}`);
    });
  }
  if (offenders.length) {
    fail(`filesystem mutation outside data/:\n        ${offenders.join("\n        ")}`);
  } else {
    console.log("  ok    no module mutates the library or the Serato folder");
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
