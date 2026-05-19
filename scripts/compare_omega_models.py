#!/usr/bin/env python3
"""Compare per-call latency between OmegaEncoder::omega_embeddings_01 and
OmegaEncoder::omega_embeddings_1_4 against the live /query endpoint.

Useful when you observe one variant materially slower than the other and
want to see where the time is going — queue, model load, or inference.

The response body for /query exposes per-stage timestamps and elapsed
seconds.  This script extracts them and averages across N runs per model:

    query_queue_time_sec           # how long it sat in GPQ before processing
    loading_timestamp - query_timestamp  # cold-load / dispatch overhead
    inference_time_sec             # forward pass on the model
    query_response_time_sec        # end-to-end wall clock

Usage:
    export ATAI_API_KEY=...
    export ATAI_API_ENDPOINT=https://api.u1.archetypeai.app/
    python compare_omega_models.py --iterations 5 --channels 4 --window 128

Optional:
    --csv path.csv     read the first `window` rows × first `channels` numeric
                       columns of a CSV instead of using random data
    --models a,b       override the two model ids (default: 01 and 1_4)

Dependencies: requests
"""
import argparse
import os
import statistics
import sys
import time
from typing import Any

import requests

DEFAULT_MODELS = [
    "OmegaEncoder::omega_embeddings_01",
    "OmegaEncoder::omega_embeddings_1_4",
]


def load_window_from_csv(path: str, channels: int, window: int) -> list[list[float]]:
    """Return a channel-first window [channels x window] from a CSV.

    Uses the first `channels` numeric columns and the first `window` data rows.
    """
    rows: list[list[float]] = []
    with open(path) as f:
        header = f.readline().strip().split(",")
        # Pick numeric columns by trying to parse the second line.
        first = f.readline().strip().split(",")
        numeric_idx: list[int] = []
        for i, cell in enumerate(first):
            try:
                float(cell)
                numeric_idx.append(i)
            except ValueError:
                continue
            if len(numeric_idx) >= channels:
                break
        if len(numeric_idx) < channels:
            raise SystemExit(
                f"CSV needs at least {channels} numeric columns; found {len(numeric_idx)}"
            )
        # Use the first row we already consumed.
        rows.append([float(first[i]) for i in numeric_idx])
        for line in f:
            if len(rows) >= window:
                break
            cells = line.strip().split(",")
            if len(cells) <= numeric_idx[-1]:
                continue
            try:
                rows.append([float(cells[i]) for i in numeric_idx])
            except ValueError:
                continue
    if len(rows) < window:
        raise SystemExit(f"CSV needs at least {window} usable rows; got {len(rows)}")
    # Transpose row-major to channel-first.
    return [[rows[r][c] for r in range(window)] for c in range(channels)]


def make_random_window(channels: int, window: int, seed: int = 42) -> list[list[float]]:
    """Deterministic pseudo-random sensor-like window."""
    import random

    rng = random.Random(seed)
    out: list[list[float]] = []
    for c in range(channels):
        base = rng.uniform(0, 100)
        amp = rng.uniform(0.1, 2.0)
        out.append([base + amp * rng.uniform(-1, 1) for _ in range(window)])
    return out


def post_query(
    endpoint: str, api_key: str, model: str, contents: list[list[float]]
) -> tuple[int, dict[str, Any], float]:
    url = endpoint.rstrip("/") + "/v0.5/query"
    body = {
        "query": "",
        "model": model,
        "normalize_input": False,
        "events": [
            {"type": "data.numeric_array", "event_data": {"contents": contents}}
        ],
    }
    t0 = time.monotonic()
    resp = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=60,
    )
    wall = time.monotonic() - t0
    try:
        return resp.status_code, resp.json(), wall
    except ValueError:
        return resp.status_code, {"raw_body": resp.text[:500]}, wall


def extract_stats(body: dict[str, Any]) -> dict[str, float]:
    """Pull the four timing fields that matter from a /query response.

    The response carries four monotonically-increasing timestamps that bracket
    the three server-side phases:

        query_timestamp        → loading_timestamp   = queue wait
        loading_timestamp      → inference_timestamp = model dispatch/load
        inference_timestamp    → response_timestamp  = forward pass

    `query_response_time_sec` is end-to-end (queue + load + inference) as
    measured by the API; `wall_sec` is what the caller actually waits for
    (everything above + network).
    """
    nested = body.get("response", {}) if isinstance(body.get("response"), dict) else {}
    q_ts = body.get("query_timestamp") or nested.get("query_timestamp") or 0.0
    load_ts = body.get("loading_timestamp") or 0.0
    infer_ts = body.get("inference_timestamp") or 0.0

    queue_sec = float(body.get("query_queue_time_sec") or 0.0)
    if not queue_sec and load_ts and q_ts:
        queue_sec = float(load_ts - q_ts)

    load_sec = float(infer_ts - load_ts) if (load_ts and infer_ts) else 0.0

    return {
        "queue_sec": queue_sec,
        "load_sec": load_sec,
        "infer_sec": float(
            body.get("inference_time_sec") or nested.get("generation_latency") or 0.0
        ),
        "end_to_end_sec": float(
            body.get("query_response_time_sec")
            or nested.get("query_gpq_latency")
            or 0.0
        ),
    }


