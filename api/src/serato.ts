/**
 * Serato `.crate` binary format.
 *
 *   crate := chunk*
 *   chunk := tag[4] + length[4 BE] + body
 *   vrsn  := "1.0/Serato ScratchLive Crate" UTF-16BE + 0x0000
 *   otrk  := "ptrk" + length[4 BE] + path UTF-16BE + 0x0000
 *
 * Paths are RELATIVE with no leading slash: "Users/you/Music/tracks/Dub/x.m4a".
 * relative(WIN_ROOT, abs) already yields the "Users/you/..." prefix — prepending
 * it again produces "Users/you/Users/you/..." and silently kills every entry.
 * That bug wiped all 19 crates once; keep the round-trip test honest.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MNT_ROOT, SUBCRATES } from "./paths";

// READ-ONLY MODULE. This app never writes a .crate file. Crates are the
// baseline the changeset is diffed against, and that diff is applied by hand.
// No fs write API is imported here on purpose — keep it that way.

const VRSN = "1.0/Serato ScratchLive Crate";

function utf16(s: string): Buffer {
  const d = Buffer.from(s, "utf16le").swap16();
  return Buffer.concat([d, Buffer.from([0, 0])]);
}

function chunk(tag: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from(tag, "latin1"), len, body]);
}

/** In-memory only, used by the round-trip self test. Never written to disk. */
export function build(relPaths: string[]): Buffer {
  const parts = [chunk("vrsn", utf16(VRSN))];
  for (const p of relPaths) {
    const inner = utf16(p);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(inner.length);
    parts.push(chunk("otrk", Buffer.concat([Buffer.from("ptrk", "latin1"), len, inner])));
  }
  return Buffer.concat(parts);
}

/** Absolute WSL paths referenced by a crate. */
export function parse(data: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  while (i + 8 <= data.length) {
    const tag = data.toString("latin1", i, i + 4);
    const len = data.readUInt32BE(i + 4);
    const body = data.subarray(i + 8, i + 8 + len);
    if (tag === "otrk" && body.toString("latin1", 0, 4) === "ptrk") {
      const rel = Buffer.from(body.subarray(8)).swap16()
        .toString("utf16le").replace(/\0/g, "");
      if (rel) out.push(join(MNT_ROOT, rel.replace(/^\/+/, "")));
    }
    i += 8 + len;
  }
  return out;
}

export function relPath(abs: string): string {
  return relative(MNT_ROOT, abs).split("\\").join("/");
}

export function readAll(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!existsSync(SUBCRATES)) return out;
  for (const fn of readdirSync(SUBCRATES).sort()) {
    if (!fn.endsWith(".crate")) continue;
    try {
      out[fn.slice(0, -6)] = parse(readFileSync(join(SUBCRATES, fn)));
    } catch { /* unreadable crate — skip, don't abort the scan */ }
  }
  return out;
}

export function listCrateFiles(): string[] {
  return existsSync(SUBCRATES)
    ? readdirSync(SUBCRATES).filter((f) => f.endsWith(".crate"))
    : [];
}

/** Every path in every crate must resolve to a real file. */
export function verifyAll() {
  const problems: Record<string, number> = {};
  for (const [name, paths] of Object.entries(readAll())) {
    const missing = paths.filter((p) => !existsSync(p)).length;
    if (missing) problems[name] = missing;
  }
  return { ok: Object.keys(problems).length === 0, problems };
}

/** Write -> parse -> confirm identity. Guards the double-prefix regression. */
export function selfTest(samplePaths: string[]) {
  const data = build(samplePaths.map(relPath));
  const back = parse(data);
  const identical =
    back.length === samplePaths.length && back.every((p, i) => p === samplePaths[i]);
  return {
    ok: identical,
    wrote: samplePaths.length,
    readBack: back.length,
    firstIn: samplePaths[0] ?? null,
    firstOut: back[0] ?? null,
  };
}
