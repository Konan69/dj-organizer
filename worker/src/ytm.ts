/**
 * Public YouTube Music playlist reader over the innertube browse API — the same
 * unauthenticated read the Python ytm_bridge does through ytmusicapi, without
 * Python, so it runs in a Worker as well as under Bun.
 */
export type YtmTrack = { videoId: string; title: string | null; artist: string; sort: number;
  /** Greyed out upstream (deleted or blocked): listed, but not downloadable. */
  unavailable?: boolean };
export type YtmPlaylist = { ytmId: string; title: string; trackCount: number | null; tracks: YtmTrack[] };

const ORIGIN = "https://music.youtube.com";
const ENDPOINT = `${ORIGIN}/youtubei/v1/browse?prettyPrint=false`;
const CLIENT_VERSION = "1.20260928.01.00";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * The headers the YouTube Music web client sends. A bare POST with only a
 * content type is what YouTube rejects with 403 from datacenter addresses
 * (Cloudflare's egress); a request that looks like the web client, carrying a
 * visitor id and the consent cookie, is served like any signed-out browser.
 * `x-youtube-client-name: 67` is WEB_REMIX.
 */
const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "user-agent": USER_AGENT,
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  origin: ORIGIN,
  "x-origin": ORIGIN,
  referer: `${ORIGIN}/`,
  "x-youtube-client-name": "67",
  "x-youtube-client-version": CLIENT_VERSION,
  // Pre-accepted cookie consent, so no consent interstitial is returned.
  cookie: "SOCS=CAI",
};

/**
 * The signed-out visitor id, read once from the web page's config and then
 * kept up to date from each response. Sent back as `x-goog-visitor-id` and in
 * the client context so consecutive requests look like one browser session.
 */
let visitorData: string | undefined;

async function loadVisitorData(): Promise<string | undefined> {
  const res = await fetch(`${ORIGIN}/`, {
    headers: { "user-agent": USER_AGENT, "accept-language": BASE_HEADERS["accept-language"]!, cookie: BASE_HEADERS.cookie! },
  });
  if (!res.ok) return undefined;
  return /"VISITOR_DATA":"([^"]+)"/.exec(await res.text())?.[1];
}

async function browseOnce(body: Record<string, unknown>): Promise<Response> {
  visitorData ??= await loadVisitorData();
  const client = { clientName: "WEB_REMIX", clientVersion: CLIENT_VERSION, hl: "en", gl: "US",
    userAgent: USER_AGENT, ...(visitorData ? { visitorData } : {}) };
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { ...BASE_HEADERS, ...(visitorData ? { "x-goog-visitor-id": visitorData } : {}) },
    body: JSON.stringify({ context: { client, user: {} }, ...body }),
  });
}

async function browse(body: Record<string, unknown>): Promise<any> {
  // A 403 or 429 is often tied to the visitor id or a burst: drop the id, wait
  // briefly, and try again with a fresh one before giving up.
  let res = await browseOnce(body);
  for (const waitMs of [400, 1500]) {
    if (res.status !== 403 && res.status !== 429) break;
    visitorData = undefined;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    res = await browseOnce(body);
  }
  if (!res.ok) throw new Error(`browse HTTP ${res.status}`);
  const json: any = await res.json();
  visitorData = json?.responseContext?.visitorData ?? visitorData;
  return json;
}

type Run = { text: string };
const runs = (col: any): Run[] => col?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];

function item(entry: any, sort: number): YtmTrack | null {
  const r = entry.musicResponsiveListItemRenderer;
  const videoId = r?.playlistItemData?.videoId;
  if (!videoId) return null;
  const [titleCol, artistCol] = r.flexColumns ?? [];
  // Names are runs; the separators between them (", ", " & ") are runs too.
  const artists = runs(artistCol).map((x) => x.text.trim()).filter((x) => x && !/^(,|&|•)$/.test(x));
  return {
    videoId,
    title: runs(titleCol).map((x) => x.text).join("") || null,
    artist: artists.join(", "),
    sort,
    // Deleted/blocked entries keep their videoId but render greyed out.
    ...(r.musicItemRendererDisplayPolicy === "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT"
      ? { unavailable: true } : {}),
  };
}

const continuation = (items: any[]): string | undefined =>
  items.at(-1)?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;

export async function fetchPlaylist(ytmId: string): Promise<YtmPlaylist> {
  const first = await browse({ browseId: `VL${ytmId}` });
  const root = first.contents?.twoColumnBrowseResultsRenderer;
  if (!root) throw new Error("playlist not readable (private or removed?)");
  const shelf = root.secondaryContents?.sectionListRenderer?.contents?.[0]?.musicPlaylistShelfRenderer;
  const header = root.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
    ?.musicResponsiveHeaderRenderer;
  const title = header?.title?.runs?.map((x: Run) => x.text).join("") ?? ytmId;
  const countText: string = header?.secondSubtitle?.runs?.map((x: Run) => x.text).join("") ?? "";
  const count = /([\d,]+)\s+(?:song|track|video)/i.exec(countText)?.[1];

  const tracks: YtmTrack[] = [];
  let items: any[] = shelf?.contents ?? [];
  for (let page = 0; page < 100; page++) {
    for (const entry of items) {
      const t = item(entry, tracks.length);
      if (t) tracks.push(t);
    }
    const token = continuation(items);
    if (!token) break;
    const next = await browse({ continuation: token });
    items = next.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems ?? [];
  }
  return { ytmId, title, trackCount: count ? Number(count.replace(/,/g, "")) : null, tracks };
}
