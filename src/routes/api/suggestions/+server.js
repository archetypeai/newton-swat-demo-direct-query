import { json } from '@sveltejs/kit';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { queryNewton } from '$lib/server/newton.js';

// Authoritative topology. All Newton-generated suggestions are validated
// against this table — any suggestion whose (origin, direction) doesn't map
// to the exact expected target is dropped before reaching the client.
const TOPOLOGY = {
	P1: { upstream: null, local: 'P1', downstream: 'P2' },
	P2: { upstream: 'P1', local: 'P2', downstream: 'P3' },
	P3: { upstream: 'P2', local: 'P3', downstream: 'P4' },
	P4: { upstream: 'P3', local: 'P4', downstream: 'P5' },
	P5: { upstream: 'P4', local: 'P5', downstream: 'P6' },
	P6: { upstream: 'P5', local: 'P6', downstream: null }
};

// Per-sensor baselines computed once from swat_normal.csv at module load.
// Used to tell Newton what "normal" looks like so it can reason about deviation
// rather than just restating sensor names.
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

function formatBaseline(col) {
	const b = BASELINES?.[col];
	if (!b) return '';
	const { mean, std } = b;
	// Significant figures tuned per magnitude — keeps "normal 2.51±0.05" tight
	// while still showing meaningful precision on large values like LIT301 (~800).
	const precision = Math.abs(mean) >= 100 ? 0 : Math.abs(mean) >= 10 ? 1 : 2;
	return `normal ${mean.toFixed(precision)}±${std.toFixed(precision + 1)}`;
}

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
- Emit local for every ATTACK stage. Emit upstream and downstream where topology allows (not "none").
- REQUIRED: every "text" field must cite at least one specific sensor name AND its current numeric value. Example: "FIT101=0.00 vs normal 2.51 — intake valve likely shut, isolate MV101".
- Pick the sensor with the largest deviation from its baseline. Do not invent sensor names — only use names from the state below.
- For upstream/downstream cards, the action must refer to the TARGET stage by name (e.g. an upstream card for P3 with target P2 must say "at P2" or "feed from P2", never "from P1").
- Keep each "text" field under 140 characters, imperative voice, concrete verbs ("reduce", "check", "isolate", "alert").`;

// In-memory cache keyed by anomaly signature (e.g. "P1,P4"). Cleared on server restart.
const cache = new Map();

const STAGE_NAMES = {
	P1: 'raw intake',
	P2: 'chemical dosing',
	P3: 'ultrafiltration',
	P4: 'UV dechlorination',
	P5: 'reverse osmosis',
	P6: 'backwash'
};

function buildQuery(stageStatuses, stageSensors = {}) {
	const lines = Object.entries(STAGE_NAMES).map(([id, name]) => {
		const status = (stageStatuses[id] ?? 'idle').toUpperCase();
		let line = `- ${id} ${name}: ${status}`;
		if (stageStatuses[id] === 'attack' && stageSensors[id]) {
			const sensorPairs = Object.entries(stageSensors[id])
				.map(([k, v]) => {
					const n = parseFloat(v);
					const current = isNaN(n) ? v : n.toFixed(2);
					const baseline = formatBaseline(k);
					return baseline ? `${k}=${current} (${baseline})` : `${k}=${current}`;
				})
				.join(', ');
			if (sensorPairs) line += `\n    sensors: ${sensorPairs}`;
		}
		return line;
	});
	return `Current plant state:\n${lines.join('\n')}\n\nGenerate suggestions for ATTACK stages only. For each suggestion, cite the specific sensor with the largest deviation from its normal baseline, including its current numeric value.`;
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
	try {
		const parsed = JSON.parse(cleaned.slice(start, end + 1));
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
				// Topology enforcement: the (origin, direction) pair MUST map to the claimed target.
				// This silently drops suggestions where Newton got confused about directional labels.
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

export async function POST({ request }) {
	try {
		const { stageStatuses, stageSensors = {} } = await request.json();
		if (!stageStatuses) return json({ error: 'Missing stageStatuses' }, { status: 400 });

		const anomalous = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
			.filter((id) => stageStatuses[id] === 'attack')
			.sort();
		const signature = anomalous.join(',') || 'none';

		if (anomalous.length === 0) {
			return json({ suggestions: [], source: 'newton', signature });
		}

		if (cache.has(signature)) {
			return json({ suggestions: cache.get(signature), source: 'newton-cached', signature });
		}

		const raw = await queryNewton({
			query: buildQuery(stageStatuses, stageSensors),
			systemPrompt: SYSTEM_PROMPT,
			maxNewTokens: 500
		});
		const parsed = parseSuggestions(raw);

		if (!parsed || parsed.length === 0) {
			return json({
				suggestions: [],
				source: 'error',
				signature,
				error: 'Newton response did not parse or all suggestions failed topology check',
				raw
			});
		}

		cache.set(signature, parsed);
		return json({ suggestions: parsed, source: 'newton', signature });
	} catch (err) {
		return json({ error: err.message, source: 'error' }, { status: 500 });
	}
}
