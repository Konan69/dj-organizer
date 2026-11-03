#!/usr/bin/env python3
"""Read existing Rekordbox ANLZ data. No write or analysis path exists here."""
from __future__ import annotations

import json
import os
import struct
import sys
import time
from pathlib import Path

from pyrekordbox.anlz.file import XOR_MASK

SHARE = (Path(os.environ.get("DJ_REKORDBOX_DIR") or "~/AppData/Roaming/Pioneer/rekordbox").expanduser() / "share").resolve()
USBANLZ = (SHARE / "PIONEER" / "USBANLZ").resolve()


def u16(data: bytes, offset: int) -> int:
    return struct.unpack_from(">H", data, offset)[0]


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from(">I", data, offset)[0]


def iter_tags(path: Path, issues: list[str]):
    try:
        data = path.read_bytes()
    except OSError as error:
        issues.append(f"{path.name}: {error}")
        return
    if len(data) < 12 or data[:4] != b"PMAI":
        issues.append(f"{path.name}: unsupported file header")
        return
    try:
        offset = u32(data, 4)
        declared_end = u32(data, 8)
        if declared_end > len(data):
            issues.append(f"{path.name}: truncated file (declares {declared_end}, has {len(data)})")
        end = min(declared_end, len(data))
    except struct.error as error:
        issues.append(f"{path.name}: {error}")
        return
    while offset + 12 <= end:
        try:
            kind = data[offset:offset + 4].decode("ascii")
            length = u32(data, offset + 8)
            if length < 12 or offset + length > end:
                raise ValueError(f"invalid {kind} length {length} at {offset}")
            yield kind, data[offset:offset + length]
            offset += length
        except Exception as error:  # retain tags parsed before a damaged one
            issues.append(f"{path.name}: {type(error).__name__}: {error}")
            return


