import { treaty } from "@elysiajs/eden";
import type { App } from "@api/index";

/** End-to-end typed client. Vite proxies /api to the Elysia server in dev. */
export const client = treaty<App>(
  typeof window === "undefined" ? "localhost:8765" : window.location.host,
);

export const api = client.api;

/**
 * The global onError handler returns `{ error: string }` (and a raw `Response`
 * for the SPA fallback), so Eden folds both shapes into every route's response
 * union. Strip them: a resolved `unwrap` only ever yields the success branch,
 * and the failure branch becomes a throw.
 */
type Ok<T> = Exclude<T, { error: string } | Response>;

export async function unwrap<T>(
  p: Promise<{ data: T | null; error: unknown }>,
): Promise<Ok<T>> {
  const { data, error } = await p;
  if (error) {
    const e = error as { value?: { error?: string }; status?: number };
    // Plain words, never a status code: this lands in a toast.
    throw new Error(e.value?.error ?? (e.status
      ? "The server hit an error. Try again."
      : "Can't reach the app server. Check it's running, then try again."));
  }
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(String((data as { error: unknown }).error));
  }
  return data as Ok<T>;
}

type Unwrapped<T> = Ok<Awaited<T> extends { data: infer D } ? NonNullable<D> : never>;

export type State = Unwrapped<ReturnType<typeof api.state.get>>;
export type Track = State["tracks"][number];
export type Playlist = State["playlists"][number];
export type Duplicates = Unwrapped<ReturnType<typeof api.duplicates.get>>;
export type Changes = Unwrapped<ReturnType<typeof api.changes.get>>;
export type YtmDiff = Unwrapped<ReturnType<typeof api.ytm.diff.get>>;
export type YtmStatus = Unwrapped<ReturnType<typeof api.ytm.status.get>>;
export type StoresView = Unwrapped<ReturnType<typeof api.stores.get>>;
export type Op = Unwrapped<ReturnType<typeof api.ops.get>>[number];
export type PlanFor = Unwrapped<ReturnType<ReturnType<typeof api.plan>["get"]>>;
export type YtmCandidates = Unwrapped<ReturnType<typeof api.ytm.candidates.get>>;
export type TrackHistory = Unwrapped<ReturnType<ReturnType<typeof api.track>["history"]["get"]>>;
export type YtmClassify = Unwrapped<ReturnType<typeof api.ytm.classify.get>>;
export type DownloadJob = Unwrapped<ReturnType<typeof api.download.get>>[number];
