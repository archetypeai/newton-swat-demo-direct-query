import { json } from '@sveltejs/kit';
import {
	createOneStageSessionWithProgress,
	getSSEUrl,
	getApiKey
} from '$lib/server/newton.js';

export async function POST({ request }) {
	try {
		const { stageId, config = {} } = await request.json();
		if (!stageId) return json({ error: 'Missing stageId' }, { status: 400 });
		const session = await createOneStageSessionWithProgress(() => {}, stageId, config);
		return json({
			stageId: session.stageId,
			sessionId: session.sessionId,
			lensId: session.lensId,
			sseUrl: getSSEUrl(session.sessionId),
			apiKey: getApiKey()
		});
	} catch (err) {
		return json({ error: err.message }, { status: 500 });
	}
}
