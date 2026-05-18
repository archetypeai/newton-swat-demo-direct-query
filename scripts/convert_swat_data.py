#!/usr/bin/env python3
"""
Convert SWaT (Secure Water Treatment) dataset into a format suitable
for the Archetype AI Machine State pipeline.

Usage:
    python 1_prepare_data/convert_swat_data.py

Reads the normal and attack CSV files from the Kaggle mirror, combines them,
adds sequential timestamps, selects sensor/actuator columns, and writes a
labeled output CSV.

Prerequisites:
    - Download from Kaggle: https://www.kaggle.com/datasets/vishala28/swat-dataset-secure-water-treatment-system
    - Place CSV files in data/ directory

Output:
    - data/swat_raw_labeled.csv
"""

import csv
import glob
import os
import sys
import time

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")

# SWaT sensor and actuator columns (51 total across 6 stages)
# Sensors: FIT, LIT, AIT, DPIT, PIT, UV (25 total)
# Actuators: MV, P (26 total)
# 11 actuators are constant (never change) and can optionally be dropped
CONSTANT_ACTUATORS = {
    "P102", "P201", "P202", "P204", "P206",
    "P401", "P403", "P404", "P502", "P601", "P603",
}

CLASS_NORMAL = "normal"
CLASS_ATTACK = "attack"


def find_csv_files() -> dict:
    """Find normal and attack CSV files in data/."""
    files = {}

    # Try common naming patterns from the Kaggle mirror
    patterns = {
        "normal": [
            "SWaT_Dataset_Normal_v1.csv",
            "SWaT_Dataset_Normal_v0.csv",
            "normal.csv",
            "Normal.csv",
            "swat_normal.csv",
        ],
        "attack": [
            "SWaT_Dataset_Attack_v0.csv",
            "attack.csv",
            "Attack.csv",
            "swat_attack.csv",
        ],
    }

    for split, names in patterns.items():
        for name in names:
            path = os.path.join(DATA_DIR, name)
            if os.path.exists(path):
                files[split] = path
                break

    # Also check for a merged file
    for name in ["merged.csv", "SWaT.csv", "swat.csv"]:
        path = os.path.join(DATA_DIR, name)
        if os.path.exists(path):
            files["merged"] = path
            break

    if not files:
        # List what's actually in data/
        available = [f for f in os.listdir(DATA_DIR) if f.endswith(".csv")]
        print(f"  ERROR: No SWaT CSV files found in {DATA_DIR}/")
        print(f"  Available files: {available}")
        print()
        print(f"  Download from: https://www.kaggle.com/datasets/vishala28/swat-dataset-secure-water-treatment-system")
        print(f"  Place CSV files in: {DATA_DIR}/")
        sys.exit(1)

    return files


def detect_columns(fpath: str) -> tuple:
    """Read header and detect sensor columns and label column."""
    with open(fpath, "r") as f:
        # Handle potential BOM and whitespace
        header_line = f.readline()
        header = [col.strip().strip('"').strip() for col in header_line.split(",")]

    # Find sensor/actuator columns (exclude timestamp and label)
    label_col = None
    timestamp_col = None
    sensor_cols = []

    for col in header:
        col_clean = col.strip()
        if col_clean.lower() in ("normal/attack", "label", "attack", "normal/a]ttack"):
            label_col = col
        elif col_clean.lower() in ("timestamp", "datetime", "date", " timestamp"):
            timestamp_col = col
        elif col_clean and col_clean not in ("", "Unnamed: 0"):
            sensor_cols.append(col)

    return header, sensor_cols, timestamp_col, label_col


def read_csv_rows(fpath: str, sensor_cols: list, label_col: str,
                  drop_constant: bool = True) -> list:
    """Read rows from a CSV file, returning (sensor_values, label) tuples.

    Uses forward-fill for missing values: if a sensor didn't report,
    use its last known value. Only drops a row if it has no prior value
    to fill from (i.e., missing at the very start before any valid reading).
    """
    rows = []
    cols_to_use = [c for c in sensor_cols
                   if not drop_constant or c not in CONSTANT_ACTUATORS]

    # Track last known value per column for forward-fill
    last_known = {}
    skipped_no_fill = 0

    with open(fpath, "r") as f:
        reader = csv.DictReader(f)
        # Clean up header names (handle whitespace)
        if reader.fieldnames:
            reader.fieldnames = [fn.strip().strip('"').strip() for fn in reader.fieldnames]

        for i, row in enumerate(reader):
            # Get label
            label_raw = None
            if label_col and label_col in row:
                label_raw = row[label_col].strip().strip('"').strip()
            elif label_col:
                # Try stripped version
                for k in row:
                    if k.strip() == label_col.strip():
                        label_raw = row[k].strip().strip('"').strip()
                        break

            # Map label
            if label_raw is None:
                label = CLASS_NORMAL  # default for normal-only files
            elif label_raw.lower() in ("normal", "0", "1"):
                label = CLASS_NORMAL
            elif label_raw.lower() in ("attack", "a]ttack", "-1"):
                label = CLASS_ATTACK
            else:
                label = CLASS_NORMAL

            # Get sensor values with forward-fill
            vals = {}
            skip = False
            for col in cols_to_use:
                raw = None
                if col in row:
                    raw = row[col]
                else:
                    for k in row:
                        if k.strip() == col.strip():
                            raw = row[k]
                            break

                parsed = None
                if raw is not None:
                    raw = raw.strip()
                    if raw not in ("", "nan", "NaN", "None", "inf", "-inf"):
                        try:
                            parsed = float(raw)
                        except ValueError:
                            pass

                if parsed is not None:
                    vals[col] = parsed
                    last_known[col] = parsed
                elif col in last_known:
                    # Forward-fill from last known value
                    vals[col] = last_known[col]
                else:
                    # No prior value to fill from
                    skip = True
                    break

            if not skip:
                rows.append((vals, label))
            else:
                skipped_no_fill += 1

            if (i + 1) % 100_000 == 0:
                print(f"    Read {i + 1:,} rows ({len(rows):,} valid, {skipped_no_fill} skipped)...")

    if skipped_no_fill:
        print(f"    Skipped {skipped_no_fill} rows (no prior value for forward-fill)")

    return rows, cols_to_use


