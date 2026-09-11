#!/usr/bin/env python3
"""YouTube Music bridge.

Stays Python because ytmusicapi implements the browse/auth protocol.
Called by the Elysia API as a subprocess:

    python3 ytm_bridge.py status
    python3 ytm_bridge.py fetch  < {"playlists":{"name":"ytmId",...}}

NOTE: get_library_playlists() and get_liked_songs() are broken server-side
(return 0 / raise KeyError on twoColumnBrowseResultsRenderer). Only
get_playlist(id) works, so callers must supply the playlist ids.
"""
import json
import sys
import time

AUTH = "/tmp/ytm-browser.json"

KNOWN = {
    "BANGERS !!!!": "PL_EXAMPLE_PLAYLIST_ID",
    "Drum & Bass Bangers": "PL_EXAMPLE_PLAYLIST_ID",
    "Hardstyle - hardstylleee": "PL_EXAMPLE_PLAYLIST_ID",
    "OG Grime": "PL_EXAMPLE_PLAYLIST_ID",
    "Techno": "PL_EXAMPLE_PLAYLIST_ID",
}


def out(obj):
    json.dump(obj, sys.stdout, default=str)
    sys.stdout.write("\n")
    sys.exit(0)


def yt():
    from ytmusicapi import YTMusic
    return YTMusic(AUTH)


def cmd_status():
    try:
        yt().get_playlist(KNOWN["Techno"], limit=1)
        out({"authed": True, "error": None, "known": KNOWN})
    except Exception as e:                                    # noqa: BLE001
        out({"authed": False, "error": f"{type(e).__name__}: {str(e)[:200]}", "known": KNOWN})


def cmd_fetch(payload):
    """payload = {"playlists": {localName: ytmId}}; falls back to KNOWN."""
    targets = payload.get("playlists") or KNOWN
    api = yt()
    results, errors = [], []
    for i, (name, pid) in enumerate(targets.items()):
        if i:
            time.sleep(1)                                     # be polite to the endpoint
        try:
            p = api.get_playlist(pid, limit=None)
        except Exception as e:                                # noqa: BLE001
            errors.append({"playlist": name, "error": f"{type(e).__name__}: {str(e)[:160]}"})
            continue
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
        results.append({"name": name, "ytmId": pid,
                        "title": p.get("title") or name, "tracks": tracks})
    out({"playlists": results, "errors": errors})


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    payload = json.loads(raw) if raw.strip() else {}
    try:
        if cmd == "status":
            cmd_status()
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
