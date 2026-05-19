#!/usr/bin/env node
// Compare Newton C model variants on the actual operator-suggestions prompt
// used by the SWaT demo. Sends the same system prompt + state snapshot to
// each candidate, parses+validates the JSON against the topology table, and
// reports per-call latency + parse success + card count.
//
// Useful for picking between c2_4_7b and c2_5_8b for the live app.
//
// Usage: node scripts/compare-newton-models.js [--iterations 3]

import { readFileSync } from 'fs';

const TOPOLOGY = {
	P1: { upstream: null, local: 'P1', downstream: 'P2' },
	P2: { upstream: 'P1', local: 'P2', downstream: 'P3' },
	P3: { upstream: 'P2', local: 'P3', downstream: 'P4' },
	P4: { upstream: 'P3', local: 'P4', downstream: 'P5' },
	P5: { upstream: 'P4', local: 'P5', downstream: 'P6' },
	P6: { upstream: 'P5', local: 'P6', downstream: null }
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
- Emit local for every ATTACK stage. Emit upstream and downstream where topology allows.
- REQUIRED: every "text" field must cite at least one specific sensor name AND its current numeric value.
- For upstream/downstream cards, the action must refer to the TARGET stage by name.
- Keep each "text" field under 140 characters, imperative voice, concrete verbs.`;

const QUERY = `Current plant state:
- P1 raw intake: NORMAL
- P2 chemical dosing: NORMAL
- P3 ultrafiltration: ATTACK
    cite this sensor: LIT301=800.16 z=1.5 (moderate)
- P4 UV dechlorination: ATTACK
    cite this sensor: AIT402=155.22 z=11.0 (strong deviation)
- P5 reverse osmosis: ATTACK
    cite this sensor: AIT501=7.87 z=15.1 (strong deviation)
- P6 backwash: STANDBY

Generate suggestions for ATTACK stages only.`;

function loadEnv() {
	const env = {};
	const raw = readFileSync('.env', 'utf-8');
	for (const line of raw.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
}

function parseSuggestions(text) {
	if (!text) return { cards: null, parseError: 'empty response' };
	const cleaned = text
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
	const start = cleaned.indexOf('[');
	const end = cleaned.lastIndexOf(']');
	if (start === -1 || end === -1 || end <= start) return { cards: null, parseError: 'no JSON array delimiters' };
	let parsed;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch (err) {
		return { cards: null, parseError: `JSON.parse: ${err.message}` };
	}
	if (!Array.isArray(parsed)) return { cards: null, parseError: 'not an array' };
	const valid = parsed.filter((s) => {
		if (
			!s ||
			typeof s.origin !== 'string' ||
			typeof s.target !== 'string' ||
			typeof s.direction !== 'string' ||
			typeof s.text !== 'string'
		) return false;
		const topo = TOPOLOGY[s.origin];
		if (!topo) return false;
		const expectedTarget = topo[s.direction];
		if (expectedTarget === null) return false;
		return s.target === expectedTarget;
	});
	return {
		cards: parsed,
		validCards: valid,
		parseError: null,
		droppedByTopology: parsed.length - valid.length
	};
}

async function runOnce(env, model) {
	const t0 = Date.now();
	const res = await fetch(env.ATAI_API_ENDPOINT.replace(/\/$/, '') + '/v0.5/query', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.ATAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			query: QUERY,
			system_prompt: SYSTEM_PROMPT,
			instruction_prompt: SYSTEM_PROMPT,
			file_ids: [],
			model,
			max_new_tokens: 700,
			sanitize: false
		})
	});
	const wall = Date.now() - t0;
	const text = await res.text();
	let parsed;
	try { parsed = JSON.parse(text); } catch { parsed = null; }
	if (res.status !== 200) {
		return { ok: false, wall, status: res.status, error: parsed?.errors?.[0] || text.slice(0, 200) };
	}
	const raw = parsed.response?.response?.[0] || '';
	const inference = parsed.response?.generation_latency ?? parsed.inference_time_sec ?? 0;
	const queue = parsed.query_queue_time_sec ?? 0;
	const result = parseSuggestions(raw);
	return {
		ok: true,
		wall,
		inference,
		queue,
		raw,
		...result
	};
}

async function main() {
	const env = loadEnv();
	const iterations = parseInt(process.argv.slice(2).find((a) => a.startsWith('--iterations='))?.split('=')[1] ?? '3');
	const models = ['Newton::c2_4_7b_251215a172f6d7', 'Newton::c2_5_8b_260413b723a9ab'];

	console.log(`Running ${iterations} iterations against ${models.length} models`);
	console.log(`Prompt: 3 ATTACK stages (P3, P4, P5) → expect 9 cards (3 directions × 3 stages)\n`);

	const results = Object.fromEntries(models.map((m) => [m, []]));
	for (let i = 0; i < iterations; i++) {
		for (const model of models) {
			const r = await runOnce(env, model);
			results[model].push(r);
			if (r.ok) {
				const cards = r.validCards?.length ?? 0;
				const dropped = r.droppedByTopology ?? 0;
				const parseTag = r.parseError ? ` PARSE-ERR(${r.parseError})` : '';
				console.log(`[${model.split('::')[1].slice(0, 18)}] iter ${i + 1}: wall=${r.wall}ms infer=${r.inference.toFixed(2)}s queue=${r.queue.toFixed(2)}s cards=${cards}/9 dropped=${dropped}${parseTag}`);
			} else {
				console.log(`[${model.split('::')[1].slice(0, 18)}] iter ${i + 1}: HTTP ${r.status} ${JSON.stringify(r.error)}`);
			}
		}
	}

	console.log();
	for (const model of models) {
		const rs = results[model].filter((r) => r.ok);
		if (!rs.length) continue;
		const meanWall = rs.reduce((a, r) => a + r.wall, 0) / rs.length;
		const meanInfer = rs.reduce((a, r) => a + r.inference, 0) / rs.length;
		const meanCards = rs.reduce((a, r) => a + (r.validCards?.length ?? 0), 0) / rs.length;
		const meanDropped = rs.reduce((a, r) => a + (r.droppedByTopology ?? 0), 0) / rs.length;
		const parseErrors = rs.filter((r) => r.parseError).length;
		console.log(`=== ${model} ===`);
		console.log(`  wall:        ${meanWall.toFixed(0)} ms mean`);
		console.log(`  inference:   ${meanInfer.toFixed(2)} s mean`);
		console.log(`  valid cards: ${meanCards.toFixed(1)} / 9 expected`);
		console.log(`  topology drops: ${meanDropped.toFixed(1)} avg`);
		console.log(`  parse errors: ${parseErrors} / ${rs.length}`);
		console.log();
	}

	// Print sample output from each (first iteration)
	for (const model of models) {
		const first = results[model][0];
		if (!first?.ok) continue;
		console.log(`--- ${model} sample output ---`);
		console.log(first.raw.slice(0, 800));
		console.log();
	}
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
