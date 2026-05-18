#!/usr/bin/env node
// Parallel 6-session Newton streaming probe. Mimics the app's streaming path
// but skips SvelteKit entirely — direct Node → Newton. Measures time-to-first
// inference.result per stage. If this matches the app's ~60s, Newton serialises;
// if it's much faster (~15s), SvelteKit is adding latency.
//
// Usage: node scripts/probe-streaming.js

import { readFileSync } from 'fs';
import { resolve } from 'path';

const LENS_PREFIX = 'swat-probe';
const API_VERSION = 'v0.5';

const STAGE_COLUMNS = {
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
const STAGE_IDS = Object.keys(STAGE_COLUMNS);

const WINDOW_SIZE = 128;
const STEP_SIZE = 128;

function loadEnv() {
	const env = {};
	const raw = readFileSync('.env', 'utf-8');
	for (const line of raw.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
}

const ENV = loadEnv();
const API_BASE = ENV.ATAI_API_ENDPOINT.replace(/\/$/, '');
const API_KEY = ENV.ATAI_API_KEY;

function apiUrl(path) {
	return `${API_BASE}/${API_VERSION}${path}`;
}

async function apiGet(path) {
	const res = await fetch(apiUrl(path), {
		headers: { Authorization: `Bearer ${API_KEY}` }
	});
	if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
	return res.json();
}

async function apiPost(path, body, timeoutMs = 30000) {
	const ctrl = new AbortController();
	const timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(apiUrl(path), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			signal: ctrl.signal
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
		headers: { Authorization: `Bearer ${API_KEY}` },
		body: formData
	});
	if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
	return res.json();
}

async function cleanStaleLenses() {
	const lenses = await apiGet('/lens/metadata').catch(() => []);
	const stale = Array.isArray(lenses)
		? lenses.filter((l) => l.lens_name && l.lens_name.startsWith(LENS_PREFIX))
		: [];
	for (const l of stale) {
		await apiPost('/lens/delete', { lens_id: l.lens_id }).catch(() => {});
	}
	return stale.length;
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

async function createSession(stageId, normalFileId, attackFileId, batchTag) {
	const columns = STAGE_COLUMNS[stageId];
	const lensConfig = {
		lens_name: `${LENS_PREFIX}-${stageId}-${batchTag}`,
		lens_config: {
			model_pipeline: [
				{ processor_name: 'lens_timeseries_state_processor', processor_config: {} }
			],
			model_parameters: {
				model_name: 'OmegaEncoder',
				model_version: 'OmegaEncoder::omega_embeddings_01',
				normalize_input: true,
				buffer_size: WINDOW_SIZE,
				input_n_shot: { NORMAL: normalFileId, ATTACK: attackFileId },
				csv_configs: {
					timestamp_column: 'timestamp',
					data_columns: columns,
					window_size: WINDOW_SIZE,
					step_size: STEP_SIZE
				},
				knn_configs: {
					n_neighbors: 3,
					metric: 'euclidean',
					weights: 'uniform',
					algorithm: 'ball_tree',
					normalize_embeddings: false
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

async function streamWindow(sessionId, stageId, rows, counter) {
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
							sensor_id: `probe_${stageId}_${counter}`
						}
					}
				}
			}
		},
		15000
	);
}

// Read CSV into row objects. Simple parser — data is well-formed.
function readCsvRows(filePath) {
	const text = readFileSync(filePath, 'utf-8');
	const lines = text.split('\n').filter((l) => l.trim());
	const headers = lines[0].split(',');
	return lines.slice(1).map((line) => {
		const cells = line.split(',');
		const row = {};
		for (let i = 0; i < headers.length; i++) row[headers[i]] = cells[i];
		return row;
	});
}

// Open an SSE consumer for a session. Returns an async iterable that yields
// parsed events. Uses fetch streaming (no custom EventSource needed).
async function* consumeSSE(sessionId, signal) {
	const url = apiUrl(`/lens/sessions/consumer/${sessionId}`);
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'text/event-stream' },
		signal
	});
	if (!res.ok) throw new Error(`SSE open failed: ${res.status}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let idx;
		while ((idx = buffer.indexOf('\n\n')) !== -1) {
			const chunk = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const dataLine = chunk
				.split('\n')
				.find((l) => l.startsWith('data:'));
			if (!dataLine) continue;
			const payload = dataLine.slice(5).trim();
			if (!payload) continue;
			try {
				yield JSON.parse(payload);
			} catch {
				// ignore malformed
			}
		}
	}
}

async function main() {
	console.log('SWaT streaming probe — 6 sessions, direct Node → Newton');
	console.log(`Endpoint: ${API_BASE}`);
	console.log('');

	// Cleanup any prior probe lenses
	const staleCount = await cleanStaleLenses();
	if (staleCount > 0) console.log(`Cleaned ${staleCount} stale ${LENS_PREFIX}-* lenses`);

	// Upload n-shot files
	console.log('Uploading n-shot files...');
	const tUpload = Date.now();
	const [normalUpload, attackUpload] = await Promise.all([
		uploadFile(resolve('data/swat_normal.csv')),
		uploadFile(resolve('data/swat_attack.csv'))
	]);
	console.log(`n-shot uploaded in ${Date.now() - tUpload}ms`);

	// Load 128 rows of real data for the test window. Use first 128 rows of
	// swat_normal (has all sensor columns).
	const allRows = readCsvRows(resolve('data/swat_normal.csv')).slice(0, WINDOW_SIZE);
	console.log(`Loaded ${allRows.length} rows for test window`);
	console.log('');

	// Mount 6 sessions in parallel
	const batchTag = Date.now();
	console.log('Mounting 6 sessions in parallel...');
	const tMount = Date.now();
	const sessions = await Promise.all(
		STAGE_IDS.map((stageId) =>
			createSession(stageId, normalUpload.file_id, attackUpload.file_id, batchTag)
		)
	);
	console.log(`All 6 sessions ready in ${Date.now() - tMount}ms`);
	console.log('');

	// Open SSE for each session and kick off listener
	const firstInference = {};
	const allResults = STAGE_IDS.map((stageId, i) => {
		const session = sessions[i];
		const ctrl = new AbortController();
		return {
			stageId,
			sessionId: session.sessionId,
			lensId: session.lensId,
			ctrl,
			done: new Promise((resolve) => {
				(async () => {
					try {
						for await (const event of consumeSSE(session.sessionId, ctrl.signal)) {
							if (event?.type === 'inference.result') {
								firstInference[stageId] = Date.now();
								resolve(event);
								return;
							}
						}
					} catch (err) {
						if (err.name !== 'AbortError') {
							console.error(`[${stageId}] SSE error:`, err.message);
						}
					}
				})();
			})
		};
	});

	// Small delay so SSE handshakes land before we push data
	await new Promise((r) => setTimeout(r, 1500));

	// Start timing now — we'll measure from "first window sent" to "first inference result"
	const tStreamStart = Date.now();
	console.log('Streaming first window to all 6 sessions (t=0)...');
	await Promise.all(
		sessions.map((session) => streamWindow(session.sessionId, session.stageId, allRows, 0))
	);
	console.log(`All 6 POSTs completed in ${Date.now() - tStreamStart}ms`);
	console.log('');
	console.log('Waiting for first inference.result per stage...');

	// Race per-stage with a global cap
	const TIMEOUT_MS = 180_000;
	const results = await Promise.race([
		Promise.all(allResults.map((r) => r.done.then(() => r.stageId))),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`Overall timeout at ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
		)
	]).catch((err) => err);

	// Print per-stage timings
	console.log('');
	console.log('Per-stage first inference.result timing (from t=0 stream start):');
	for (const stageId of STAGE_IDS) {
		if (firstInference[stageId]) {
			const ms = firstInference[stageId] - tStreamStart;
			console.log(`  ${stageId}: ${ms}ms`);
		} else {
			console.log(`  ${stageId}: never arrived`);
		}
	}
	const arrivals = STAGE_IDS.filter((s) => firstInference[s]).map((s) => firstInference[s]);
	if (arrivals.length > 0) {
		const firstMs = Math.min(...arrivals) - tStreamStart;
		const lastMs = Math.max(...arrivals) - tStreamStart;
		console.log('');
		console.log(`First result across any stage: ${firstMs}ms`);
		console.log(`Last result across all stages: ${lastMs}ms`);
	}

	// Cleanup
	console.log('');
	console.log('Cleaning up...');
	for (const r of allResults) r.ctrl.abort();
	await Promise.all(
		sessions.map((s) =>
			apiPost('/lens/sessions/destroy', { session_id: s.sessionId }).catch(() => {})
		)
	);
	await cleanStaleLenses();
	console.log('Done.');
	process.exit(0);
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
