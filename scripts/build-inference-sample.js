#!/usr/bin/env node
// Build a sampled-inference embedding pool for the embedding-viz panel.
//
// Reads a slice of swat_raw_labeled.csv around the demo's playback offset,
// embeds windows for each stage via Direct Query, and writes
// data/inference-sample.json. The server projects these through the same
// PCA-2 / UMAP-2 fitted on the n-shot library, so the viz panel can show
// a dense "where real playback windows land" cloud in addition to the
// 30-point library.
//
// Usage: node scripts/build-inference-sample.js [--offset=701000] [--rows=6000] [--window=128] [--step=128]

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Global per-channel scaler shared with build-knn-library.js and the live
// /api/classify path. Required — pre-normalizing with consistent stats
// everywhere is what lets us pass normalize_input=false to Omega.
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
const MODEL = 'OmegaEncoder::omega_embeddings_1_4';

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
	const args = { offset: 701000, rows: 6000, window: 128, step: 128 };
	for (const a of process.argv.slice(2)) {
		const m = a.match(/^--(\w+)=(\d+)$/);
		if (m) args[m[1]] = parseInt(m[2]);
	}
	return args;
}

// Stream-parse only the rows we need; the labeled file is 1.4M rows / ~400 MB.
function readCsvSlice(filePath, offset, count) {
	const text = readFileSync(filePath, 'utf-8');
	const lines = text.split(/\r?\n/);
	const headers = lines[0].split(',').map((h) => h.trim());
	const slice = lines.slice(1 + offset, 1 + offset + count).filter((l) => l.length);
	const rows = slice.map((line) => line.split(','));
	return { headers, rows };
}

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

// Majority ground-truth label across the window's rows.
function majorityLabel(rows, labelIdx, startRow, windowSize) {
	let attack = 0;
	let normal = 0;
	for (let r = 0; r < windowSize; r++) {
		const lbl = (rows[startRow + r][labelIdx] || '').trim().toLowerCase();
		if (lbl === 'attack') attack++;
		else if (lbl === 'normal') normal++;
	}
	return attack > normal ? 'ATTACK' : 'NORMAL';
}

async function queryOmega(endpoint, apiKey, channelFirstWindow) {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query: '',
			model: MODEL,
			// Windows are pre-normalized with the global scaler before this call,
			// so don't let Omega re-normalize per-window.
			normalize_input: false,
			events: [{ type: 'data.numeric_array', event_data: { contents: channelFirstWindow } }]
		})
	});
	if (!res.ok) throw new Error(`/query ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const data = await res.json();
	const arr = data.response?.response;
	if (!Array.isArray(arr) || !Array.isArray(arr[0])) {
		throw new Error('bad shape');
	}
	return arr;
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

async function main() {
	const env = loadEnv();
	const args = parseArgs();
	const endpoint = env.ATAI_API_ENDPOINT.replace(/\/$/, '') + '/v0.5/query';
	console.log(`Endpoint: ${endpoint}`);
	console.log(`Offset ${args.offset}, slice ${args.rows} rows, window=${args.window}, step=${args.step}`);

	const { headers, rows } = readCsvSlice(
		resolve('data/swat_raw_labeled.csv'),
		args.offset,
		args.rows
	);
	const labelIdx = headers.indexOf('label');
	if (labelIdx < 0) throw new Error('label column missing');
	console.log(`Loaded ${rows.length} rows`);

	const stages = {};
	const t0 = Date.now();
	for (const stageId of STAGE_IDS) {
		const cols = STAGE_COLUMNS[stageId];
		const idx = cols.map((c) => headers.indexOf(c));
		if (idx.some((i) => i < 0)) throw new Error(`${stageId}: missing column`);

		const embeddings = [];
		const numWindows = Math.floor((rows.length - args.window) / args.step) + 1;
		console.log(`\n${stageId} (${cols.length} cols): ${numWindows} windows`);
		for (let i = 0; i < numWindows; i++) {
			const start = i * args.step;
			const win = extractWindow(rows, idx, start, args.window);
			const scaled = applyScaler(win, cols);
			const truth = majorityLabel(rows, labelIdx, start, args.window);
			let attempt = 0;
			while (true) {
				try {
					const emb2d = await queryOmega(endpoint, env.ATAI_API_KEY, scaled);
					embeddings.push({
						vec: flatten2D(emb2d),
						label: truth,
						rowOffset: args.offset + start
					});
					break;
				} catch (err) {
					attempt += 1;
					if (attempt >= 3) throw err;
					await new Promise((r) => setTimeout(r, 500 * attempt));
				}
			}
			if ((i + 1) % 10 === 0 || i === numWindows - 1) {
				process.stdout.write(`  ${i + 1}/${numWindows}\r`);
			}
		}
		const aN = embeddings.filter((e) => e.label === 'NORMAL').length;
		const aA = embeddings.filter((e) => e.label === 'ATTACK').length;
		console.log(`  done: ${aN} NORMAL + ${aA} ATTACK`);
		stages[stageId] = { columns: cols, embeddings };
	}

	const out = {
		config: {
			offset: args.offset,
			rows: args.rows,
			windowSize: args.window,
			stepSize: args.step,
			model: MODEL,
			builtAt: new Date().toISOString()
		},
		stages
	};
	const outPath = resolve('data/inference-sample.json');
	writeFileSync(outPath, JSON.stringify(out));
	const sizeMb = (readFileSync(outPath).length / 1024 / 1024).toFixed(2);
	console.log(`\nWrote ${outPath} (${sizeMb} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
