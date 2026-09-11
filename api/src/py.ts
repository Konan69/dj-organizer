/** Thin JSON-over-stdio bridge to the two Python adapters. */
import { join } from "node:path";
import { PY_DIR } from "./paths";

export async function py<T>(
  script: "ytm_bridge.py",
  cmd: string,
  payload: unknown = {},
  timeoutMs = 300_000,
): Promise<T> {
  const proc = Bun.spawn(["python3", join(PY_DIR, script), cmd], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);

  const line = stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) {
    throw new Error(
      `${script} ${cmd} produced no output` + (stderr ? `\n${stderr.slice(-600)}` : ""),
    );
  }
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new Error(`${script} ${cmd} returned non-JSON: ${line.slice(0, 300)}`);
  }
}
