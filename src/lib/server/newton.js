import { ATAI_API_KEY, ATAI_API_ENDPOINT } from '$env/static/private';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { projectEmbedding } from './projections.js';

const API_VERSION = 'v0.5';
const OMEGA_MODEL = 'OmegaEncoder::omega_embeddings_01';

// SWaT stage → sensor column mapping. Identical to the original Lens-based demo
// so the same n-shot files and KNN library work without conversion.
export const STAGE_COLUMNS = {
	P1: ['FIT101', 'LIT101', 'MV101', 'P101'],
	P2: ['AIT201', 'AIT202', 'AIT203', 'FIT201', 'MV201', 'P203', 'P205'],
	P3: ['DPIT301', 'FIT301', 'LIT301', 'MV301', 'MV302', 'MV303', 'MV304', 'P301', 'P302'],
	P4: ['AIT401', 'AIT402', 'FIT401', 'LIT401', 'P402', 'UV401'],
	P5: [
		'AIT501', 'AIT502', 'AIT503', 'AIT504',
		'FIT501', 'FIT502', 'FIT503', 'FIT504',
		'P501', 'PIT501', 'PIT502', 'PIT503'
	],
	P6: ['FIT601', 'P602']
};
export const STAGE_IDS = Object.keys(STAGE_COLUMNS);
export const MONITORED_STAGE_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

export const DEFAULT_CONFIG = {
	windowSize: 128,
	stepSize: 128,
	nNeighbors: 3
};

function apiUrl(path) {
	return `${ATAI_API_ENDPOINT.replace(/\/$/, '')}/${API_VERSION}${path}`;
}

// ──────────────────────────────────────────────────────────────────────
// Global per-channel StandardScaler (data/scaler.json). Loaded lazily.
// Pre-normalizing every window with these fixed stats — and passing
// normalize_input=false to Omega — preserves cross-window amplitude signal
// that per-window normalization would erase. See scripts/build-scaler.js.
// ──────────────────────────────────────────────────────────────────────

let SCALER = null;
let SCALER_ERROR = null;
function ensureScaler() {
	if (SCALER || SCALER_ERROR) return;
	const path = resolve('data/scaler.json');
	if (!existsSync(path)) {
		SCALER_ERROR = new Error(
			'Missing data/scaler.json — run `node scripts/build-scaler.js` first.'
		);
		return;
	}
	SCALER = JSON.parse(readFileSync(path, 'utf-8'));
}

function applyScaler(channelFirstWindow, columns) {
	ensureScaler();
	if (SCALER_ERROR) throw SCALER_ERROR;
	const out = new Array(columns.length);
	for (let c = 0; c < columns.length; c++) {
		const col = columns[c];
		const m = SCALER.mean[col] ?? 0;
		const s = SCALER.std[col] ?? 1;
		const src = channelFirstWindow[c];
		const dst = new Array(src.length);
		for (let i = 0; i < src.length; i++) dst[i] = (src[i] - m) / s;
		out[c] = dst;
	}
	return out;
}

// ──────────────────────────────────────────────────────────────────────
// KNN library (loaded once at boot from data/knn-library.json)
// ──────────────────────────────────────────────────────────────────────

let LIBRARY = null;
let LIBRARY_ERROR = null;
function ensureLibrary() {
	if (LIBRARY || LIBRARY_ERROR) return;
	const path = resolve('data/knn-library.json');
	if (!existsSync(path)) {
		LIBRARY_ERROR = new Error(
			'Missing data/knn-library.json — run `node scripts/build-knn-library.js` first.'
		);
		return;
	}
	const raw = JSON.parse(readFileSync(path, 'utf-8'));
	for (const stageId of Object.keys(raw.stages)) {
		raw.stages[stageId].embeddings = raw.stages[stageId].embeddings.map((e) => ({
			label: e.label,
			vec: Float32Array.from(e.vec)
		}));
	}
	LIBRARY = raw;
}

export function getLibraryConfig() {
	ensureLibrary();
	if (LIBRARY_ERROR) throw LIBRARY_ERROR;
	return LIBRARY.config;
}

// ──────────────────────────────────────────────────────────────────────
// Direct Query: Omega embedding
// ──────────────────────────────────────────────────────────────────────

const OMEGA_TIMEOUT_MS = 15000;