def fmt_row(name: str, samples: list[float]) -> str:
    if not samples:
        return f"  {name:<14}  (no samples)"
    mean = statistics.fmean(samples)
    p_min = min(samples)
    p_max = max(samples)
    return (
        f"  {name:<14}  mean={mean:>6.3f}s   "
        f"min={p_min:>6.3f}s   max={p_max:>6.3f}s   n={len(samples)}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--channels", type=int, default=4)
    parser.add_argument("--window", type=int, default=128)
    parser.add_argument("--csv", type=str, default=None)
    parser.add_argument(
        "--models",
        type=str,
        default=",".join(DEFAULT_MODELS),
        help="Comma-separated list of model ids to compare",
    )
    args = parser.parse_args()

    api_key = os.environ.get("ATAI_API_KEY")
    endpoint = os.environ.get("ATAI_API_ENDPOINT")
    if not api_key or not endpoint:
        print("ATAI_API_KEY and ATAI_API_ENDPOINT must be set", file=sys.stderr)
        return 2

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    if not models:
        print("--models cannot be empty", file=sys.stderr)
        return 2

    contents = (
        load_window_from_csv(args.csv, args.channels, args.window)
        if args.csv
        else make_random_window(args.channels, args.window)
    )
    print(
        f"Sending {args.channels}-channel × {args.window}-sample windows to {endpoint}"
    )
    print(f"Iterations per model: {args.iterations}")
    print(f"Models: {models}")
    print()

    results: dict[str, dict[str, list[float]]] = {
        m: {"queue_sec": [], "load_sec": [], "infer_sec": [], "end_to_end_sec": [], "wall_sec": []}
        for m in models
    }

    for it in range(args.iterations):
        for model in models:
            status, body, wall = post_query(endpoint, api_key, model, contents)
            if status != 200:
                err = body.get("errors") or body.get("detail") or body
                print(f"[{model}] iter {it + 1}: HTTP {status} — {err}")
                continue
            stats = extract_stats(body)
            stats["wall_sec"] = wall
            for k, v in stats.items():
                results[model][k].append(v)
            print(
                f"[{model}] iter {it + 1}: "
                f"queue={stats['queue_sec']:.3f}s "
                f"load={stats['load_sec']:.3f}s "
                f"infer={stats['infer_sec']:.3f}s "
                f"end_to_end={stats['end_to_end_sec']:.3f}s "
                f"wall={wall:.3f}s"
            )

    print()
    for model in models:
        print(f"=== {model} ===")
        print(fmt_row("queue_sec", results[model]["queue_sec"]))
        print(fmt_row("load_sec", results[model]["load_sec"]))
        print(fmt_row("infer_sec", results[model]["infer_sec"]))
        print(fmt_row("end_to_end", results[model]["end_to_end_sec"]))
        print(fmt_row("wall_sec", results[model]["wall_sec"]))
        print()

    if len(models) == 2:
        a, b = models
        if results[a]["wall_sec"] and results[b]["wall_sec"]:
            avg_a = statistics.fmean(results[a]["wall_sec"])
            avg_b = statistics.fmean(results[b]["wall_sec"])
            slower = "B" if avg_b > avg_a else "A"
            ratio = max(avg_a, avg_b) / max(min(avg_a, avg_b), 1e-9)
            print(f"Wall-clock ratio: {slower} = {ratio:.2f}× the other")
            # Where is the time going?
            for field in ("queue_sec", "load_sec", "infer_sec"):
                if results[a][field] and results[b][field]:
                    ma = statistics.fmean(results[a][field])
                    mb = statistics.fmean(results[b][field])
                    diff = mb - ma
                    sign = "+" if diff >= 0 else ""
                    print(
                        f"  {field:<14}  {a.split('::')[-1]}={ma:.3f}s   "
                        f"{b.split('::')[-1]}={mb:.3f}s   delta={sign}{diff:.3f}s"
                    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
