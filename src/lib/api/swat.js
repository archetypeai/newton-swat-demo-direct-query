export async function fetchChunk(offset, limit = 5000) {
	const res = await fetch(`/api/chunk?offset=${offset}&limit=${limit}`);
	if (!res.ok) throw new Error('Failed to fetch chunk');
	return res.json();
}

export async function classifyWindow(rows) {
	const res = await fetch('/api/classify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ rows })
	});
	if (!res.ok) throw new Error('Classify failed');
	return res.json();
}

export async function fetchProjections() {
	const res = await fetch('/api/projections');
	if (!res.ok) throw new Error('Projections fetch failed');
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
