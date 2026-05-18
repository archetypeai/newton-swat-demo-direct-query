import { ATAI_API_KEY, ATAI_API_ENDPOINT } from '$env/static/private';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const API_VERSION = 'v0.5';
const LENS_NAME_PREFIX = 'swat-stage-lens';

// SWaT stage → sensor column mapping.
// Column naming is {TYPE}{STAGE}{ID} — the first digit of the numeric suffix is the stage number.
// 11 constant-value actuators (P102, P201, P202, P204, P206, P401, P403, P404, P502, P601, P603)
// are dropped by the prep script; what's left is the ~40 non-constant columns grouped below.
export const STAGE_COLUMNS = {
	P1: ['FIT101', 'LIT101', 'MV101', 'P101'],
	P2: ['AIT201', 'AIT202', 'AIT203', 'FIT201', 'MV201', 'P203', 'P205'],
	P3: ['DPIT301', 'FIT301', 'LIT301', 'MV301', 'MV302', 'MV303', 'MV304', 'P301', 'P302'],
	P4: ['AIT401', 'AIT402', 'FIT401', 'LIT401', 'P402', 'UV401'],
	P5: [
		'AIT501',
		'AIT502',
		'AIT503',
		'AIT504',
		'FIT501',
		'FIT502',
		'FIT503',
		'FIT504',
		'P501',
		'PIT501',
		'PIT502',
		'PIT503'
	],
	P6: ['FIT601', 'P602']
};
export const STAGE_IDS = Object.keys(STAGE_COLUMNS);
// All six stages get Newton sessions. The client orchestrates fully-serial setup
// (create → pre-warm → wait for inference.result) so Newton only has one session
// actively inferencing at a time during setup.
// All 6 stages monitored. Parallel mount confirmed working at 2 stages.
export const MONITORED_STAGE_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

function apiUrl(path) {
	return `${ATAI_API_ENDPOINT.replace(/\/$/, '')}/${API_VERSION}${path}`;
}

async function apiGet(path) {
	const res = await fetch(apiUrl(path), {
		headers: { Authorization: `Bearer ${ATAI_API_KEY}` }
	});
	if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
	return res.json();
}

async function apiPost(path, body, timeoutMs = 10000) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(apiUrl(path), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${ATAI_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(`POST ${path} failed: ${res.status} - ${JSON.stringify(err)}`);
		}
		return res.json();
	} finally {
		clearTimeout(timeoutId);
	}
}

async function uploadFile(filePath) {
	const formData = new FormData();
	const fileBuffer = readFileSync(filePath);
	const blob = new Blob([fileBuffer], { type: 'text/csv' });
	formData.append('file', blob, filePath.split('/').pop());
	const res = await fetch(apiUrl('/files'), {
		method: 'POST',
		headers: { Authorization: `Bearer ${ATAI_API_KEY}` },
		body: formData
	});
	if (!res.ok) throw new Error(`File upload failed: ${res.status}`);
	return res.json();
}

async function cleanStaleLenses() {
	const lenses = await apiGet('/lens/metadata').catch(() => []);
	const stale = Array.isArray(lenses)
		? lenses.filter((l) => l.lens_name && l.lens_name.startsWith(LENS_NAME_PREFIX))
		: [];
	for (const l of stale) {
		await apiPost('/lens/delete', { lens_id: l.lens_id }).catch(() => {});
	}
}

async function waitForSession(sessionId, maxWaitMs = 60000) {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		const status = await apiPost(
			'/lens/sessions/events/process',
			{ session_id: sessionId, event: { type: 'session.status' } },
			10000
		);
		const s = status.session_status;
		if (s === 'LensSessionStatus.SESSION_STATUS_RUNNING' || s === '3') return true;
		if (s === 'LensSessionStatus.SESSION_STATUS_FAILED' || s === '6') return false;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return false;
}

// Matches drilling-demo's known-working config — smaller windows appeared to
// cause OmegaEncoder to silently skip emitting inference.result events, only
// ACKing data via session.modify.result.
export const DEFAULT_CONFIG = {
	windowSize: 128,
	stepSize: 128,
	nNeighbors: 3,
	metric: 'euclidean',
	weights: 'uniform',
	algorithm: 'ball_tree',
	normalizeEmbeddings: false
};

// n-shot uploads are reused across all 6 per-stage lenses (each lens selects its own data_columns).
let cachedNormalFileId = null;
let cachedAttackFileId = null;

async function ensureNShotUploaded(onStep) {
	if (cachedNormalFileId && cachedAttackFileId) {
		onStep('Reusing cached n-shot uploads...');
		return;
	}
	// Full 2,000-row n-shot files. 256-row files were giving KNN libraries of only
	// 4 embeddings per stage — too thin for k=3 KNN to find meaningful matches, so
	// Newton returned "unknown" instead of ATTACK/NORMAL. Full files give ~15
	// embeddings per class × 2 classes = 30-embedding library per stage.
	onStep('Uploading normal n-shot examples (2,000 rows)...');
	const normalUpload = await uploadFile(resolve('data/swat_normal.csv'));
	cachedNormalFileId = normalUpload.file_id;
	onStep('Uploading attack n-shot examples (2,000 rows)...');
	const attackUpload = await uploadFile(resolve('data/swat_attack.csv'));
	cachedAttackFileId = attackUpload.file_id;
}

