#!/usr/bin/env node
// Compute a per-channel StandardScaler (mean + std) over the n-shot training
// pool. Used to pre-normalize every window before sending to /query, with
// `normalize_input: false` so Omega sees consistent amplitudes across windows.
//
// Without this, /query is called with `normalize_input: true` which normalizes
// per-window. That loses cross-window amplitude signal — e.g. LIT401=574 and
// LIT401=950 look identical after per-window normalization. The recommended
// pattern (see archetypeai-agent-skills newton-machine-state) is to fit a
// global scaler once on the focus pool and apply it everywhere.
//
// Usage: node scripts/build-scaler.js [--source=both|normal|attack]
// Output: data/scaler.json
//   { columns: [...], mean: { col: m, ... }, std: { col: s, ... } }

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function readCsv(filePath) {
	const text = readFileSync(filePath, 'utf-8');
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const headers = lines[0].split(',').map((h) => h.trim());
	const rows = lines.slice(1).map((line) => line.split(','));
	return { headers, rows };
}

function parseArgs() {
	const out = { source: 'both' };
	for (const a of process.argv.slice(2)) {
		const m = a.match(/^--(\w+)=(\S+)$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

function main() {
	const args = parseArgs();
	const normal = readCsv(resolve('data/swat_normal.csv'));
	const attack = readCsv(resolve('data/swat_attack.csv'));

	// Header alignment check: both files should have the same columns in the
	// same order. Drop the timestamp column from the scaler — we only normalize
	// sensor channels.
	if (normal.headers.join(',') !== attack.headers.join(',')) {
		throw new Error('Header mismatch between swat_normal.csv and swat_attack.csv');
	}
	const columns = normal.headers.filter((h) => h !== 'timestamp');
	console.log(`Channels in scaler: ${columns.length}`);

	const sources = [];
	if (args.source === 'normal' || args.source === 'both') sources.push(normal);
	if (args.source === 'attack' || args.source === 'both') sources.push(attack);
	console.log(`Source: ${args.source} (${sources.length} file${sources.length > 1 ? 's' : ''})`);

	// Single pass per channel: track sum, sumsq, count.
	const stats = {};
	for (const col of columns) stats[col] = { sum: 0, sumsq: 0, n: 0 };

	for (const file of sources) {
		const colIdx = columns.map((c) => file.headers.indexOf(c));
		for (const row of file.rows) {
			for (let i = 0; i < columns.length; i++) {
				const v = parseFloat(row[colIdx[i]]);
				if (Number.isNaN(v)) continue;
				const s = stats[columns[i]];
				s.sum += v;
				s.sumsq += v * v;
				s.n += 1;
			}
		}
	}

	const mean = {};
	const std = {};
	for (const col of columns) {
		const { sum, sumsq, n } = stats[col];
		const m = sum / n;
		const variance = Math.max(0, sumsq / n - m * m);
		const s = Math.sqrt(variance);
		mean[col] = m;
		// Avoid divide-by-zero for constant channels. Use 1 so the scaled
		// value is (x - mean), which still preserves the structure.
		std[col] = s > 1e-9 ? s : 1;
	}

	const out = {
		columns,
		mean,
		std,
		config: {
			source: args.source,
			samplesUsed: stats[columns[0]].n,
			builtAt: new Date().toISOString()
		}
	};

	const outPath = resolve('data/scaler.json');
	writeFileSync(outPath, JSON.stringify(out, null, 2));
	console.log(`\nWrote ${outPath} from ${out.config.samplesUsed} samples per channel`);

	// Print a sample of channels so the user can sanity-check magnitudes.
	const sample = ['FIT101', 'LIT101', 'MV101', 'LIT401', 'PIT501'];
	for (const col of sample) {
		if (mean[col] !== undefined) {
			console.log(`  ${col}: mean=${mean[col].toFixed(3)}, std=${std[col].toFixed(3)}`);
		}
	}
}

main();
