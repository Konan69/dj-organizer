import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA } from "./paths";

const DEFAULT_PATH = join(DATA, "openrouter.json");

export type OpenRouterStatus = {
  configured: boolean;
  source: "environment" | "saved" | null;
  model: "openrouter/free";
};

function cleanKey(value: unknown) {
  if (typeof value !== "string") throw new Error("Enter an OpenRouter API key.");
  const key = value.trim();
  if (key.length < 10 || key.length > 512 || /[\r\n]/.test(key)) {
    throw new Error("Enter a valid OpenRouter API key.");
  }
  return key;
}

export function readSavedOpenRouterKey(path = DEFAULT_PATH): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : null;
  } catch {
    return null;
  }
}

export function resolveOpenRouterKey(path = DEFAULT_PATH): { key: string | null; source: OpenRouterStatus["source"] } {
  const environment = process.env.OPENROUTER_API_KEY?.trim();
  if (environment) return { key: environment, source: "environment" };
  const saved = readSavedOpenRouterKey(path);
  return { key: saved, source: saved ? "saved" : null };
}

export function openRouterStatus(path = DEFAULT_PATH): OpenRouterStatus {
  const { key, source } = resolveOpenRouterKey(path);
  return { configured: Boolean(key), source, model: "openrouter/free" };
}

export function saveOpenRouterKey(value: unknown, path = DEFAULT_PATH): OpenRouterStatus {
  const key = cleanKey(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ apiKey: key }), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return openRouterStatus(path);
}

export function removeSavedOpenRouterKey(path = DEFAULT_PATH): OpenRouterStatus {
  rmSync(path, { force: true });
  return openRouterStatus(path);
}