def decode_beats(tag: bytes) -> list[dict]:
    count = u32(tag, 20)
    available = max(0, (len(tag) - 24) // 8)
    if count > available:
        raise ValueError(f"PQTZ declares {count} entries but contains {available}")
    result = []
    for index in range(count):
        beat, tempo, milliseconds = struct.unpack_from(">HHI", tag, 24 + index * 8)
        if beat not in (1, 2, 3, 4):
            raise ValueError(f"PQTZ beat {beat} outside 1..4")
        bpm = tempo / 100
        if not 20 <= bpm <= 300:
            raise ValueError(f"PQTZ BPM {bpm} outside 20..300")
        result.append({"time": round(milliseconds / 1000, 6), "beat": beat,
                       "bpm": round(bpm, 2)})
    return result


def xor_pssi(tag: bytes) -> bytes:
    count = u16(tag, 16)
    data = bytearray(tag)
    for index in range(len(data) - 18):
        data[18 + index] ^= (XOR_MASK[index % len(XOR_MASK)] + count) & 0xFF
    return bytes(data)


def decode_phrases(tag: bytes, beats: list[dict]) -> list[dict]:
    # Exported PSSI tags are XOR-obfuscated. Mood usually identifies them, but
    # an obfuscated mood can coincidentally be 1..3. Try the likely form first
    # and accept only a form whose complete beat bounds are internally valid.
    candidates = [tag, xor_pssi(tag)] if 1 <= u16(tag, 18) <= 3 else [xor_pssi(tag), tag]
    errors = []
    for candidate in candidates:
        try:
            return _decode_phrases(candidate, beats)
        except (ValueError, struct.error) as error:
            errors.append(str(error))
    raise ValueError("; alternate PSSI decoding also failed: ".join(errors))


def _decode_phrases(tag: bytes, beats: list[dict]) -> list[dict]:
    count, mood = u16(tag, 16), u16(tag, 18)
    if mood not in (1, 2, 3):
        raise ValueError(f"PSSI mood {mood} outside 1..3")
    end_beat = u16(tag, 26)
    available = max(0, (len(tag) - 32) // 24)
    if count > available:
        raise ValueError(f"PSSI declares {count} entries but contains {available}")
    if end_beat < 1 or end_beat > len(beats):
        raise ValueError(f"PSSI end beat {end_beat} has no PQTZ entry")
    raw = []
    for index in range(count):
        offset = 32 + index * 24
        beat_index, kind = u16(tag, offset + 2), u16(tag, offset + 4)
        if beat_index < 1 or beat_index > len(beats):
            raise ValueError(f"PSSI beat index {beat_index} has no PQTZ entry")
        raw.append((beat_index, kind, tag[offset + 7], tag[offset + 9], tag[offset + 19]))
    result = []
    for index, (beat_index, kind, k1, k2, k3) in enumerate(raw):
        next_index = raw[index + 1][0] if index + 1 < len(raw) else end_beat
        if next_index < beat_index or next_index > len(beats):
            raise ValueError(f"PSSI phrase end beat {next_index} is invalid after {beat_index}")
        start = beats[beat_index - 1]["time"]
        end = beats[max(beat_index - 1, next_index - 1)]["time"]
        result.append({"start": start, "end": max(start, end),
                       "label": phrase_label(mood, kind, k1, k2, k3),
                       "kind": kind, "mood": mood})
    return result


def phrase_label(mood: int, kind: int, k1: int = 0, k2: int = 0, k3: int = 0) -> str:
    """Verified Rekordbox/DeepSymmetry phrase names; raw codes remain in output."""
    if mood == 1:
        if kind == 1:
            return "Intro 1" if k1 == 1 else "Intro 2"
        if kind == 2:
            return {(0, 0): "Up 1", (0, 1): "Up 2", (1, 0): "Up 3"}.get((k2, k3), "Up")
        if kind == 3:
            return "Down"
        if kind == 5:
            return "Chorus 2" if k1 == 1 else "Chorus 1"
        if kind == 6:
            return "Outro 1" if k1 == 1 else "Outro 2"
    elif mood == 2:
        if kind == 1:
            return "Intro"
        if 2 <= kind <= 7:
            return f"Verse {kind - 1}"
        return {8: "Bridge", 9: "Chorus", 10: "Outro"}.get(kind, "Unclassified phrase")
    elif mood == 3:
        if kind == 1:
            return "Intro"
        if 2 <= kind <= 4:
            return "Verse 1"
        if 5 <= kind <= 7:
            return "Verse 2"
        return {8: "Bridge", 9: "Chorus", 10: "Outro"}.get(kind, "Unclassified phrase")
    return "Unclassified phrase"


def decode_pwav(tag: bytes) -> list[int]:
    count = u32(tag, 12)
    available = max(0, len(tag) - 20)
    if count > available:
        raise ValueError(f"PWAV declares {count} entries but contains {available}")
    values = [value & 0x1F for value in tag[20:20 + count]]
    if count <= 400:
        return values
    # Preserve peaks across the entire track instead of discarding the tail.
    return [max(values[index * count // 400:(index + 1) * count // 400])
            for index in range(400)]


BANDS_RATE = 25  # columns per second returned to the client


def decode_3band(tag: bytes) -> tuple[list[bytes], int | None]:
    """Decode a PWV7 (detail) or PWV6 (preview) 3-band waveform tag.

    Layout is read from the tag: u32 header length at +4, u32 bytes per entry
    at +12, u32 entry count at +16; PWV7 adds u16 entries/second at +20.
    Byte order was verified against the audio (per-band spectral correlation on
    real dubstep/DnB tracks): byte 0 = low, byte 1 = mid, byte 2 = high. This
    differs from the (mid, high, low) order in the published ANLZ notes.
    Returns ([low, mid, high], rate); rate is None for PWV6 (whole-track preview).
    """
    kind = tag[:4].decode("ascii")
    header = u32(tag, 4)
    if header < (22 if kind == "PWV7" else 20) or header > len(tag):
        raise ValueError(f"{kind} header length {header} is invalid")
    entry_bytes, count = u32(tag, 12), u32(tag, 16)
    if entry_bytes < 3:
        raise ValueError(f"{kind} entries are {entry_bytes} bytes, need 3")
    available = (len(tag) - header) // entry_bytes
    if count > available:
        raise ValueError(f"{kind} declares {count} entries but contains {available}")
    rate = None
    if kind == "PWV7":
        rate = u16(tag, 20)
        if rate < 1:
            raise ValueError("PWV7 declares 0 entries per second")
    end = header + count * entry_bytes
    return [tag[header + band:end:entry_bytes] for band in range(3)], rate


def compact_bands(bands: list[bytes], rate: int | None) -> dict:
    """Max-downsample to BANDS_RATE columns/second (PWV7 only) and scale 0..100.

    One global max across all three bands keeps their relative loudness. PWV6
    keeps its native columns; its rate (columns / track duration) is resolved
    by the API, which knows the duration.
    """
    columns: list = list(bands)
    if rate is not None:
        count = len(bands[0])
        starts = [column * rate // BANDS_RATE
                  for column in range(-(-count * BANDS_RATE // rate))]  # ceil
        columns = [[max(band[start:max(start + 1, (index + 1) * rate // BANDS_RATE)])
                    for index, start in enumerate(starts)] for band in bands]
    peak = max((max(band, default=0) for band in columns), default=0)
    low, mid, high = ([round(value * 100 / peak) if peak else 0 for value in band]
                      for band in columns)
    return {"rate": BANDS_RATE if rate is not None else None,
            "low": low, "mid": mid, "high": high}


def decode_bands(tags: dict[str, bytes], name: str, issues: list[str]) -> dict | None:
    """Prefer PWV7 detail; use the PWV6 preview only when PWV7 is absent or damaged."""
    for kind in ("PWV7", "PWV6"):
        if kind in tags:
            try:
                return compact_bands(*decode_3band(tags[kind]))
            except Exception as error:
                issues.append(f"{name}/{kind}: {type(error).__name__}: {error}")
    return None


def resolve_analysis_path(value: object) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("analysisDataPath must be a non-empty string")
    candidate = (SHARE / value.lstrip("/\\")).resolve()
    if not candidate.is_relative_to(USBANLZ):
        raise ValueError("analysisDataPath is outside the Rekordbox USBANLZ directory")
    if candidate.name.upper() != "ANLZ0000.DAT":
        raise ValueError("analysisDataPath must name ANLZ0000.DAT")
    return candidate


def extract(analysis_data_path: object) -> dict:
    observed_at = int(time.time())
    try:
        dat = resolve_analysis_path(analysis_data_path)
    except ValueError as error:
        return {"status": "missing", "source": "rekordbox", "beats": [], "phrases": [],
                "waveform": None, "bands": None, "issues": [str(error)],
                "observedAt": observed_at}
    paths = [dat, dat.with_suffix(".EXT")]
    existing = [path for path in paths if path.is_file()]
    if not existing:
        return {"status": "missing", "source": "rekordbox", "beats": [], "phrases": [],
                "waveform": None, "bands": None, "issues": ["mapped analysis files are missing"],
                "observedAt": observed_at}

    issues: list[str] = []
    beats: list[dict] = []
    pssi: bytes | None = None
    waveform = None
    for path in existing:
        for kind, tag in iter_tags(path, issues):
            try:
                if kind == "PQTZ" and not beats:
                    beats = decode_beats(tag)
                elif kind == "PSSI" and pssi is None:
                    pssi = tag
                elif kind == "PWAV" and waveform is None:
                    waveform = {"samples": decode_pwav(tag), "source": "PWAV"}
            except Exception as error:
                issues.append(f"{path.name}/{kind}: {type(error).__name__}: {error}")
    # Colour bands are optional: an absent .2EX is not an issue and does not
    # affect status; a damaged one is reported like any other damaged tag.
    bands = None
    two_ex = dat.with_suffix(".2EX")
    if two_ex.is_file():
        three_band = {kind: tag for kind, tag in iter_tags(two_ex, issues)
                      if kind in ("PWV7", "PWV6")}
        bands = decode_bands(three_band, two_ex.name, issues)
    phrases = []
    if pssi is not None:
        if beats:
            try:
                phrases = decode_phrases(pssi, beats)
            except Exception as error:
                issues.append(f"PSSI: {type(error).__name__}: {error}")
        else:
            issues.append("PSSI is present but PQTZ beat timing is unavailable")
    missing = [name for name, value in (("beat grid", beats), ("phrases", phrases),
                                        ("waveform preview", waveform)) if not value]
    if missing:
        issues.append("missing " + ", ".join(missing))
    status = "ready" if beats and phrases and waveform and not issues else "partial"
    return {"status": status, "source": "rekordbox", "beats": beats, "phrases": phrases,
            "waveform": waveform, "bands": bands, "issues": issues, "observedAt": observed_at}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = extract(payload.get("analysisDataPath") if isinstance(payload, dict) else None)
    except Exception as error:
        result = {"status": "missing", "source": "rekordbox", "beats": [], "phrases": [],
                  "waveform": None, "bands": None, "issues": [f"{type(error).__name__}: {error}"],
                  "observedAt": int(time.time())}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
