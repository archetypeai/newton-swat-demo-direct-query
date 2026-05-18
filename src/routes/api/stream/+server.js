import { json } from '@sveltejs/kit';
import { streamWindowToStage, MONITORED_STAGE_IDS } from '$lib/server/newton.js';

export async function POST({ request }) {
	try {
		const { sessions, rows, counter } = await request.json();
		if (!sessions || !rows || !rows.length) {
			return json({ error: 'Missing sessions or rows' }, { status: 400 });
		}

		const results = await Promise.allSettled(
			MONITORED_STAGE_IDS.map((stageId) => {
				const sessionId = sessions[stageId];
				if (!sessionId) return Promise.resolve({ stageId, skipped: true });
				return streamWindowToStage(sessionId, stageId, rows, counter);
			})
		);

		const failed = results
			.map((r, i) => ({ stageId: MONITORED_STAGE_IDS[i], result: r }))
			.filter((x) => x.result.status === 'rejected');

		return json({ ok: true, count: results.length, failed });
	} catch (err) {
		return json({ error: err.message }, { status: 500 });
	}
}
