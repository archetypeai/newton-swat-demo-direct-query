// Direct-to-Newton suggestions path. Bypasses SvelteKit's server route entirely
// because our dev server handler was getting wedged on /query calls (probe
// script proved Newton itself responds in 3-6s). The browser calls Newton's
// /query endpoint directly using the API key returned from /api/session/one.

const TOPOLOGY = {
	P1: { upstream: null, local: 'P1', downstream: 'P2' },
	P2: { upstream: 'P1', local: 'P2', downstream: 'P3' },
	P3: { upstream: 'P2', local: 'P3', downstream: 'P4' },
	P4: { upstream: 'P3', local: 'P4', downstream: 'P5' },
	P5: { upstream: 'P4', local: 'P5', downstream: 'P6' },
	P6: { upstream: 'P5', local: 'P6', downstream: null }
};

const STAGE_NAMES = {
	P1: 'raw intake',
	P2: 'chemical dosing',
	P3: 'ultrafiltration',
	P4: 'UV dechlorination',
	P5: 'reverse osmosis',
	P6: 'backwash'
};

const SYSTEM_PROMPT = `You are an operator assistant for the SWaT six-stage water treatment plant. Flow: P1 raw intake → P2 chemical dosing → P3 ultrafiltration → P4 UV dechlorination → P5 reverse osmosis → treated water. P6 backwash recycles P5 reject to clean P3 UF membranes.

For each stage marked ATTACK, suggest specific operator actions in three directions:
- upstream: reduce or hold feed from the stage immediately before the anomalous one
- local: check / isolate equipment on the anomalous stage itself
- downstream: alert or protect the stage immediately after the anomalous one from cascading effects

TOPOLOGY — the "target" field MUST EXACTLY match these pairings. Never substitute or reassign:
- P1 anomaly: upstream=none, local=P1, downstream=P2
- P2 anomaly: upstream=P1, local=P2, downstream=P3
- P3 anomaly: upstream=P2, local=P3, downstream=P4
- P4 anomaly: upstream=P3, local=P4, downstream=P5
- P5 anomaly: upstream=P4, local=P5, downstream=P6
- P6 anomaly: upstream=P5, local=P6, downstream=none

If a direction maps to "none" for a given origin, DO NOT emit that direction.

Return ONLY a JSON array. No prose, no markdown code fences, no explanation — just the JSON. Shape:
[{"origin":"Pn","target":"Pm","direction":"upstream|local|downstream","text":"..."}]

Rules:
- Only generate suggestions for stages marked ATTACK. Skip NORMAL, STANDBY, CLASSIFYING.
- For EVERY ATTACK stage emit all three direction cards (or two cards if topology says "none" for one direction). Do not skip a stage.
- Each "text" field is a full instruction with TWO parts joined by " — ":
    part 1: the EXACT sensor citation from that stage's "cite this sensor:" line (copy sensor name and value verbatim; drop the z annotation)
    part 2: an imperative operator action with a concrete verb (reduce, check, isolate, alert, hold, bypass)
- Example shape (do not copy sensor name — use the one from "cite this sensor:" for each stage):
    {"origin":"PX","target":"PX","direction":"local","text":"<sensor>=<value> — check valve and surrounding piping"}
    {"origin":"PX","target":"PY","direction":"upstream","text":"<sensor>=<value> — reduce feed from PY to stabilise intake"}
    {"origin":"PX","target":"PZ","direction":"downstream","text":"<sensor>=<value> — alert PZ of contamination risk"}
- CRITICAL: use the sensor name+value specified after "cite this sensor:" for that stage. Do NOT substitute a different sensor even if another looks more familiar.
- For upstream/downstream cards, the action text must name the TARGET stage by its Pn code.
- Keep each "text" field under 140 characters.`;

function formatBaseline(baselines, col) {
	const b = baselines?.[col];
	if (!b) return '';
	const { mean, std } = b;
	const precision = Math.abs(mean) >= 100 ? 0 : Math.abs(mean) >= 10 ? 1 : 2;
	return `normal ${mean.toFixed(precision)}±${std.toFixed(precision + 1)}`;
}

// Pick the single most-deviating sensor per stage. Newton was ignoring our
// z-ranking when given 3 choices and reverting to familiar sensor names, so we
// do the selection server-side and hand it one sensor to cite.
function pickTopDeviation(stageSensors, baselines) {
	let best = null;
	for (const [col, raw] of Object.entries(stageSensors)) {
		const v = parseFloat(raw);
		const b = baselines?.[col];
		if (!b || isNaN(v)) continue;
		const std = b.std || 0.0001;
		const z = Math.abs((v - b.mean) / std);
		if (!best || z > best.z) best = { col, val: v, z };
	}
	return best;
}

