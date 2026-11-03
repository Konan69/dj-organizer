import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rekordbox_analysis as analysis
from rekordbox_bridge import normalized_cue


def tag(kind, content, header_length=12):
    return kind.encode("ascii") + struct.pack(">II", header_length, 12 + len(content)) + content


def pqtz(entries):
    content = b"\0" * 4 + struct.pack(">II", 0x80000, len(entries))
    content += b"".join(struct.pack(">HHI", beat, round(bpm * 100), ms)
                        for beat, bpm, ms in entries)
    return tag("PQTZ", content, 24)


def pssi(entries, mood=2, end_beat=None):
    content = struct.pack(">IHH", 24, len(entries), mood) + b"\0" * 6
    content += struct.pack(">H", end_beat or entries[-1][0]) + b"\0" * 2 + b"\1\0"
    for index, entry in enumerate(entries, 1):
        beat_index, kind, *flags = entry
        k1, k2, k3 = (flags + [0, 0, 0])[:3]
        body = bytearray(struct.pack(">HHH", index, beat_index, kind) + b"\0" * 18)
        body[7], body[9], body[19] = k1, k2, k3
        content += body
    return tag("PSSI", content, 32)


def pwav(samples):
    return tag("PWAV", struct.pack(">II", len(samples), 0x10000) + bytes(samples), 20)


def pwv7(entries, rate=150, header_padding=b""):
    # (low, mid, high) byte triples; header length is taken from the tag bytes.
    content = struct.pack(">IIHH", 3, len(entries), rate, 0) + header_padding
    return tag("PWV7", content + bytes(v for entry in entries for v in entry),
               24 + len(header_padding))


def pwv6(entries):
    content = struct.pack(">II", 3, len(entries))
    return tag("PWV6", content + bytes(v for entry in entries for v in entry), 20)


def anlz(*tags, declared_extra=0):
    body = b"".join(tags)
    return b"PMAI" + struct.pack(">II", 28, 28 + len(body) + declared_extra) + b"\0" * 16 + body


class RekordboxAnalysisTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.share = Path(self.temp.name) / "share"
        self.root = self.share / "PIONEER" / "USBANLZ"
        self.directory = self.root / "001" / "track"
        self.directory.mkdir(parents=True)
        self.dat = self.directory / "ANLZ0000.DAT"
        self.relative = "/PIONEER/USBANLZ/001/track/ANLZ0000.DAT"
        self.patchers = [patch.object(analysis, "SHARE", self.share.resolve()),
                         patch.object(analysis, "USBANLZ", self.root.resolve())]
        for item in self.patchers:
            item.start()

    def tearDown(self):
        for item in reversed(self.patchers):
            item.stop()
        self.temp.cleanup()

    def test_extracts_seconds_bpm_phrases_and_compact_waveform(self):
        beats = [(1, 120.5, 500), (2, 120.5, 1000), (3, 120.5, 1500),
                 (4, 120.5, 2000), (1, 121, 2500)]
        self.dat.write_bytes(anlz(pqtz(beats), pwav([0xE1, 0x1F, 0x20])))
        self.dat.with_suffix(".EXT").write_bytes(anlz(pssi([(1, 4), (5, 7)], mood=2)))
        result = analysis.extract(self.relative)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["beats"][0], {"time": 0.5, "beat": 1, "bpm": 120.5})
        self.assertEqual(result["phrases"], [
            {"start": 0.5, "end": 2.5, "label": "Verse 3", "kind": 4, "mood": 2},
            {"start": 2.5, "end": 2.5, "label": "Verse 6", "kind": 7, "mood": 2},
        ])
        self.assertEqual(result["waveform"], {"samples": [1, 31, 0], "source": "PWAV"})

    def test_keeps_good_tags_when_a_later_tag_is_malformed(self):
        good = pqtz([(1, 128, 250)])
        bad = b"BROK" + struct.pack(">II", 12, 9999)
        self.dat.write_bytes(anlz(good, bad))
        result = analysis.extract(self.relative)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["beats"][0]["time"], 0.25)
        self.assertTrue(any("invalid BROK length" in issue for issue in result["issues"]))

    def test_rejects_paths_outside_usbanlz(self):
        outside = Path(self.temp.name) / "secret.DAT"
        outside.write_text("do not read")
        result = analysis.extract("../../secret.DAT")
        self.assertEqual(result["status"], "missing")
        self.assertEqual(result["beats"], [])
        self.assertTrue(any("outside" in issue for issue in result["issues"]))

    def test_cli_contract_is_json_serializable(self):
        self.dat.write_bytes(anlz(pqtz([(1, 100, 0)])))
        json.dumps(analysis.extract(self.relative))

    def test_phrase_labels_depend_on_mood_and_flags(self):
        self.assertEqual(analysis.phrase_label(1, 1, k1=1), "Intro 1")
        self.assertEqual(analysis.phrase_label(1, 1, k1=0), "Intro 2")
        self.assertEqual(analysis.phrase_label(1, 2, k2=0, k3=1), "Up 2")
        self.assertEqual(analysis.phrase_label(1, 5, k1=1), "Chorus 2")
        self.assertEqual(analysis.phrase_label(2, 8), "Bridge")
        self.assertEqual(analysis.phrase_label(2, 9), "Chorus")
        self.assertEqual(analysis.phrase_label(3, 6), "Verse 2")
        self.assertEqual(analysis.phrase_label(99, 1), "Unclassified phrase")

    def test_final_phrase_uses_saved_end_beat_before_grid_end(self):
        beats = [(index % 4 + 1, 120, index * 500) for index in range(8)]
        self.dat.write_bytes(anlz(pqtz(beats)))
        self.dat.with_suffix(".EXT").write_bytes(
            anlz(pssi([(1, 1), (3, 9)], mood=2, end_beat=5)))
        result = analysis.extract(self.relative)
        self.assertEqual(result["phrases"][-1]["start"], 1.0)
        self.assertEqual(result["phrases"][-1]["end"], 2.0)
        self.assertNotEqual(result["phrases"][-1]["end"], result["beats"][-1]["time"])

    def test_long_waveform_compacts_peaks_across_the_tail(self):
        samples = [0] * 800
        samples[-1] = 31
        compact = analysis.decode_pwav(pwav(samples))
        self.assertEqual(len(compact), 400)
        self.assertEqual(compact[-1], 31)

    def test_declared_file_truncation_is_reported_without_losing_good_tags(self):
        self.dat.write_bytes(anlz(pqtz([(1, 120, 0)]), declared_extra=20))
        result = analysis.extract(self.relative)
        self.assertEqual(len(result["beats"]), 1)
        self.assertTrue(any("truncated file" in issue for issue in result["issues"]))

    def test_pwv7_bands_are_low_mid_high_max_downsampled_to_25_per_second(self):
        # 13 entries at 150/s -> 3 columns of 6, 6 and 1 entries.
        entries = [(10, 20, 30)] * 13
        entries[2] = (80, 20, 30)      # low peak inside column 0
        entries[9] = (10, 60, 200)     # track-wide max, in the high band
        entries[12] = (40, 0, 0)       # lone entry in the final partial column
        bands = analysis.compact_bands(*analysis.decode_3band(pwv7(entries)))
        self.assertEqual(bands["rate"], 25)
        # One global max (200) scales every band, preserving relative loudness.
        self.assertEqual(bands["low"], [40, 5, 20])
        self.assertEqual(bands["mid"], [10, 30, 0])
        self.assertEqual(bands["high"], [15, 100, 0])

    def test_pwv7_header_length_is_read_from_the_tag(self):
        padded = pwv7([(50, 25, 0)] * 6, header_padding=b"\xff" * 4)
        bands = analysis.compact_bands(*analysis.decode_3band(padded))
        self.assertEqual((bands["low"], bands["mid"], bands["high"]), ([100], [50], [0]))

    def test_silent_bands_scale_to_zero(self):
        bands = analysis.compact_bands(*analysis.decode_3band(pwv7([(0, 0, 0)] * 7)))
        self.assertEqual(bands, {"rate": 25, "low": [0, 0], "mid": [0, 0], "high": [0, 0]})

    def test_extract_reads_2ex_and_prefers_pwv7_without_changing_status(self):
        beats = [(1, 120, 0), (2, 120, 500)]
        self.dat.write_bytes(anlz(pqtz(beats), pwav([5, 10])))
        self.dat.with_suffix(".EXT").write_bytes(anlz(pssi([(1, 1)], mood=2, end_beat=2)))
        self.dat.with_suffix(".2EX").write_bytes(
            anlz(pwv7([(100, 50, 25)] * 12), pwv6([(1, 1, 1)] * 1200)))
        result = analysis.extract(self.relative)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["bands"], {"rate": 25, "low": [100, 100],
                                           "mid": [50, 50], "high": [25, 25]})

    def test_falls_back_to_pwv6_preview_with_native_columns(self):
        self.dat.write_bytes(anlz(pqtz([(1, 120, 0)])))
        self.dat.with_suffix(".2EX").write_bytes(anlz(pwv6([(0, 30, 60), (120, 0, 0)])))
        bands = analysis.extract(self.relative)["bands"]
        # The API resolves the rate from the track duration (columns / seconds).
        self.assertEqual(bands, {"rate": None, "low": [0, 100], "mid": [25, 0],
                                 "high": [50, 0]})

    def test_missing_2ex_is_not_an_issue(self):
        beats = [(1, 120, 0), (2, 120, 500)]
        self.dat.write_bytes(anlz(pqtz(beats), pwav([5, 10])))
        self.dat.with_suffix(".EXT").write_bytes(anlz(pssi([(1, 1)], mood=2, end_beat=2)))
        result = analysis.extract(self.relative)
        self.assertEqual(result["status"], "ready")
        self.assertIsNone(result["bands"])
        self.assertEqual(result["issues"], [])

    def test_damaged_pwv7_is_reported_and_pwv6_is_used(self):
        broken = bytearray(pwv7([(1, 2, 3)] * 6))
        broken[16:20] = struct.pack(">I", 999)  # declares more entries than present
        self.dat.write_bytes(anlz(pqtz([(1, 120, 0)])))
        self.dat.with_suffix(".2EX").write_bytes(anlz(bytes(broken), pwv6([(4, 2, 1)])))
        result = analysis.extract(self.relative)
        self.assertEqual(result["bands"]["low"], [100])
        self.assertTrue(any("PWV7" in issue and "999" in issue for issue in result["issues"]))

    def test_cue_hot_slot_skips_four_and_preserves_time_past_rounded_duration(self):
        cue = SimpleNamespace(ID="cue", Kind=5, Comment="", InMsec=12000, OutMsec=14000)
        # A rounded metadata duration could be 10s; the native 12s/14s values
        # still remain exact for validation against the real audio later.
        self.assertEqual(normalized_cue(cue), {
            "id": "cue", "time": 12.0, "endTime": 14.0, "kind": "hot",
            "index": 4, "rawKind": 5, "label": "Hot cue D", "comment": None,
        })
        reserved = SimpleNamespace(ID="loop", Kind=4, Comment=None, InMsec=1000, OutMsec=-1)
        result = normalized_cue(reserved)
        self.assertEqual((result["kind"], result["index"], result["rawKind"]),
                         ("memory", None, 4))


if __name__ == "__main__":
    unittest.main()
