import { json } from '@sveltejs/kit';
import { ATAI_API_ENDPOINT, ATAI_API_KEY } from '$env/static/private';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// One-time per-sensor baselines computed from swat_normal.csv. The client
// fetches these once on mount and uses them to build the Newton /query prompt
// without going through SvelteKit's server route handler.
let BASELINES = null;
function loadBaselines() {
	if (BASELINES) return BASELINES;
	try {
		const csv = readFileSync(resolve('data/swat_normal.csv'), 'utf-8');
		const lines = csv.split('\n').filter((l) => l.trim());
		const headers = lines[0].split(',');
		const sums = new Array(headers.length).fill(0);
		const sqSums = new Array(headers.length).fill(0);
		let count = 0;
		for (let i = 1; i < lines.length; i++) {
			const cells = lines[i].split(',');
			if (cells.length !== headers.length) continue;
			for (let j = 1; j < cells.length; j++) {
				const v = parseFloat(cells[j]);
				if (!isNaN(v)) {
					sums[j] += v;
					sqSums[j] += v * v;
				}
			}
			count += 1;
		}
		const stats = {};
		for (let j = 1; j < headers.length; j++) {
			const mean = sums[j] / count;
			const variance = Math.max(0, sqSums[j] / count - mean * mean);
			stats[headers[j]] = { mean, std: Math.sqrt(variance) };
		}
		BASELINES = stats;
	} catch (err) {
		console.error('Failed to load sensor baselines:', err);
		BASELINES = {};
	}
	return BASELINES;
}
loadBaselines();

// apiKey is exposed here so the browser can call Newton's /query directly for
// operator suggestions, mirroring the workaround used in the Lens-based version
// (server-side /query was getting wedged in dev). Same trust boundary as before
// — the key was already returned from /api/session/one in the original demo.
export async function GET() {
	return json({ baselines: BASELINES, endpoint: ATAI_API_ENDPOINT, apiKey: ATAI_API_KEY });
}