async function postQuery(body, timeoutMs = OMEGA_TIMEOUT_MS) {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(apiUrl('/query'), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${ATAI_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		if (!res.ok) {
			const err = await res.text();
			throw new Error(`/query failed: ${res.status} ${err.slice(0, 300)}`);
		}
		return res.json();
	} finally {
		clearTimeout(t);
	}
}

// Send a [num_columns x window_size] channel-first array to Omega and return
// the [num_columns x 768] embedding matrix, flattened to a single Float32Array
// for KNN distance comparisons against the library.
export async function embedWindow(channelFirstWindow) {
	const data = await postQuery({
		query: '',
		model: OMEGA_MODEL,
		// Pre-normalized at the call site via applyScaler(); Omega should NOT
		// re-normalize per-window or it would erase cross-window amplitude.
		normalize_input: false,
		events: [
			{
				type: 'data.numeric_array',
				event_data: { contents: channelFirstWindow }
			}
		]
	});
	const arr = data.response?.response;
	if (!Array.isArray(arr) || !Array.isArray(arr[0])) {
		throw new Error(`unexpected Omega response shape: ${JSON.stringify(data).slice(0, 200)}`);
	}
	const numChannels = arr.length;
	const dim = arr[0].length;
	const out = new Float32Array(numChannels * dim);
	for (let c = 0; c < numChannels; c++) {
		for (let d = 0; d < dim; d++) {
			out[c * dim + d] = arr[c][d];
		}
	}
	return out;
}

// ──────────────────────────────────────────────────────────────────────
// Local KNN classifier
// ──────────────────────────────────────────────────────────────────────

function euclideanSq(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) {
		const d = a[i] - b[i];
		s += d * d;
	}
	return s;
}

function classifyEmbedding(stageId, embedding, k = DEFAULT_CONFIG.nNeighbors) {
	ensureLibrary();
	if (LIBRARY_ERROR) throw LIBRARY_ERROR;
	const lib = LIBRARY.stages[stageId];
	if (!lib) throw new Error(`no library for stage ${stageId}`);
	const dists = new Array(lib.embeddings.length);
	for (let i = 0; i < lib.embeddings.length; i++) {
		dists[i] = { d: euclideanSq(lib.embeddings[i].vec, embedding), label: lib.embeddings[i].label };
	}
	dists.sort((a, b) => a.d - b.d);
	const top = dists.slice(0, k);
	const votes = {};
	for (const t of top) votes[t.label] = (votes[t.label] || 0) + 1;
	let winner = null;
	let max = -1;
	for (const [label, n] of Object.entries(votes)) {
		if (n > max) {
			max = n;
			winner = label;
		}
	}
	return { label: winner, neighbors: top.map((t) => ({ label: t.label, dist: Math.sqrt(t.d) })) };
}

function extractStageWindow(stageId, rows) {
	const cols = STAGE_COLUMNS[stageId];
	return cols.map((col) =>
		rows.map((row) => {
			const v = parseFloat(row[col]);
			return isNaN(v) ? 0 : v;
		})
	);
}

// Run Direct Query → KNN for one stage. Returns the label, neighbors,
// and the raw embedding (so the client can run PCA-2 projection for the
// embedding-viz panel without re-querying Omega).
export async function classifyStage(stageId, rows, { k = DEFAULT_CONFIG.nNeighbors } = {}) {
	const win = extractStageWindow(stageId, rows);
	const scaled = applyScaler(win, STAGE_COLUMNS[stageId]);
	const embedding = await embedWindow(scaled);
	const { label, neighbors } = classifyEmbedding(stageId, embedding, k);
	// Project to 2D for the embedding-viz panel. Cheap (~10-50ms total for
	// PCA + UMAP transform). If projection ever fails, the classification
	// itself still returns — viz coords are best-effort.
	let coords = null;
	try {
		coords = await projectEmbedding(stageId, embedding);
	} catch {
		coords = null;
	}
	return { stageId, label, neighbors, coords };
}

export async function classifyAllStages(rows, opts = {}) {
	const results = await Promise.allSettled(
		MONITORED_STAGE_IDS.map((stageId) => classifyStage(stageId, rows, opts))
	);
	const out = {};
	const errors = [];
	for (let i = 0; i < results.length; i++) {
		const stageId = MONITORED_STAGE_IDS[i];
		const r = results[i];
		if (r.status === 'fulfilled') {
			out[stageId] = r.value;
		} else {
			errors.push({ stageId, error: r.reason?.message || String(r.reason) });
		}
	}
	return { stages: out, errors };
}

// ──────────────────────────────────────────────────────────────────────
// Text reasoning Direct Query (used for operator suggestions, unchanged)
// ──────────────────────────────────────────────────────────────────────

export function getApiKey() {
	return ATAI_API_KEY;
}

export async function queryNewton({ query, systemPrompt = '', maxNewTokens = 1024 }) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 120000);
	try {
		const res = await fetch(apiUrl('/query'), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${ATAI_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				query,
				system_prompt: systemPrompt,
				instruction_prompt: systemPrompt,
				file_ids: [],
				model: 'Newton::c2_4_7b_251215a172f6d7',
				max_new_tokens: maxNewTokens,
				sanitize: false
			}),
			signal: controller.signal
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(`query failed: ${res.status} - ${JSON.stringify(err)}`);
		}
		const data = await res.json();
		if (data.response?.response && Array.isArray(data.response.response)) {
			return data.response.response[0] || '';
		}
		if (Array.isArray(data.response)) return data.response[0] || '';
		if (typeof data.response === 'string') return data.response;
		if (data.text) return data.text;
		return '';
	} finally {
		clearTimeout(timeoutId);
	}
}
