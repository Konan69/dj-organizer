#!/usr/bin/env python3
"""Render four sample-locked stems at a target BPM from one shared beat time map.

The beat map comes from the drums stem and the full mix; every stem is warped
through the same map with rubberband, then the output is checked for join
clicks and for a steady beat at the target tempo.
"""

from __future__ import annotations

import argparse
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.stats import rankdata


# Set once from the command line in main().
FULL_MIX: Path
STEM_DIR: Path
OUT_DIR: Path
STEMS = ("vocals", "other", "drums", "bass")
TARGET_BPM = 150.0
TARGET_BEAT_SECONDS = 60.0 / TARGET_BPM
SOURCE_BPM_PRIOR = 66.3
HOP = 256
CONFIDENCE_THRESHOLD = 0.55
MIN_SOURCE_BEAT = 0.80
MAX_SOURCE_BEAT = 1.00
SEMITONES = 2.0


def output_path(name: str) -> Path:
    return OUT_DIR / f"{name}_final_{TARGET_BPM:g}.wav"


def onset_track(path: Path) -> tuple[np.ndarray, np.ndarray, int]:
    audio, sr = librosa.load(path, sr=None, mono=True)
    onset = librosa.onset.onset_strength(
        y=audio, sr=sr, hop_length=HOP, aggregate=np.mean
    )
    times = librosa.times_like(onset, sr=sr, hop_length=HOP)
    return onset, times, sr


