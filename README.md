# newton-swat-demo-direct-query

Feasibility demo: a water treatment plant paved with sensors, using **Newton's Direct Query API** for Omega embeddings + local KNN to detect per-stage anomalies in real time, and Newton text reasoning (also via Direct Query) to surface suggested upstream/downstream actions to an operator.

Branched from [`newton-swat-demo`](https://github.com/archetypeai/newton-swat-demo), which used the Machine State Lens (SSE streaming, six parallel sessions). This branch removes the lens entirely:

- **Classification** uses Direct Query to Omega for embeddings, then K-nearest-neighbours against a precomputed n-shot embedding library — no lens registration, no SSE, no session lifecycle, no startup race conditions.
- **Operator suggestions** still use Direct Query to Newton's reasoning model (unchanged).
- **Embedding visualization panel** added: collapsed by default, surfaces the Omega 2D layout per stage (PCA-2 + UMAP-2) with a live cursor that follows the playback window.

## Concept

Same six-stage water treatment plant:

1. **P1** — Raw water intake and storage
2. **P2** — Chemical dosing (pre-treatment)
3. **P3** — Ultrafiltration (UF)
4. **P4** — UV dechlorination
5. **P5** — Reverse osmosis (RO)
6. **P6** — Backwash / cleaning

Six per-stage classifiers, each trained on its own sensor subset (n-shot normal vs attack). When a stage flags anomalous, the UI surfaces suggested actions on adjacent stages — framed as suggestions for a human operator.

## Stack

Svelte 5 + SvelteKit · Tailwind v4 · `@archetypeai/ds-lib-tokens` · bits-ui · layerchart · `umap-js` (server-side projection fit) · `plotly.js-dist-min` (client-side scatters).

## Setup

```bash
cp .env.example .env
# edit .env with your ATAI_API_KEY and ATAI_API_ENDPOINT

npm install

# One-time: build the n-shot embedding library used by KNN
node scripts/build-knn-library.js
# ~3 min, hits /query 180 times (6 stages × 2 classes × 15 windows).
# Output: data/knn-library.json (~17 MB)

npm run dev
```

Open the dev URL, press **Start analysis** (instant — no session warmup), then **Play** to replay the SWaT timeline at 10× real time and watch classifications stream in.

## How the demo interacts with Newton

Three flows: **build** (offline, one-time), **classify** (per playback window), **reason** (when anomalies change).

### At a glance

**Build phase (offline, one-time, `scripts/build-knn-library.js`):**

1. Read `swat_normal.csv` (2,000 rows) and `swat_attack.csv` (2,000 rows).
2. Slide windows (128 rows, step=20 in the rebuild) across each file.
3. For each window: send to `/query` with `model: OmegaEncoder` → get back a `[num_channels × 768]` embedding → flatten to a 1D vector → tag it `NORMAL` or `ATTACK` based on which file it came from.
4. Save all of these as `data/knn-library.json`.

**Runtime (per playback window, `/api/classify`):**

1. Take the 128 rows under the playhead.
2. Send to `/query` with the same `OmegaEncoder` model → get the embedding for the live window.
3. Compute Euclidean distance from this embedding to every embedding in the library.
4. Pick the 3 closest. Majority vote of their labels → predicted class.

KNN doesn't "train" in the way a neural net does — the library *is* the model. The build phase just embeds the n-shot examples once and stores them with their labels; every runtime prediction is a distance lookup against that stored set.

### Phase 1 — Build the n-shot KNN library (offline)

```
scripts/build-knn-library.js
   │
   ├── read data/swat_normal.csv (2,000 rows of normal operation)
   ├── read data/swat_attack.csv (2,000 rows from attack periods)
   ├── for each stage (P1..P6):
   │     for each window (128 rows, step=128):
   │         POST /v0.5/query  { model: OmegaEncoder, events: [data.numeric_array channel-first] }
   │         ← [num_channels × 768] embedding
   │         flatten → [num_channels * 768] vector, label NORMAL or ATTACK
   │
   └── write data/knn-library.json
       { stages: { P1: { columns, embeddings: [{ label, vec }, ...] }, ... } }
```

Per-stage library: 15 NORMAL + 15 ATTACK embeddings. Replaces the lens-internal KNN bank.

### Phase 2 — Classify (every 128 rows during playback)

```
Browser tick loop                  SvelteKit /api/classify        Newton /query
   │                                       │                            │
   │  every STEP_SIZE rows (128):          │                            │
   │  POST /api/classify { rows: [...] }   │                            │
   │  ────────────────────────────────────▶│                            │
   │                                       │  Promise.allSettled:       │
   │                                       ├── stage P1 → embed window ▶│
   │                                       ├── stage P2 → embed window ▶│
   │                                       ├── ... P3 P4 P5 P6 ────────▶│
   │                                       │◀── embeddings ─────────────│
   │                                       │                            │
   │                                       │  for each stage:           │
   │                                       │    local euclidean KNN     │
   │                                       │    (k=3) against library   │
   │                                       │    → label NORMAL|ATTACK   │
   │                                       │    project via PCA-2       │
   │                                       │    project via umap-js     │
   │                                       │                            │
   │◀── { stages: { P1: { label,           │                            │
   │     neighbors, coords:{pca,umap} },   │                            │
   │     ... } } ──────────────────────────│                            │
   │                                       │                            │
   │  update stage cards · update trail in │                            │
   │  embedding panel                       │                            │
```

No session lifecycle. Each tick is a single round-trip to `/api/classify` that fans out to six parallel `/query` calls inside the server. End-to-end latency ~1.5–2 s for all six stages.

### Phase 3 — Reason (Suggested Actions via Newton `/query`)

Whenever the set of anomalous stages changes, the browser calls Newton's `/query` endpoint directly with a structured plant-state snapshot and gets back JSON cards routed to the correct upstream/local/downstream neighbour. The system prompt, request shape, and parser live in `src/lib/suggestions-direct.js`; the same fallback server route at `src/routes/api/suggestions/+server.js` exists too. Unchanged from the original demo.

### Inside the Omega Direct Query call

The Direct Query body shape (per stage, per window):

```json
{
  "query": "",
  "model": "OmegaEncoder::omega_embeddings_01",
  "normalize_input": true,
  "events": [
    {
      "type": "data.numeric_array",
      "event_data": {
        "contents": [
          [/* channel 0: window_size values */],
          [/* channel 1: window_size values */],
          ...
        ]
      }
    }
  ]
}
```

Response (per probe):

```json
{
  "response": {
    "response": [
      [/* 768-dim embedding for channel 0 */],
      [/* 768-dim embedding for channel 1 */],
      ...
    ]
  }
}
```

The server flattens `[num_channels × 768]` into a single 1D vector per window before running KNN. The same vector is used for PCA-2 and `umap.transform()` to produce the embedding-panel coords.

## Embedding panel

Collapsed by default — click "Omega embeddings · 6-stage 2D projection" at the bottom to expand. Six small scatters, one per stage. Mode toggle: **PCA** vs **UMAP**.

- Static background: 30 library embeddings per stage (15 NORMAL green, 15 ATTACK red).
- Live cursor: each `/api/classify` response carries `coords.pca` and `coords.umap` for the current window — appended to a fading trail (last 8 points), with the head marker coloured by current classification.
- **PCA-2** is computed by power iteration over the centered covariance of the library embeddings (linear, ~ms in JS, accurate transform on any new point).
- **UMAP-2** is fit with `umap-js` on the library embeddings (30 points per stage — on the low end for UMAP; treat as a qualitative layout, not a precise map). `umap.transform(new_embedding)` projects live windows into the same 2D space.
- Both projections are fit once at server boot and cached in memory; no offline script needed.

Why not t-SNE: t-SNE has no `transform()` for new points by construction — adding the live cursor would force a refit on every tick, producing a totally different layout each time.

## What's different vs the Lens version

| Concern | Lens version (`newton-swat-demo`) | Direct Query version (this branch) |
|---|---|---|
| Setup phase | Upload n-shot files + 6 lens registrations + 6 session creates → 30–60 s warmup | None. Start analysis is instant; KNN library is built offline once. |
| Classification | Push window into session → Newton SSE event → parse `inference.result` | Synchronous `POST /api/classify` → server fans out 6 `/query` calls + local KNN |
| Failure modes | Sessions can stall mid-stream (`P4-stuck` scenario); SSE proxy/auth fragility; stale lenses from crashed tabs | Stateless. Each tick is independent. No cleanup needed. |
| Embeddings | Hidden inside the lens | Returned by `/query` — exposed for visualization |
| Code surface | `cleanStaleLenses`, `ensureNShotUploaded`, `waitForSession`, `streamWindowToStage`, SSE proxy route, session cleanup on `pagehide`, localStorage stale-ID cleanup | None of that. Server is ~200 lines for embed + KNN + projection. |
| Per-window latency | ~1–2 s once warmed (SSE end-to-end) | ~1.5–2 s (6 parallel `/query` calls + KNN + projection) |
| Cost per window | 6× Lens inference | 6× Direct Query `/query` |

The two versions are basically equivalent at steady state; Direct Query trades the lens's batching + buffered streaming for stateless simplicity and exposed embeddings.

## Data

### Attribution

The SWaT (Secure Water Treatment) dataset was created by [iTrust, Centre for Research in Cyber Security](https://itrust.sutd.edu.sg/) at the Singapore University of Technology and Design (SUTD). For published work, request the dataset through [iTrust's official channels](https://itrust.sutd.edu.sg/itrust-labs_datasets/).

11 consecutive days of 1-second readings from a scaled-down but fully operational six-stage water treatment plant — 7 days of normal operation followed by 4 days with 36 cyber-physical attack scenarios.

### Download (Kaggle mirror)

The fastest way to get started is the [Kaggle mirror of SWaT](https://www.kaggle.com/datasets/vishala28/swat-dataset-secure-water-treatment-system). Download the normal and attack CSVs and drop them in `data/`.

### Prep

The repo tracks the pre-processed outputs in `data/`:

- `swat_raw_labeled.csv` — full labeled timeline used for streaming replay
- `swat_normal.csv` / `swat_attack.csv` — n-shot training examples (normal vs attack)
- `swat_quick_test_200.csv` — 200-row smoke test
- `swat_inference.csv` — inference subset
- `knn-library.json` — generated by `node scripts/build-knn-library.js`, not committed by default

If you want to regenerate the CSVs from a fresh Kaggle download, see `scripts/convert_swat_data.py` and `scripts/generate_labels.py` — ported verbatim from [`archetypeai/archetypeai-batch-examples-swat`](https://github.com/archetypeai/archetypeai-batch-examples-swat).

## Scope caveats

- Anomaly labels in SWaT are plant-wide, not per-stage. Each per-stage classifier is a best-effort inference based on *that stage's own sensors* — we're explicitly *not* looking at labels to decide which stage saw the attack.
- The Suggested Actions panel is strictly Reason-layer: it surfaces operator guidance, never takes control actions. For any real deployment, actuation would require a separate safety-reviewed control path.
- UMAP with 30 library points is a low-data regime; the layout is suggestive of structure but not precise. If you want sharper UMAP, increase the library by pre-embedding a chunk of inference data and including it in the fit set.
