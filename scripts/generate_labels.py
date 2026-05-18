#!/usr/bin/env python3
"""
Generate n-shot example files, inference file, and quick test file
from swat_raw_labeled.csv.

Usage:
    python 1_prepare_data/generate_labels.py

Output:
    - swat_normal.csv          (n-shot: 2000 rows from normal operation)
    - swat_attack.csv          (n-shot: 2000 rows from attack periods)
    - swat_inference.csv       (remaining data, no label column)
    - swat_quick_test_200.csv  (contiguous 200-row block, no label)

IMPORTANT: Quick test uses a CONTIGUOUS block of 200 consecutive rows,
NOT randomly sampled rows. Random sampling destroys temporal ordering
that the omega model relies on.

Prerequisites:
    - Run convert_swat_data.py first
"""

import csv
import os
import random
import sys

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")

N_SHOT_PER_CLASS = 2000
QUICK_TEST_ROWS = 200
RANDOM_SEED = 42

CLASS_NORMAL = "normal"
CLASS_ATTACK = "attack"


def main():
    print("=" * 70)
    print(" SWaT Dataset - Generate Labels & Splits")
    print("=" * 70)
    print()

    random.seed(RANDOM_SEED)

    labeled_file = os.path.join(DATA_DIR, "swat_raw_labeled.csv")
    if not os.path.exists(labeled_file):
        print(f"  ERROR: {labeled_file} not found.")
        print(f"  Run 'python 1_prepare_data/convert_swat_data.py' first.")
        sys.exit(1)

    # Load all rows
    print("[1/4] Loading labeled data...")
    all_rows = []
    header = None

    with open(labeled_file, "r") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames
        for row in reader:
            all_rows.append(row)

    total = len(all_rows)
    normal_count = sum(1 for r in all_rows if r["label"] == CLASS_NORMAL)
    attack_count = sum(1 for r in all_rows if r["label"] == CLASS_ATTACK)

    print(f"  Total rows: {total:,}")
    print(f"  Normal:     {normal_count:,}")
    print(f"  Attack:     {attack_count:,}")
    print()

    # Sensor columns (everything except timestamp and label)
    sensor_cols = [c for c in header if c not in ("timestamp", "label")]
    inference_header = ["timestamp"] + sensor_cols

    # --- N-shot: normal (contiguous block from normal-only region) ---
    print("[2/4] Creating n-shot files...")

    # Find contiguous normal regions
    normal_nshot_rows = []
    # Look for a long run of normal rows and take a contiguous block
    run_start = None
    best_run_start = 0
    best_run_len = 0
    current_run_len = 0

    for i, row in enumerate(all_rows):
        if row["label"] == CLASS_NORMAL:
            if run_start is None:
                run_start = i
            current_run_len += 1
        else:
            if current_run_len > best_run_len:
                best_run_start = run_start
                best_run_len = current_run_len
            run_start = None
            current_run_len = 0

    if current_run_len > best_run_len:
        best_run_start = run_start
        best_run_len = current_run_len

    # Take n-shot normal from the middle of the longest normal run
    normal_start = best_run_start + (best_run_len // 2) - (N_SHOT_PER_CLASS // 2)
    normal_start = max(best_run_start, normal_start)
    normal_nshot_rows = all_rows[normal_start:normal_start + N_SHOT_PER_CLASS]
    print(f"  Normal n-shot: {len(normal_nshot_rows)} rows from index {normal_start}")

    # --- N-shot: attack (contiguous block from attack region) ---
    # Find contiguous attack regions
    attack_runs = []
    run_start = None
    current_run_len = 0

    for i, row in enumerate(all_rows):
        if row["label"] == CLASS_ATTACK:
            if run_start is None:
                run_start = i
            current_run_len += 1
        else:
            if run_start is not None and current_run_len > 0:
                attack_runs.append((run_start, current_run_len))
            run_start = None
            current_run_len = 0

    if run_start is not None and current_run_len > 0:
        attack_runs.append((run_start, current_run_len))

    # Sort by length, take from longest attack runs
    attack_runs.sort(key=lambda x: x[1], reverse=True)
    attack_nshot_rows = []
    for start, length in attack_runs:
        if len(attack_nshot_rows) >= N_SHOT_PER_CLASS:
            break
        needed = N_SHOT_PER_CLASS - len(attack_nshot_rows)
        take = min(needed, length)
        attack_nshot_rows.extend(all_rows[start:start + take])

    print(f"  Attack n-shot: {len(attack_nshot_rows)} rows from {len(attack_runs)} attack regions")

    # Collect n-shot timestamps for exclusion
    nshot_timestamps = set()
    for r in normal_nshot_rows + attack_nshot_rows:
        nshot_timestamps.add(int(r["timestamp"]))

    # Write n-shot files
    nshot_normal_path = os.path.join(DATA_DIR, "swat_normal.csv")
    nshot_attack_path = os.path.join(DATA_DIR, "swat_attack.csv")

    for path, rows in [
        (nshot_normal_path, normal_nshot_rows),
        (nshot_attack_path, attack_nshot_rows),
    ]:
        with open(path, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(inference_header)
            for r in rows:
                writer.writerow([r["timestamp"]] + [r[c] for c in sensor_cols])
        print(f"  {os.path.basename(path)}: {len(rows)} rows")
    print()

    # --- Quick test: contiguous block that includes some attack rows ---
    print("[3/4] Creating quick test file (contiguous block)...")

    # Find a region that transitions from normal to attack for an interesting test
    qt_rows = None
    for start, length in attack_runs:
        # Take 100 rows before the attack starts + 100 rows of attack
        qt_start = max(0, start - 100)
        candidate = all_rows[qt_start:qt_start + QUICK_TEST_ROWS]
        # Make sure none overlap with n-shot
        overlap = any(int(r["timestamp"]) in nshot_timestamps for r in candidate)
        if not overlap and len(candidate) == QUICK_TEST_ROWS:
            qt_rows = candidate
            n_normal_qt = sum(1 for r in qt_rows if r["label"] == CLASS_NORMAL)
            n_attack_qt = sum(1 for r in qt_rows if r["label"] == CLASS_ATTACK)
            print(f"  Transition block at index {qt_start}: {n_normal_qt} normal + {n_attack_qt} attack")
            break

    if qt_rows is None:
        # Fallback: just take a contiguous block from attack region
        for start, length in attack_runs:
            if length >= QUICK_TEST_ROWS:
                candidate = all_rows[start:start + QUICK_TEST_ROWS]
                overlap = any(int(r["timestamp"]) in nshot_timestamps for r in candidate)
                if not overlap:
                    qt_rows = candidate
                    print(f"  Attack block at index {start}")
                    break

    # If transition-based selection failed, try further into the attack region
    if qt_rows is None:
        for start, length in attack_runs:
            # Skip past the n-shot attack rows
            safe_start = start + N_SHOT_PER_CLASS + 100
            if safe_start + QUICK_TEST_ROWS <= start + length:
                candidate = all_rows[safe_start:safe_start + QUICK_TEST_ROWS]
                overlap = any(int(r["timestamp"]) in nshot_timestamps for r in candidate)
                if not overlap:
                    qt_rows = candidate
                    n_normal_qt = sum(1 for r in qt_rows if r["label"] == CLASS_NORMAL)
                    n_attack_qt = sum(1 for r in qt_rows if r["label"] == CLASS_ATTACK)
                    print(f"  Attack block at index {safe_start}: {n_normal_qt} normal + {n_attack_qt} attack")
                    break

    # Last resort: take from normal region
    if qt_rows is None:
        qt_start = best_run_start + best_run_len - N_SHOT_PER_CLASS - QUICK_TEST_ROWS - 100
        qt_start = max(0, qt_start)
        candidate = all_rows[qt_start:qt_start + QUICK_TEST_ROWS]
        overlap = any(int(r["timestamp"]) in nshot_timestamps for r in candidate)
        if not overlap and len(candidate) == QUICK_TEST_ROWS:
            qt_rows = candidate
            print(f"  Normal block at index {qt_start}")

    qt_timestamps = set()
    if qt_rows:
        qt_path = os.path.join(DATA_DIR, "swat_quick_test_200.csv")
        with open(qt_path, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(inference_header)
            for r in qt_rows:
                writer.writerow([r["timestamp"]] + [r[c] for c in sensor_cols])
                qt_timestamps.add(int(r["timestamp"]))
        print(f"  {os.path.basename(qt_path)}: {len(qt_rows)} rows")
    else:
        print("  WARNING: Could not find suitable quick test block")
    print()

    # --- Inference: everything not in n-shot or quick test ---
    print("[4/4] Creating inference file...")

    exclude_ts = nshot_timestamps | qt_timestamps
    inference_path = os.path.join(DATA_DIR, "swat_inference.csv")
    inference_count = 0

    with open(inference_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(inference_header)
        for r in all_rows:
            ts = int(r["timestamp"])
            if ts in exclude_ts:
                continue
            writer.writerow([r["timestamp"]] + [r[c] for c in sensor_cols])
            inference_count += 1

    inf_size_mb = os.path.getsize(inference_path) / 1024 / 1024
    print(f"  {os.path.basename(inference_path)}: {inference_count:,} rows ({inf_size_mb:.1f} MB)")
    print()

    # Summary
    print("=" * 70)
    print(" Output Files")
    print("=" * 70)
    print()
    print(f"  {'File':<35s} {'Rows':>10} {'Description'}")
    print(f"  {'-'*70}")
    print(f"  {'swat_normal.csv':<35s} {len(normal_nshot_rows):>10,} N-shot: normal operation")
    print(f"  {'swat_attack.csv':<35s} {len(attack_nshot_rows):>10,} N-shot: attack periods")
    print(f"  {'swat_inference.csv':<35s} {inference_count:>10,} Batch inference (no label)")
    print(f"  {'swat_quick_test_200.csv':<35s} {len(qt_rows) if qt_rows else 0:>10} Quick test (contiguous)")
    print(f"  {'swat_raw_labeled.csv':<35s} {total:>10,} Full labeled dataset")
    print()
    print("=" * 70)


if __name__ == "__main__":
    main()