def local_peaks(
    beat_times: np.ndarray, onset: np.ndarray, onset_times: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    values = np.empty(len(beat_times), dtype=np.float64)
    times = np.empty(len(beat_times), dtype=np.float64)
    for index, beat_time in enumerate(beat_times):
        candidates = np.flatnonzero(np.abs(onset_times - beat_time) <= 0.070)
        if not len(candidates):
            chosen = int(np.argmin(np.abs(onset_times - beat_time)))
        else:
            chosen = int(candidates[np.argmax(onset[candidates])])
        values[index] = onset[chosen]
        times[index] = onset_times[chosen]
    return values, times


def sanitize_anchors(
    anchor_indices: list[int], anchor_times: np.ndarray, confidence: np.ndarray
) -> list[int]:
    """Drop the weaker point whenever adjacent anchors imply an unsafe period."""
    anchors = anchor_indices[:]
    changed = True
    while changed:
        changed = False
        previous_index = 0
        previous_time = 0.0
        for position, current_index in enumerate(anchors):
            current_time = float(anchor_times[current_index])
            period = (current_time - previous_time) / (current_index - previous_index)
            if MIN_SOURCE_BEAT <= period <= MAX_SOURCE_BEAT:
                previous_index = current_index
                previous_time = current_time
                continue

            if previous_index == 0:
                del anchors[position]
            else:
                previous_position = position - 1
                if confidence[previous_index] <= confidence[current_index]:
                    del anchors[previous_position]
                else:
                    del anchors[position]
            changed = True
            break
    return anchors


def build_shared_map() -> tuple[np.ndarray, np.ndarray, dict[str, object]]:
    drum_onset, drum_onset_times, drum_sr = onset_track(STEM_DIR / "drums.wav")
    mix_onset, mix_onset_times, _ = onset_track(FULL_MIX)

    _, base_beats = librosa.beat.beat_track(
        onset_envelope=drum_onset,
        sr=drum_sr,
        hop_length=HOP,
        bpm=SOURCE_BPM_PRIOR,
        tightness=400,
        trim=False,
        units="time",
    )
    base_beats = np.asarray(base_beats, dtype=np.float64)

    drum_values, drum_peak_times = local_peaks(
        base_beats, drum_onset, drum_onset_times
    )
    mix_values, mix_peak_times = local_peaks(base_beats, mix_onset, mix_onset_times)
    drum_rank = (rankdata(drum_values, method="average") - 1) / max(
        1, len(drum_values) - 1
    )
    mix_rank = (rankdata(mix_values, method="average") - 1) / max(
        1, len(mix_values) - 1
    )
    confidence = np.maximum(drum_rank, mix_rank)

    # The tightly constrained drum beat track supplies timing. Local peaks from
    # both the percussion stem and full mix decide which beats are trustworthy;
    # low-confidence positions are replaced by interpolation below.
    refined = base_beats.copy()
    candidates = [
        index
        for index in range(1, len(base_beats))
        if confidence[index] >= CONFIDENCE_THRESHOLD
    ]
    anchors = sanitize_anchors(candidates, refined, confidence)

    source_beats = np.empty(len(base_beats), dtype=np.float64)
    known_indices = np.asarray([0, *anchors], dtype=int)
    known_times = np.asarray([0.0, *(float(refined[index]) for index in anchors)])
    source_beats[: known_indices[-1] + 1] = np.interp(
        np.arange(known_indices[-1] + 1), known_indices, known_times
    )

    recent_periods = np.diff(source_beats[max(0, known_indices[-1] - 16) : known_indices[-1] + 1])
    tail_period = float(np.median(recent_periods))
    tail_period = float(np.clip(tail_period, MIN_SOURCE_BEAT, MAX_SOURCE_BEAT))
    for index in range(known_indices[-1] + 1, len(source_beats)):
        source_beats[index] = source_beats[index - 1] + tail_period

    stem_info = sf.info(STEM_DIR / "vocals.wav")
    duration = stem_info.frames / stem_info.samplerate
    extra_beats: list[float] = []
    next_beat = float(source_beats[-1] + tail_period)
    while next_beat < duration:
        extra_beats.append(next_beat)
        next_beat += tail_period
    if extra_beats:
        source_beats = np.concatenate((source_beats, np.asarray(extra_beats)))

    source_intervals = np.diff(source_beats)
    if not np.all((source_intervals >= MIN_SOURCE_BEAT) & (source_intervals <= MAX_SOURCE_BEAT)):
        bad = source_intervals[
            (source_intervals < MIN_SOURCE_BEAT) | (source_intervals > MAX_SOURCE_BEAT)
        ]
        raise RuntimeError(f"Source beat interval sanity gate failed: {bad}")

    anchor_set = set(anchors)
    interpolated_mask = np.asarray(
        [index not in anchor_set for index in range(len(source_beats))], dtype=bool
    )
    shaky_runs: list[tuple[int, int]] = []
    run_start: int | None = None
    for index, interpolated in enumerate(interpolated_mask):
        if interpolated and run_start is None:
            run_start = index
        if run_start is not None and (not interpolated or index == len(interpolated_mask) - 1):
            run_end = index - 1 if not interpolated else index
            if run_end - run_start + 1 >= 2:
                shaky_runs.append((run_start, run_end))
            run_start = None

    source_frames = np.rint(source_beats * stem_info.samplerate).astype(np.int64)
    target_frames = np.arange(len(source_beats), dtype=np.int64) * round(
        TARGET_BEAT_SECONDS * stem_info.samplerate
    )
    remaining_source = stem_info.frames - int(source_frames[-1])
    remaining_target = int(round(remaining_source / tail_period * TARGET_BEAT_SECONDS))
    target_end_frame = int(target_frames[-1]) + remaining_target

    source_frames = np.concatenate((source_frames, [stem_info.frames]))
    target_frames = np.concatenate((target_frames, [target_end_frame]))
    if not (np.all(np.diff(source_frames) > 0) and np.all(np.diff(target_frames) > 0)):
        raise RuntimeError("Time-map frame positions are not strictly monotonic")

    report: dict[str, object] = {
        "sample_rate": stem_info.samplerate,
        "input_frames": stem_info.frames,
        "input_duration": duration,
        "base_count": len(base_beats),
        "beat_count": len(source_beats),
        "anchor_count": len(anchors),
        "interpolated_count": int(np.sum(interpolated_mask)),
        "source_median": float(np.median(source_intervals)),
        "source_p10": float(np.percentile(source_intervals, 10)),
        "source_p90": float(np.percentile(source_intervals, 90)),
        "source_min": float(np.min(source_intervals)),
        "source_max": float(np.max(source_intervals)),
        "tail_period": tail_period,
        "target_frames": target_end_frame,
        "target_duration": target_end_frame / stem_info.samplerate,
        "shaky_runs": [
            (
                start,
                end,
                float(source_beats[start]),
                float(source_beats[end]),
            )
            for start, end in shaky_runs
        ],
        "join_frames": target_frames[1:-1],
    }
    return source_frames, target_frames, report


def render(source_frames: np.ndarray, target_frames: np.ndarray, report: dict[str, object]) -> None:
    OUT_DIR.mkdir(exist_ok=True)
    output_paths = {name: output_path(name) for name in STEMS}
    occupied = [path for path in output_paths.values() if path.exists()]
    if occupied:
        raise FileExistsError(f"Refusing to overwrite: {occupied}")
    if shutil.which("rubberband") is None:
        raise RuntimeError("rubberband executable is not available")

    with tempfile.NamedTemporaryFile(mode="w", suffix=".timemap", delete=True) as map_file:
        for source_frame, target_frame in zip(source_frames, target_frames, strict=True):
            map_file.write(f"{int(source_frame)} {int(target_frame)}\n")
        map_file.flush()

        target_duration = float(report["target_duration"])
        for name in STEMS:
            source = STEM_DIR / f"{name}.wav"
            output = output_paths[name]
            command = [
                "rubberband",
                "-q",
                "-3",
                "--centre-focus",
                "-p",
                f"{SEMITONES:g}",
                "-M",
                map_file.name,
                "-D",
                f"{target_duration:.12f}",
                str(source),
                str(output),
            ]
            print(f"RENDER {name}: {' '.join(command)}", flush=True)
            subprocess.run(command, check=True)
            info = sf.info(output)
            if info.samplerate != report["sample_rate"] or info.channels != 2:
                raise RuntimeError(f"Unexpected format for {output}: {info}")
            if abs(info.frames - int(report["target_frames"])) > 1:
                raise RuntimeError(
                    f"Unexpected length for {output}: {info.frames} vs {report['target_frames']}"
                )


def verify(report: dict[str, object]) -> None:
    sample_rate = int(report["sample_rate"])
    join_frames = np.asarray(report["join_frames"], dtype=np.int64)
    print("\nOUTPUT VERIFICATION")
    for name in STEMS:
        path = output_path(name)
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        peak = float(np.max(np.abs(audio)))
        differences = np.abs(np.diff(audio, axis=0))
        all_large = int(np.sum(np.any(differences > 0.3, axis=1)))
        valid_joins = join_frames[(join_frames > 1) & (join_frames < len(audio) - 2)]
        join_delta = np.max(
            np.abs(audio[valid_joins] - audio[valid_joins - 1]), axis=1
        )
        suspicious = 0
        for frame, delta in zip(valid_joins, join_delta, strict=True):
            if delta <= 0.3:
                continue
            local = differences[max(0, frame - 256) : min(len(differences), frame + 256)]
            local_channel_max = np.max(local, axis=1)
            local_without_join = np.delete(local_channel_max, min(255, frame - max(0, frame - 256) - 1))
            local_p99 = float(np.percentile(local_without_join, 99)) if len(local_without_join) else 0.0
            if delta > max(0.3, 3.0 * local_p99):
                suspicious += 1
        print(
            f"{name}: duration={len(audio) / sr:.9f}s frames={len(audio)} "
            f"peak={peak:.6f} ({20 * math.log10(max(peak, 1e-12)):.2f} dBFS) "
            f"all_jumps_gt_0.3={all_large} max_join_jump={float(np.max(join_delta)):.6f} "
            f"unexplained_join_clicks={suspicious}"
        )
        if suspicious:
            raise RuntimeError(f"Found {suspicious} suspicious join clicks in {path}")

    drums, sr = librosa.load(output_path("drums"), sr=None, mono=True)
    onset = librosa.onset.onset_strength(y=drums, sr=sr, hop_length=128, aggregate=np.mean)
    _, detected = librosa.beat.beat_track(
        onset_envelope=onset,
        sr=sr,
        hop_length=128,
        bpm=TARGET_BPM,
        tightness=4000,
        trim=False,
        units="time",
    )
    intervals = np.diff(np.asarray(detected))
    median = float(np.median(intervals))
    p10 = float(np.percentile(intervals, 10))
    p90 = float(np.percentile(intervals, 90))
    spread_percent = (p90 - p10) / median * 100
    print(
        f"detected_output_beats={len(detected)} median={median:.9f}s "
        f"p10={p10:.9f}s p90={p90:.9f}s spread={spread_percent:.4f}%"
    )
    if abs(median - TARGET_BEAT_SECONDS) / TARGET_BEAT_SECONDS > 0.01:
        raise RuntimeError("Detected output beat median is outside the 1% tolerance")
    if spread_percent >= 1.5:
        raise RuntimeError("Detected output beat p10-p90 spread is not under 1.5%")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mix", type=Path, required=True, help="full mix WAV used to confirm beats")
    parser.add_argument("--stems", type=Path, required=True,
                        help="folder holding vocals.wav, other.wav, drums.wav and bass.wav (htdemucs layout)")
    parser.add_argument("--out", type=Path, required=True,
                        help="output folder; <stem>_final_<bpm>.wav files are never overwritten")
    parser.add_argument("--bpm", type=float, default=TARGET_BPM, help="target tempo (default: %(default)s)")
    parser.add_argument("--source-bpm", type=float, default=SOURCE_BPM_PRIOR,
                        help="tempo prior for the source beat tracker (default: %(default)s)")
    parser.add_argument("--min-source-beat", type=float, default=MIN_SOURCE_BEAT,
                        help="shortest believable source beat in seconds (default: %(default)s)")
    parser.add_argument("--max-source-beat", type=float, default=MAX_SOURCE_BEAT,
                        help="longest believable source beat in seconds (default: %(default)s)")
    parser.add_argument("--semitones", type=float, default=SEMITONES,
                        help="pitch shift applied to every stem (default: %(default)s)")
    return parser.parse_args()


def main() -> None:
    global FULL_MIX, STEM_DIR, OUT_DIR, TARGET_BPM, TARGET_BEAT_SECONDS
    global SOURCE_BPM_PRIOR, MIN_SOURCE_BEAT, MAX_SOURCE_BEAT, SEMITONES
    args = parse_args()
    FULL_MIX, STEM_DIR, OUT_DIR = args.mix, args.stems, args.out
    TARGET_BPM, TARGET_BEAT_SECONDS = args.bpm, 60.0 / args.bpm
    SOURCE_BPM_PRIOR = args.source_bpm
    MIN_SOURCE_BEAT, MAX_SOURCE_BEAT = args.min_source_beat, args.max_source_beat
    SEMITONES = args.semitones

    source_frames, target_frames, report = build_shared_map()
    print("SHARED MAP")
    for key in (
        "input_duration",
        "base_count",
        "beat_count",
        "anchor_count",
        "interpolated_count",
        "source_median",
        "source_p10",
        "source_p90",
        "source_min",
        "source_max",
        "tail_period",
        "target_frames",
        "target_duration",
    ):
        print(f"{key}={report[key]}")
    print("SHAKY/INTERPOLATED RUNS (2+ beats)")
    for run in report["shaky_runs"]:
        print(f"beats={run[0]}-{run[1]} source={run[2]:.3f}-{run[3]:.3f}s")
    render(source_frames, target_frames, report)
    verify(report)


if __name__ == "__main__":
    main()
