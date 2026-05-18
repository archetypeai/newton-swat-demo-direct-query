import { ATAI_API_KEY } from '$env/static/private';

export async function GET({ url }) {
	const sseUrl = url.searchParams.get('url');
	if (!sseUrl) {
		return new Response('Missing url parameter', { status: 400 });
	}

	const upstream = await fetch(sseUrl, {
		headers: { Authorization: `Bearer ${ATAI_API_KEY}` }
	});

	if (!upstream.ok) {
		return new Response(`Upstream SSE failed: ${upstream.status}`, { status: upstream.status });
	}

	return new Response(upstream.body, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
}