function buildQuery(stageStatuses, stageSensors, baselines) {
	const lines = Object.entries(STAGE_NAMES).map(([id, name]) => {
		const status = (stageStatuses[id] ?? 'idle').toUpperCase();
		let line = `- ${id} ${name}: ${status}`;
		if (stageStatuses[id] === 'attack' && stageSensors[id]) {
			const top = pickTopDeviation(stageSensors[id], baselines);
			if (top) {
				const zNote =
					top.z >= 3 ? ' (strong deviation)' : top.z >= 1 ? ' (moderate)' : ' (weak signal)';
				line += `\n    cite this sensor: ${top.col}=${top.val.toFixed(2)} z=${top.z.toFixed(1)}${zNote}`;
			}
		}
		return line;
	});
	return `Current plant state. Each attack stage specifies the exact sensor to cite — do not substitute:\n${lines.join('\n')}\n\nGenerate suggestions for ATTACK stages only. Emit three direction cards per attack stage (or two if topology says "none" for one direction).`;
}

// Repair a known c2_5_8b output quirk: an extra `{"` is sometimes inserted
// between objects in the array (`,{"{"origin"...` instead of `,{"origin"...`),
// breaking JSON.parse on otherwise-valid output. Apply before parse.
function repairKnownNewtonCorruptions(jsonText) {
	return jsonText.replace(/(,\s*)\{"\{"/g, '$1{"').replace(/^\[\s*\{"\{"/g, '[{"');
}

function parseSuggestions(text) {
	if (!text) return null;
	const cleaned = text
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
	const start = cleaned.indexOf('[');
	const end = cleaned.lastIndexOf(']');
	if (start === -1 || end === -1 || end <= start) return null;
	const sliced = cleaned.slice(start, end + 1);
	const candidates = [sliced, repairKnownNewtonCorruptions(sliced)];
	let parsed = null;
	for (const candidate of candidates) {
		try {
			parsed = JSON.parse(candidate);
			break;
		} catch {
			// try next candidate
		}
	}
	if (parsed === null) return null;
	try {
		if (!Array.isArray(parsed)) return null;
		return parsed
			.filter((s) => {
				if (
					!s ||
					typeof s.origin !== 'string' ||
					typeof s.target !== 'string' ||
					typeof s.direction !== 'string' ||
					typeof s.text !== 'string' ||
					!['upstream', 'local', 'downstream'].includes(s.direction)
				) {
					return false;
				}
				const topo = TOPOLOGY[s.origin];
				if (!topo) return false;
				const expectedTarget = topo[s.direction];
				if (expectedTarget === null) return false;
				return s.target === expectedTarget;
			})
			.map((s) => ({
				origin: s.origin,
				target: s.target,
				direction: s.direction,
				text: s.text
			}));
	} catch {
		return null;
	}
}

export async function fetchSuggestionsDirect({
	apiKey,
	endpoint,
	baselines,
	stageStatuses,
	stageSensors
}) {
	if (!apiKey || !endpoint) throw new Error('Missing Newton credentials');
	const anomalous = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
		.filter((id) => stageStatuses[id] === 'attack')
		.sort();
	const signature = anomalous.join(',') || 'none';
	if (anomalous.length === 0) {
		return { suggestions: [], source: 'newton', signature };
	}

	const url = endpoint.replace(/\/$/, '') + '/v0.5/query';
	const body = {
		query: buildQuery(stageStatuses, stageSensors, baselines),
		system_prompt: SYSTEM_PROMPT,
		instruction_prompt: SYSTEM_PROMPT,
		file_ids: [],
		model: 'Newton::c2_5_8b_260413b723a9ab',
		max_new_tokens: 700,
		sanitize: false
	};

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});
	if (!res.ok) {
		const err = await res.text().catch(() => '');
		throw new Error(`Newton /query ${res.status}: ${err.slice(0, 200)}`);
	}
	const data = await res.json();

	// Unwrap response — Newton returns { response: { response: [string] } }
	let raw = '';
	if (data.response?.response && Array.isArray(data.response.response)) {
		raw = data.response.response[0] || '';
	} else if (Array.isArray(data.response)) {
		raw = data.response[0] || '';
	} else if (typeof data.response === 'string') {
		raw = data.response;
	} else if (data.text) {
		raw = data.text;
	}

	const parsed = parseSuggestions(raw);
	if (!parsed || parsed.length === 0) {
		// Dump the raw response so we can see whether Newton returned malformed
		// JSON or valid JSON whose suggestions all failed topology validation.
		console.warn('[suggestions] error path, raw Newton response:', raw);
		return { suggestions: [], source: 'error', signature, raw };
	}
	return { suggestions: parsed, source: 'newton', signature };
}
