#!/usr/bin/env node
// Standalone probe for Newton /query endpoint.
// Fires the same payload the suggestions handler would send and reports
// latency + response shape. Useful to isolate "is /query slow?" from
// "is our SvelteKit server slow?".
//
// Usage: node scripts/probe-query.js

import { readFileSync } from 'fs';

function loadEnv() {
	const env = {};
	const raw = readFileSync('.env', 'utf-8');
	for (const line of raw.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
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

const QUERY = `Current plant state:
- P1 raw intake: ATTACK
    sensors: FIT101=0.00 (normal 2.53±0.03), LIT101=540.30 (normal 518±20), MV101=2.00 (normal 2±0), P101=2.00 (normal 2±1)
- P2 chemical dosing: NORMAL
- P3 ultrafiltration: ATTACK
    sensors: DPIT301=20.10 (normal 20.2±0.4), FIT301=2.22 (normal 2.22±0.03), LIT301=815.40 (normal 850±70), MV301=1.00 (normal 1±0), MV302=2.00 (normal 2±0), MV303=1.00 (normal 1±0), MV304=1.00 (normal 1±0), P301=1.00 (normal 1±0), P302=2.00 (normal 2±0)
- P4 UV dechlorination: ATTACK
    sensors: AIT401=148.80 (normal 148.8±0.2), AIT402=164.40 (normal 163±2), FIT401=1.71 (normal 1.71±0.01), LIT401=833.70 (normal 830±60), P402=2.00 (normal 2±0), UV401=2.00 (normal 2±0)
- P5 reverse osmosis: ATTACK
    sensors: AIT501=7.90 (normal 7.9±0.03), AIT502=150.30 (normal 150±3), AIT503=271.50 (normal 271±4), AIT504=11.80 (normal 11.9±3), FIT501=1.72 (normal 1.72±0.01), FIT502=1.28 (normal 1.27±0.01), FIT503=0.74 (normal 0.74±0.01), FIT504=0.31 (normal 0.31±0.01), P501=2.00 (normal 2±0), PIT501=253.20 (normal 253±1), PIT502=1.11 (normal 1.0±0.1), PIT503=191.90 (normal 192±0.5)
- P6 backwash: STANDBY

Generate suggestions for ATTACK stages only. For each suggestion, cite the specific sensor with the largest deviation from its normal baseline, including its current numeric value.`;

async function main() {
	const env = loadEnv();
	const endpoint = env.ATAI_API_ENDPOINT.replace(/\/$/, '') + '/v0.5/query';
	const body = {
		query: QUERY,
		system_prompt: SYSTEM_PROMPT,
		instruction_prompt: SYSTEM_PROMPT,
		file_ids: [],
		model: 'Newton::c2_4_7b_251215a172f6d7',
		max_new_tokens: 500,
		sanitize: false
	};

	console.log('POST', endpoint);
	console.log('system_prompt chars:', SYSTEM_PROMPT.length);
	console.log('query chars:', QUERY.length);
	console.log('max_new_tokens:', body.max_new_tokens);
	console.log('---');

	const t0 = Date.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 180000); // 3 min cap

	try {
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.ATAI_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		const ms = Date.now() - t0;
		console.log(`status: ${res.status} ${res.statusText} in ${ms}ms`);
		const text = await res.text();
		console.log('--- response body ---');
		console.log(text.slice(0, 4000));
		if (text.length > 4000) console.log(`... (${text.length - 4000} more chars)`);
	} catch (err) {
		const ms = Date.now() - t0;
		console.error(`failed after ${ms}ms:`, err.message);
	} finally {
		clearTimeout(timeout);
	}
}

main();
