export async function fetchChunk(offset, limit = 5000) {
	const res = await fetch(`/api/chunk?offset=${offset}&limit=${limit}`);
	if (!res.ok) throw new Error('Failed to fetch chunk');
	return res.json();
}

export async function startSessions(onStep, config = {}) {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(config)) {
		if (v !== undefined) params.set(k, String(v));
	}
	const url = `/api/session${params.toString() ? '?' + params.toString() : ''}`;

	return new Promise((resolve, reject) => {
		const es = new EventSource(url);
		es.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.type === 'step') {
					onStep?.(data.step);
				} else if (data.type === 'done') {
					es.close();
					resolve(data);
				} else if (data.type === 'error') {
					es.close();
					reject(new Error(data.error));
				}
			} catch {
				// ignore parse errors
			}
		};
		es.onerror = () => {
			es.close();
			reject(new Error('Session setup connection failed'));
		};
	});
}

export async function startOneSession(stageId, config = {}) {
	const res = await fetch('/api/session/one', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ stageId, config })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(`Session setup failed for ${stageId}: ${err.error || res.status}`);
	}
	return res.json();
}

export async function endSessions(sessionIds, { keepalive = false } = {}) {
	// keepalive lets the request survive page unload — set when cleaning up on
	// beforeunload/pagehide so Newton sessions aren't left orphaned.
	await fetch('/api/session', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sessionIds }),
		keepalive
	});
}

export async function streamWindow(sessionMap, rows, counter) {
	const res = await fetch('/api/stream', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sessions: sessionMap, rows, counter })
	});
	if (!res.ok) throw new Error('Stream failed');
	return res.json();
}

export async function fetchSuggestions(stageStatuses, stageSensors = {}) {
	const res = await fetch('/api/suggestions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ stageStatuses, stageSensors })
	});
	if (!res.ok) throw new Error('Suggestions failed');
	return res.json();
}