async function createStageSession(stageId, cfg, batchTag) {
	const columns = STAGE_COLUMNS[stageId];
	const lensConfig = {
		lens_name: `${LENS_NAME_PREFIX}-${stageId}-${batchTag}`,
		lens_config: {
			model_pipeline: [
				{ processor_name: 'lens_timeseries_state_processor', processor_config: {} }
			],
			model_parameters: {
				model_name: 'OmegaEncoder',
				model_version: 'OmegaEncoder::omega_embeddings_01',
				normalize_input: true,
				buffer_size: cfg.windowSize,
				input_n_shot: {
					NORMAL: cachedNormalFileId,
					ATTACK: cachedAttackFileId
				},
				csv_configs: {
					timestamp_column: 'timestamp',
					data_columns: columns,
					window_size: cfg.windowSize,
					step_size: cfg.stepSize
				},
				knn_configs: {
					n_neighbors: cfg.nNeighbors,
					metric: cfg.metric,
					weights: cfg.weights,
					algorithm: cfg.algorithm,
					normalize_embeddings: cfg.normalizeEmbeddings
				}
			},
			output_streams: [{ stream_type: 'server_sent_events_writer' }]
		}
	};
	const lens = await apiPost('/lens/register', { lens_config: lensConfig }, 30000);
	const session = await apiPost('/lens/sessions/create', { lens_id: lens.lens_id });
	const ready = await waitForSession(session.session_id);
	if (!ready) throw new Error(`Session for ${stageId} failed to start`);
	return { stageId, sessionId: session.session_id, lensId: lens.lens_id };
}

// Tracks whether we've done the one-time setup cleanup for the current Start cycle.
// cleanStaleLenses deletes ALL lenses matching our prefix — calling it per-stage
// was destroying previously-created lenses as new ones came online.
let setupCleanupDone = false;

// Used by /api/session/one — client orchestrates per-stage setup to ensure
// Newton only has one session actively inferencing at a time during warmup.
export async function createOneStageSessionWithProgress(onStep, stageId, config = {}) {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	if (!setupCleanupDone) {
		onStep('Cleaning stale lenses (one-time)...');
		await cleanStaleLenses();
		setupCleanupDone = true;
	}
	await ensureNShotUploaded(onStep);
	const batchTag = Date.now();
	return createStageSession(stageId, cfg, batchTag);
}

export async function createAllStageSessionsWithProgress(onStep, config = {}) {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	onStep('Cleaning stale lenses...');
	await cleanStaleLenses();

	await ensureNShotUploaded(onStep);

	// Serial session creation. Previously created all 6 sessions in parallel via
	// Promise.all, which hit a Newton-side concurrency cliff — the first two
	// sessions would emit inference.result fine but the other four would stall
	// and eventually close via sse.stream.end. Creating them one at a time lets
	// each session fully register and start its inference pipeline before the
	// next one starts competing for resources.
	const batchTag = Date.now();
	const sessions = [];
	for (let i = 0; i < MONITORED_STAGE_IDS.length; i++) {
		const stageId = MONITORED_STAGE_IDS[i];
		onStep(`Starting session ${i + 1}/${MONITORED_STAGE_IDS.length}: ${stageId}...`);
		const session = await createStageSession(stageId, cfg, batchTag);
		sessions.push(session);
	}
	onStep('All stage sessions ready.');
	return sessions;
}

export async function streamWindowToStage(sessionId, stageId, rows, counter) {
	const columns = STAGE_COLUMNS[stageId];
	const sensorData = columns.map((col) =>
		rows.map((row) => {
			const v = parseFloat(row[col]);
			return isNaN(v) ? 0 : v;
		})
	);
	return apiPost(
		'/lens/sessions/events/process',
		{
			session_id: sessionId,
			event: {
				type: 'session.update',
				event_data: {
					type: 'data.json',
					event_data: {
						sensor_data: sensorData,
						sensor_metadata: {
							sensor_timestamp: Date.now() / 1000,
							sensor_id: `swat_${stageId}_${counter}`
						}
					}
				}
			}
		},
		15000
	);
}

export function getSSEUrl(sessionId) {
	return apiUrl(`/lens/sessions/consumer/${sessionId}`);
}

export function getApiKey() {
	return ATAI_API_KEY;
}

export async function destroyAllSessions(sessionIds) {
	await Promise.all(
		sessionIds.map((id) =>
			apiPost('/lens/sessions/destroy', { session_id: id }).catch(() => {})
		)
	);
	// Next Start cycle should re-clean any stale lenses from prior runs
	setupCleanupDone = false;
}

// Direct text query to Newton's reasoning model — used to generate action
// suggestions from a structured plant-state snapshot. 120s timeout: observed
// /query latencies of 90+s with the 6-stage baseline-aware prompt, so give it
// headroom without exceeding the 150s client-side safety timeout.
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
		// Unwrap per skill docs: data.response.response[0] is the canonical shape
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
