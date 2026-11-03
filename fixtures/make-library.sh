#!/usr/bin/env bash
# Writes a small synthetic library of tagged sine-tone tracks into fixtures/library.
set -euo pipefail
cd "$(dirname "$0")"
OUT=library
rm -rf "$OUT"
track() {  # folder artist title hz
  mkdir -p "$OUT/$1"
  ffmpeg -loglevel error -f lavfi -i "sine=frequency=$4:duration=4" -c:a aac -b:a 64k \
    -metadata artist="$2" -metadata title="$3" -metadata genre="$1" "$OUT/$1/$2 - $3.m4a"
}
track House "Example Artist" "First Light" 220
track House "Example Artist" "Second Wind" 247
track House "Sample Duo" "Warehouse Tone" 262
track Techno "Sample Duo" "Steel Loop" 294
track Techno "Test Signal" "Night Shift" 330
# Same audio under a second name, so the duplicate finder has something to show.
mkdir -p "$OUT/Techno"
cp "$OUT/House/Example Artist - First Light.m4a" "$OUT/Techno/Example Artist - First Light (copy).m4a"
find "$OUT" -type f | sort
