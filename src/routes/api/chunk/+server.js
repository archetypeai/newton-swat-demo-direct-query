import { json } from '@sveltejs/kit';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CSV_PATH = resolve('data/swat_raw_labeled.csv');

// One-time scan: keep the raw buffer + an index of line-start byte offsets.
// Per-chunk requests slice the buffer without re-reading disk or re-parsing.
let buffer = null;
let header = null;
let lineStarts = null; // offsets of data rows (header excluded)

function ensureLoaded() {
	if (buffer) return;
	buffer = readFileSync(CSV_PATH);
	const offsets = [0];
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] === 0x0a) offsets.push(i + 1);
	}
	const headerEnd = offsets[1] - 1;
	header = buffer.slice(0, headerEnd).toString().split(',');
	const trailingEmpty = offsets[offsets.length - 1] >= buffer.length;
	const lastIdx = trailingEmpty ? offsets.length - 1 : offsets.length;
	lineStarts = offsets.slice(1, lastIdx);
}

function parseRow(i) {
	const start = lineStarts[i];
	const end = i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : buffer.length;
	const parts = buffer.slice(start, end).toString().split(',');
	const row = {};
	for (let j = 0; j < header.length; j++) row[header[j]] = parts[j];
	return row;
}

export async function GET({ url }) {
	try {
		ensureLoaded();
		const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0'));
		const limit = Math.min(parseInt(url.searchParams.get('limit') || '5000'), 20000);
		const end = Math.min(offset + limit, lineStarts.length);
		const rows = [];
		for (let i = offset; i < end; i++) rows.push(parseRow(i));
		return json({ rows, total: lineStarts.length, offset, header });
	} catch (err) {
		return json({ error: err.message }, { status: 500 });
	}
}
