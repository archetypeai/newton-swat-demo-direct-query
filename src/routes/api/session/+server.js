import { json } from '@sveltejs/kit';
import {
	createAllStageSessionsWithProgress,
	destroyAllSessions,
	getSSEUrl,
	getApiKey
} from '$lib/server/newton.js';

export async function GET({ url }) {
	const encoder = new TextEncoder();

	const config = {};
	if (url.searchParams.has('windowSize'))
		config.windowSize = parseInt(url.searchParams.get('windowSize'));
	if (url.searchParams.has('stepSize'))
		config.stepSize = parseInt(url.searchParams.get('stepSize'));
	if (url.searchParams.has('nNeighbors'))
		config.nNeighbors = parseInt(url.searchParams.get('nNeighbors'));

	const stream = new ReadableStream({
		async start(controller) {
			function sendStep(step) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'step', step })}\n\n`));
			}
			try {
				const sessions = await createAllStageSessionsWithProgress(sendStep, config);
				const payload = sessions.map((s) => ({
					stageId: s.stageId,
					sessionId: s.sessionId,
					lensId: s.lensId,
					sseUrl: getSSEUrl(s.sessionId)
				}));
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							type: 'done',
							sessions: payload,
							apiKey: getApiKey(),
							config
						})}\n\n`
					)
				);
			} catch (err) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`)
				);
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
}

export async function DELETE({ request }) {
	try {
		const { sessionIds } = await request.json();
		await destroyAllSessions(sessionIds || []);
		return json({ ok: true });
	} catch (err) {
		return json({ error: err.message }, { status: 500 });
	}
}
