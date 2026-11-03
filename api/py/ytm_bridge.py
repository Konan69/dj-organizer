#!/usr/bin/env python3
"""YouTube Music bridge.

Stays Python because ytmusicapi implements the browse protocol.
Called by the Elysia API as a subprocess:

    python3 ytm_bridge.py discover < {"seed":"PL..."}
    python3 ytm_bridge.py fetch    < {"playlists":{"ytmId":"ytmId",...}}

Deliberately unauthenticated.

The library endpoints (get_library_playlists, get_liked_songs) return 0 rows
here, and that was long read as an ytmusicapi bug. It is not: the browse comes
back with a "Sign in" message renderer, i.e. YouTube treats the request as
signed out. Cookie jars lifted from the desktop app and from a logged-in
Chrome both failed the same way, so the signed-in path is simply not available
from this machine.

It is also not needed. Every playlist here is PUBLIC, so get_user() lists them
all and get_playlist() reads any of them without credentials. Anonymous is the
correct client for a public browse, and it cannot go stale.

Consequence to respect: a playlist switched to Private disappears from
discovery and errors on fetch. That is surfaced, never papered over.
"""
import json
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

# Any owned playlist works as a seed; its author is the channel to enumerate.
SEED = "PL_EXAMPLE_PLAYLIST_ID"   # "Techno"


def out(obj):
    json.dump(obj, sys.stdout, default=str)
    sys.stdout.write("\n")
    sys.exit(0)


def yt():
    from ytmusicapi import YTMusic
    return YTMusic()


def cmd_discover(payload):
    """List every public playlist on the channel that owns the seed playlist."""
    seed = payload.get("seed") or SEED
    api = yt()
    p = api.get_playlist(seed, limit=1)
    author = p.get("author") or {}
    channel = author.get("id")
    if not channel:
        out({"error": f"no channel on seed playlist {seed}"})

    user = api.get_user(channel)
    section = user.get("playlists") or {}
    params = section.get("params")
    items = (api.get_user_playlists(channel, params) if params
             else (section.get("results") or []))

    out({
        "channel": channel,
        "owner": user.get("name") or author.get("name"),
        "playlists": [
            {"ytmId": i.get("playlistId"), "title": i.get("title")}
            for i in items if i.get("playlistId")
        ],
    })


def cmd_fetch(payload):
    """payload = {"playlists": {ytmId: ytmId}, "concurrency": int}

    Fetching is shaped around one fact: get_playlist() returns the first page
    (~200 tracks) no matter how small `limit` is, and only pages beyond that
    cost extra round trips. So every playlist starts with one cheap call:

      * first page already holds the whole playlist -> done, 1 request
      * otherwise -> paginate fully

    A stable reported count does not prove stable membership. Always paginate
    larger playlists so replacements and removals appear on normal refresh.
    """
    targets = payload.get("playlists") or {}
    if not targets:
        out({"playlists": [], "errors": []})

    try:
        concurrency = int(payload.get("concurrency", 6))
    except (TypeError, ValueError):
        concurrency = 6
    concurrency = max(1, min(8, concurrency))

    # YTMusic wraps a requests.Session, which must not be shared by workers.
    # The thread-local creates one client per worker and reuses it for that
    # worker's playlists.
    worker_state = threading.local()

    def collect(p):
        tracks = []
        for j, t in enumerate(p.get("tracks") or []):
            vid = t.get("videoId")
            if not vid:
                continue
            tracks.append({
                "videoId": vid,
                "title": t.get("title"),
                "artist": ", ".join(a.get("name", "") for a in (t.get("artists") or [])),
                "sort": j,
            })
        return tracks

    def fetch_one(index, name, pid):
        try:
            time.sleep(random.uniform(0.2, 0.4))             # per-thread politeness
            api = getattr(worker_state, "api", None)
            if api is None:
                api = yt()
                worker_state.api = api

            probe = api.get_playlist(pid, limit=1)
            reported = probe.get("trackCount")
            first = collect(probe)
            title = probe.get("title") or name

            complete = reported is not None and len(first) >= int(reported)
            tracks = first if complete else collect(api.get_playlist(pid, limit=None))
            return index, {"name": name, "ytmId": pid, "title": title,
                           "trackCount": reported, "tracks": tracks}, None
        except Exception as e:                                # noqa: BLE001
            return index, None, {"playlist": name, "error": f"{type(e).__name__}: {str(e)[:160]}"}

    results, errors = [], []
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(fetch_one, i, name, pid)
                   for i, (name, pid) in enumerate(targets.items())]
        # Futures are consumed in submission order so the output stays
        # deterministic even while requests complete concurrently.
        for future in futures:
            _, result, error = future.result()
            if error:
                errors.append(error)
            else:
                results.append(result)
    out({"playlists": results, "errors": errors})


def cmd_status():
    """Can we reach the public browse endpoint at all?"""
    try:
        p = yt().get_playlist(SEED, limit=1)
        out({"reachable": True, "reason": None, "owner": (p.get("author") or {}).get("name")})
    except Exception as e:                                    # noqa: BLE001
        out({"reachable": False, "reason": f"{type(e).__name__}: {str(e)[:200]}", "owner": None})


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    payload = json.loads(raw) if raw.strip() else {}
    try:
        if cmd == "status":
            cmd_status()
        elif cmd == "discover":
            cmd_discover(payload)
        elif cmd == "fetch":
            cmd_fetch(payload)
        else:
            out({"error": f"unknown command: {cmd}"})
    except Exception as e:                                    # noqa: BLE001
        import traceback
        traceback.print_exc(file=sys.stderr)
        out({"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