def main():
    print("=" * 70)
    print(" SWaT Dataset - Data Converter")
    print("=" * 70)
    print()

    # Find files
    print("[1/3] Finding SWaT CSV files...")
    files = find_csv_files()
    for split, path in files.items():
        size_mb = os.path.getsize(path) / 1024 / 1024
        print(f"  {split}: {os.path.basename(path)} ({size_mb:.1f} MB)")
    print()

    # Detect columns from first available file
    first_file = list(files.values())[0]
    header, sensor_cols, timestamp_col, label_col = detect_columns(first_file)
    print(f"  Detected {len(sensor_cols)} sensor/actuator columns")
    print(f"  Label column: {label_col}")
    print(f"  Constant actuators to drop: {len(CONSTANT_ACTUATORS)}")
    print()

    # Read all data
    print("[2/3] Reading CSV files...")
    t0 = time.time()

    all_rows = []
    cols_to_use = None

    if "merged" in files:
        print(f"  Reading merged file...")
        rows, cols_to_use = read_csv_rows(
            files["merged"], sensor_cols, label_col, drop_constant=True
        )
        all_rows.extend(rows)
    else:
        if "normal" in files:
            print(f"  Reading normal file...")
            rows, cols_to_use = read_csv_rows(
                files["normal"], sensor_cols, label_col, drop_constant=True
            )
            all_rows.extend(rows)
            print(f"    {len(rows):,} valid rows")

        if "attack" in files:
            print(f"  Reading attack file...")
            rows, _ = read_csv_rows(
                files["attack"], sensor_cols, label_col, drop_constant=True
            )
            all_rows.extend(rows)
            print(f"    {len(rows):,} valid rows")

    elapsed = time.time() - t0
    print(f"  Total: {len(all_rows):,} valid rows ({elapsed:.1f}s)")
    print()

    if not all_rows:
        print("  ERROR: No valid rows found.")
        sys.exit(1)

    # Count labels
    normal_count = sum(1 for _, label in all_rows if label == CLASS_NORMAL)
    attack_count = sum(1 for _, label in all_rows if label == CLASS_ATTACK)
    print(f"  Label distribution:")
    print(f"    normal: {normal_count:,} ({normal_count/len(all_rows)*100:.1f}%)")
    print(f"    attack: {attack_count:,} ({attack_count/len(all_rows)*100:.2f}%)")
    print()

    # Write output
    print("[3/3] Writing output CSV...")
    t0 = time.time()

    output_path = os.path.join(DATA_DIR, "swat_raw_labeled.csv")
    out_header = ["timestamp"] + cols_to_use + ["label"]

    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(out_header)

        for seq_ts, (vals, label) in enumerate(all_rows):
            row = [seq_ts]
            for col in cols_to_use:
                row.append(f"{vals[col]}")
            row.append(label)
            writer.writerow(row)

    elapsed = time.time() - t0
    file_size_mb = os.path.getsize(output_path) / 1024 / 1024

    print(f"  {elapsed:.1f}s")
    print()
    print("=" * 70)
    print(" Summary")
    print("=" * 70)
    print(f"  Output:       {output_path}")
    print(f"  File size:    {file_size_mb:.1f} MB")
    print(f"  Total rows:   {len(all_rows):,}")
    print(f"  Columns:      {len(cols_to_use)} sensors/actuators (dropped {len(CONSTANT_ACTUATORS)} constant)")
    print(f"  Timestamp:    Sequential integers (0 to {len(all_rows)-1})")
    print()
    print(f"  Columns used:")
    for i, col in enumerate(cols_to_use):
        print(f"    {col}", end="")
        if (i + 1) % 8 == 0:
            print()
    print()
    print()
    print(f"  Normal:  {normal_count:>10,} ({normal_count/len(all_rows)*100:.1f}%)")
    print(f"  Attack:  {attack_count:>10,} ({attack_count/len(all_rows)*100:.2f}%)")
    print("=" * 70)


if __name__ == "__main__":
    main()
