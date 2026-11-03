/**
 * Carry the app's pending changes into rekordbox from the UI. rekordbox must
 * be closed while its database is written, so this closes it, runs the
 * guarded scripts/apply-rekordbox.py (backup, write, verify, re-observe) and
 * opens rekordbox again.
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RBX_EXE = process.env.DJ_REKORDBOX_EXE?.trim() || String.raw`C:\Program Files\rekordbox\rekordbox 7.2.14\rekordbox.exe`;

async function rekordboxRunning() {
  const out = await new Response(Bun.spawn(["tasklist.exe", "/FI", "IMAGENAME eq rekordbox.exe", "/NH"]).stdout).text();
  return /^rekordbox\.exe/im.test(out);
}

export class RekordboxBusy extends Error {}

export async function applyRekordbox() {
  const wasOpen = await rekordboxRunning();
  if (wasOpen) {
    // Graceful close: rekordbox saves on the way out. A forced kill could lose its own edits.
    await Bun.spawn(["taskkill.exe", "/IM", "rekordbox.exe"]).exited;
    const deadline = Date.now() + 30_000;
    while (await rekordboxRunning()) {
      if (Date.now() > deadline) throw new RekordboxBusy("rekordbox did not close. Close it yourself, then press Apply again.");
      await Bun.sleep(1000);
    }
    await Bun.sleep(2000);   // let it release master.db
  }
  // The script refuses a plan built from an old look at rekordbox.
  await fetch(`http://127.0.0.1:${process.env.PORT ?? 8765}/api/stores`);
  const p = Bun.spawn(["python3", "scripts/apply-rekordbox.py"], { cwd: ROOT, stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (wasOpen) Bun.spawn(["cmd.exe", "/c", "start", "", RBX_EXE], { cwd: "/mnt/c", stdout: "ignore", stderr: "ignore" });
  const lines = `${out}\n${err}`.split("\n").filter((l) => l.trim() && !/not supported/.test(l));
  return { ok: code === 0, reopened: wasOpen, output: lines.join("\n") };
}
