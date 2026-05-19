#!/usr/bin/env node
// Build the n-shot KNN library used by the Direct Query classifier.
//
// For each of the 6 SWaT stages, this slides a window across swat_normal.csv
// and swat_attack.csv, sends each window (channel-first 2D) to Newton's /query
// Omega endpoint, and stores the returned embeddings labeled NORMAL / ATTACK.
//
// Output: data/knn-library.json
//   {
//     config: { windowSize, stepSize, model, builtAt },
//     stages: {
//       P1: {
//         columns: [...],
//         embeddings: [{ label: 'NORMAL'|'ATTACK', vec: number[] }, ...]
//       },
//       ...
//     }
//   }
//
// Each `vec` is a flattened [num_columns * 768] vector.
//
// Usage: node scripts/build-knn-library.js [--window=128] [--step=128]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

// Global per-channel scaler. Without this, /query is called with
// normalize_input=true which normalizes per-window and erases cross-window
// amplitude signal. With this scaler we normalize once with the same fixed
// stats everywhere and pass normalize_input=false to Omega.
const SCALER_PATH = resolve('data/scaler.json');
const SCALER = existsSync(SCALER_PATH) ? JSON.parse(readFileSync(SCALER_PATH, 'utf-8')) : null;
if (!SCALER) {
	console.error('Missing data/scaler.json — run `node scripts/build-scaler.js` first.');
	process.exit(1);
}
function applyScaler(channelFirstWindow, columns) {
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
const MODEL = 'OmegaEncoder::omega_embeddings_01';

function loadEnv() {
	const env = {};
	const raw = readFileSync('.env', 'utf-8');
	for (const line of raw.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
}

function parseArgs() {
	const args = { window: 128, step: 128 };
	for (const a of process.argv.slice(2)) {
		const m = a.match(/^--(\w+)=(\d+)$/);
		if (m) args[m[1]] = parseInt(m[2]);
	}
	return args;
}

function readCsv(filePath) {
	const text = readFileSync(filePath, 'utf-8');
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const headers = lines[0].split(',').map((h) => h.trim());
	const rows = lines.slice(1).map((line) => line.split(','));
	return { headers, rows };
}

// Return channel-first 2D array [num_cols x window_size] for the given window.
function extractWindow(rows, headerIdx, startRow, windowSize) {
	const out = headerIdx.map(() => new Array(windowSize));
	for (let r = 0; r < windowSize; r++) {
		const row = rows[startRow + r];
		for (let c = 0; c < headerIdx.length; c++) {
			const v = parseFloat(row[headerIdx[c]]);
			out[c][r] = isNaN(v) ? 0 : v;
		}
	}
	return out;
}

async function queryOmega(endpoint, apiKey, channelFirstWindow) {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query: '',
			model: MODEL,
			// We pre-normalize with the global StandardScaler before sending, so
			// Omega should NOT normalize per-window — that would erase the
			// cross-window amplitude signal we just preserved.
			normalize_input: false,
			events: [
				{
					type: 'data.numeric_array',
					event_data: { contents: channelFirstWindow }
				}
			]
		})
	});
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`/query failed: ${res.status} ${err.slice(0, 300)}`);
	}
	const data = await res.json();
	// Shape: { response: { response: [num_channels x 768] } }  per probe.
	const arr = data.response?.response;
	if (!Array.isArray(arr) || !Array.isArray(arr[0])) {
		throw new Error(`unexpected response shape: ${JSON.stringify(data).slice(0, 300)}`);
	}
	return arr; // [num_channels x 768]
}

function flatten2D(arr) {
	const rows = arr.length;
	const cols = arr[0].length;
	const out = new Array(rows * cols);
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			out[r * cols + c] = arr[r][c];
		}
	}
	return out;
}

async function buildForStage(stageId, csvSets, headerIdxByLabel, endpoint, apiKey, windowSize, stepSize) {
	const embeddings = [];
	const stageColumns = STAGE_COLUMNS[stageId];
	for (const { label, csv } of csvSets) {
		const headerIdx = headerIdxByLabel[label];
		const rows = csv.rows;
		const total = rows.length;
		for (let start = 0; start + windowSize <= total; start += stepSize) {
			const win = extractWindow(rows, headerIdx, start, windowSize);
			const scaled = applyScaler(win, stageColumns);
			let attempt = 0;
			while (true) {
				try {
					const emb2d = await queryOmega(endpoint, apiKey, scaled);
					embeddings.push({ label, vec: flatten2D(emb2d) });
					break;
				} catch (err) {
					attempt += 1;
					if (attempt >= 3) throw err;
					await new Promise((r) => setTimeout(r, 500 * attempt));
				}
			}
		}
		console.log(`  ${stageId} ${label}: ${embeddings.filter((e) => e.label === label).length} windows`);
	}
	return embeddings;
}

async function main() {
	const env = loadEnv();
	const args = parseArgs();
	const endpoint = env.ATAI_API_ENDPOINT.replace(/\/$/, '') + '/v0.5/query';
	console.log(`Endpoint: ${endpoint}`);
	console.log(`Window: ${args.window}, Step: ${args.step}`);

	const normal = readCsv(resolve('data/swat_normal.csv'));
	const attack = readCsv(resolve('data/swat_attack.csv'));
	console.log(`Loaded ${normal.rows.length} normal rows, ${attack.rows.length} attack rows`);

	const stages = {};
	const t0 = Date.now();
	for (const stageId of STAGE_IDS) {
		const cols = STAGE_COLUMNS[stageId];
		const normalIdx = cols.map((c) => normal.headers.indexOf(c));
		const attackIdx = cols.map((c) => attack.headers.indexOf(c));
		if (normalIdx.some((i) => i < 0) || attackIdx.some((i) => i < 0)) {
			throw new Error(`${stageId}: missing column in csv`);
		}
		console.log(`\n${stageId} (${cols.length} cols):`);
		const embeddings = await buildForStage(
			stageId,
			[
				{ label: 'NORMAL', csv: normal },
				{ label: 'ATTACK', csv: attack }
			],
			{ NORMAL: normalIdx, ATTACK: attackIdx },
			endpoint,
			env.ATAI_API_KEY,
			args.window,
			args.step
		);
		stages[stageId] = { columns: cols, embeddings };
	}

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	const lib = {
		config: {
			windowSize: args.window,
			stepSize: args.step,
			model: MODEL,
			builtAt: new Date().toISOString()
		},
		stages
	};

	const outPath = resolve('data/knn-library.json');
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(lib));
	const sizeMb = (readFileSync(outPath).length / 1024 / 1024).toFixed(2);
	console.log(`\nWrote ${outPath} (${sizeMb} MB) in ${elapsed}s`);
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
