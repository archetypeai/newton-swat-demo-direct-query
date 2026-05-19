#!/usr/bin/env node
// Probe Newton /query for Omega direct-query embeddings.
// Goals:
//   1) Confirm single-channel (1D array) shape works (matches reference).
//   2) See if multi-channel — 2D window in one event — is accepted.
//   3) See if multi-channel — multiple events in one call — is accepted.
//   4) Print embedding shape so we can size the KNN library.
//
// Usage: node scripts/probe-direct-query.js
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
const ENDPOINT = ENV.ATAI_API_ENDPOINT.replace(/\/$/, '') + '/v0.5/query';
const MODEL = 'OmegaEncoder::omega_embeddings_01';

const WINDOW_SIZE = 128;
const STAGE_P1_COLUMNS = ['FIT101', 'LIT101', 'MV101', 'P101'];

function readCsvWindow(filePath, columns, windowSize) {
	const text = readFileSync(filePath, 'utf-8');
	const lines = text.split('\n').filter((l) => l.trim());
	const headers = lines[0].split(',');
	const idx = columns.map((c) => headers.indexOf(c));
	if (idx.some((i) => i < 0)) throw new Error('missing column in csv');
	const window = lines.slice(1, 1 + windowSize).map((line) => {
		const cells = line.split(',');
		return idx.map((i) => {
			const v = parseFloat(cells[i]);
			return isNaN(v) ? 0 : v;
		});
	});
	if (window.length < windowSize) throw new Error('not enough rows');
	// channel-first: [[chan0 vals], [chan1 vals], ...]
	return columns.map((_, c) => window.map((row) => row[c]));
}

async function postQuery(body, label) {
	const t0 = Date.now();
	const res = await fetch(ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ENV.ATAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});
	const ms = Date.now() - t0;
	const text = await res.text();
	console.log(`\n[${label}] ${res.status} in ${ms}ms`);
	if (!res.ok) {
		console.log('  error:', text.slice(0, 800));
		return null;
	}
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		console.log('  non-JSON body:', text.slice(0, 400));
		return null;
	}
	// Try to find the embedding shape in common paths.
	const candidates = [data.response, data.response?.response, data.embeddings, data.data];
	for (const c of candidates) {
		if (Array.isArray(c)) {
			const sh = describeShape(c);
			console.log('  embedding-ish array path with shape:', sh);
		}
	}
	console.log('  top-level keys:', Object.keys(data).join(', '));
	const dump = JSON.stringify(data, null, 2);
	console.log('  body preview:', dump.length > 1200 ? dump.slice(0, 1200) + '\n  ...' : dump);
	return data;
}

function describeShape(arr) {
	const dims = [];
	let cur = arr;
	while (Array.isArray(cur)) {
		dims.push(cur.length);
		cur = cur[0];
	}
	return `[${dims.join(' x ')}]  leaf=${typeof cur}`;
}

async function main() {
	console.log('Probing', ENDPOINT);
	const channelFirst = readCsvWindow(
		resolve('data/swat_normal.csv'),
		STAGE_P1_COLUMNS,
		WINDOW_SIZE
	);
	console.log(`Loaded ${STAGE_P1_COLUMNS.length}ch x ${WINDOW_SIZE} samples from swat_normal.csv`);

	// 1) Reference: 1 channel, 1D array
	await postQuery(
		{
			query: '',
			model: MODEL,
			normalize_input: true,
			events: [
				{
					type: 'data.numeric_array',
					event_data: { contents: [channelFirst[0]] }
				}
			]
		},
		'A: single-channel 1D (reference)'
	);

	// 2) Multivariate as 2D window in one event
	await postQuery(
		{
			query: '',
			model: MODEL,
			normalize_input: true,
			events: [
				{
					type: 'data.numeric_array',
					event_data: { contents: channelFirst }
				}
			]
		},
		'B: multivariate 2D in one event'
	);

	// 3) Multivariate as N separate events in one call
	await postQuery(
		{
			query: '',
			model: MODEL,
			normalize_input: true,
			events: channelFirst.map((vals) => ({
				type: 'data.numeric_array',
				event_data: { contents: [vals] }
			}))
		},
		'C: multivariate N events in one call'
	);

	// 4) Try sensor_data shape (matches Lens streaming payload)
	await postQuery(
		{
			query: '',
			model: MODEL,
			normalize_input: true,
			events: [
				{
					type: 'data.json',
					event_data: {
						sensor_data: channelFirst,
						sensor_metadata: { sensor_timestamp: Date.now() / 1000, sensor_id: 'probe' }
					}
				}
			]
		},
		'D: data.json sensor_data shape'
	);
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
