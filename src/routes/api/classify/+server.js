import { json } from '@sveltejs/kit';
import { classifyAllStages, DEFAULT_CONFIG } from '$lib/server/newton.js';

// Synchronous per-window classification. Replaces the SSE-streaming
// /api/stream route from the Lens version. Body shape:
//   { rows: [{ FIT101: '2.51', ... }, ...] }   length should equal windowSize
// Response shape:
//   {
//     stages: {
//       P1: { label: 'ATTACK'|'NORMAL', neighbors: [...], embedding: number[] },
//       ...
//     },
//     errors: [{ stageId, error }]
//   }
export async function POST({ request }) {
	try {
		const { rows, k } = await request.json();
		if (!Array.isArray(rows) || rows.length === 0) {
			return json({ error: 'Missing or empty rows' }, { status: 400 });
		}
		const result = await classifyAllStages(rows, { k: k || DEFAULT_CONFIG.nNeighbors });
		return json(result);
	} catch (err) {
		return json({ error: err.message }, { status: 500 });
	}
}
