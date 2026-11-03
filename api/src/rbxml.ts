/**
 * rekordbox XML export — the officially documented interchange format.
 *
 * Pioneer documents this format for playlist sharing, and rekordbox imports it
 * NON-DESTRUCTIVELY: the file shows up under its own tree in the browser and
 * the user drags what they want into the collection. Nothing is overwritten.
 *
 * This is deliberately preferred over writing master.db directly:
 *   - master.db is SQLCipher-encrypted and the key extraction has broken before
 *     (rekordbox 6.6.5 compiled app.asar to .jsc)
 *   - this machine runs rekordbox 7.2.14, above pyrekordbox's tested 7.0.9
 *   - direct writes have to maintain USN / sync bookkeeping correctly
 *   - an XML file is inert: worst case the user deletes it
 *
 * Spec: https://rekordbox.com/en/support/developer/
 */
import { db } from "./db";
import { toWin } from "./paths";

const KIND: Record<string, string> = {
  m4a: "M4A File", mp3: "MP3 File", wav: "WAV File",
  flac: "FLAC File", aiff: "AIFF File", webm: "WebM File",
};

/**
 * rekordbox wants `file://localhost/C:/path/to/file.ext` with the path
 * percent-encoded. encodeURI keeps `/` and `:` (wanted) but also leaves
 * `# ? [ ] & ' "` alone — all legal in these filenames, and `&` in particular
 * produces invalid XML once the URL lands in an attribute. Encode them here so
 * the value is safe as both a URI and an attribute.
 */
export function locationUrl(wslPath: string): string {
  const win = toWin(wslPath);
  const encoded = encodeURI(win)
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D")
    .replace(/&/g, "%26")
    .replace(/'/g, "%27")
    .replace(/"/g, "%22");
  return `file://localhost/${encoded}`;
}

const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const ymd = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "";

type Row = {
  id: number; path: string; filename: string; ext: string; folder: string;
  title: string | null; artist: string | null; album: string | null;
  genre: string | null; duration: number | null; bitrate: number | null;
  size: number | null; added_at: number | null;
};

/**
 * Build a rekordbox XML document from the staged state.
 * `playlists` limits the export; omit for everything.
 */
export function build(opts: { playlists?: string[]; includeUnfiled?: boolean } = {}) {
  const tracks = db.query<Row, []>(
    `SELECT t.id,t.path,t.filename,t.ext,t.folder,
            COALESCE(o.title,t.title) AS title,COALESCE(o.artist,t.artist) AS artist,
            t.album,t.genre,t.duration,t.bitrate,t.size,t.added_at
     FROM tracks t LEFT JOIN track_overrides o ON o.track_hash=t.content_hash
     WHERE t.missing=0
     ORDER BY COALESCE(o.artist,t.artist),COALESCE(o.title,t.title)`).all();

  const pls = db.query<{ id: number; name: string }, []>(
    "SELECT id,name FROM playlists ORDER BY sort,name").all()
    .filter((p) => !opts.playlists || opts.playlists.includes(p.name));

  const memberQ = db.query<{ track_id: number }, [number]>(
    "SELECT track_id FROM memberships WHERE playlist_id=? ORDER BY sort");

  // Only export tracks that are actually referenced, unless asked otherwise.
  const used = new Set<number>();
  const members = new Map<string, number[]>();
  for (const p of pls) {
    const ids = memberQ.all(p.id).map((r) => r.track_id);
    members.set(p.name, ids);
    for (const id of ids) used.add(id);
  }
  const exported = opts.includeUnfiled ? tracks : tracks.filter((t) => used.has(t.id));

  const L: string[] = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<DJ_PLAYLISTS Version="1.0.0">');
  L.push('  <PRODUCT Name="dj-organizer" Version="1.0" Company="local"/>');
  L.push(`  <COLLECTION Entries="${exported.length}">`);

  for (const t of exported) {
    const attrs: [string, string | number][] = [
      ["TrackID", t.id],
      ["Name", esc(t.title ?? t.filename)],
      ["Artist", esc(t.artist)],
      ["Album", esc(t.album)],
      // The embedded genre tag is the uploader's YouTube category
      // ("Music", "Entertainment") and is useless for DJing. The folder is the
      // actual genre decision, so it wins.
      ["Genre", esc(t.folder || t.genre)],
      ["Kind", KIND[t.ext] ?? `${t.ext.toUpperCase()} File`],
      ["Size", t.size ?? 0],
      ["TotalTime", Math.round(t.duration ?? 0)],
      ["BitRate", t.bitrate ?? 0],
      ["DateAdded", ymd(t.added_at)],
      ["Location", locationUrl(t.path)],
    ];
    L.push(`    <TRACK ${attrs.map(([k, v]) => `${k}="${v}"`).join(" ")}/>`);
  }
  L.push("  </COLLECTION>");

  L.push("  <PLAYLISTS>");
  L.push(`    <NODE Type="0" Name="ROOT" Count="${pls.length}">`);
  for (const p of pls) {
    const ids = (members.get(p.name) ?? []).filter((id) => !opts.includeUnfiled || true);
    L.push(`      <NODE Name="${esc(p.name)}" Type="1" KeyType="0" Entries="${ids.length}">`);
    for (const id of ids) L.push(`        <TRACK Key="${id}"/>`);
    L.push("      </NODE>");
  }
  L.push("    </NODE>");
  L.push("  </PLAYLISTS>");
  L.push("</DJ_PLAYLISTS>");
  L.push("");

  return {
    xml: L.join("\n"),
    stats: {
      tracks: exported.length,
      playlists: pls.length,
      entries: [...members.values()].reduce((n, v) => n + v.length, 0),
    },
  };
}

/**
 * How to actually use the file. rekordbox needs to be pointed at it once, in
 * Preferences; after that it appears in the browser tree as its own source.
 */
export const IMPORT_STEPS = [
  "In rekordbox: Preferences → View → Layout → tick “rekordbox xml”",
  "Preferences → Advanced → Database → rekordbox xml → Imported Library → set the file",
  "The tree now shows an “rekordbox xml” source with these playlists",
  "Right-click a playlist there → Import Playlist, to bring it into your collection",
  "Nothing is overwritten: import is additive and you choose what comes in",
];
