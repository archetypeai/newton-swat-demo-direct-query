#!/usr/bin/env node
// Probe Newton::c2_4_7b_251215a172f6d7 via /query with image / video input.
// Goal: see whether the same text-reasoning model accepts vision input via
// either file_ids (uploaded file) or a data.base event (base64 inline).
//
// Usage:
//   node scripts/probe-newton-vision.js <path-to-image-or-video>
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
	const env = {};
	const raw = readFileSync('.env', 'utf-8');
	for (const line of raw.split('\n')) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
}

const ENV = loadEnv();
const BASE = ENV.ATAI_API_ENDPOINT.replace(/\/$/, '') + '/v0.5';
const NEWTON_MODEL = 'Newton::c2_4_7b_251215a172f6d7';

async function uploadFile(path, mime) {
	const buffer = readFileSync(path);
	const formData = new FormData();
	formData.append('file', new Blob([buffer], { type: mime }), path.split('/').pop());
	const res = await fetch(`${BASE}/files`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ENV.ATAI_API_KEY}` },
		body: formData
	});
	const text = await res.text();
	console.log(`[upload] ${res.status}: ${text.slice(0, 400)}`);
	if (!res.ok) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function postQuery(body, label) {
	console.log(`\n[${label}] POST ${BASE}/query`);
	const t0 = Date.now();
	const res = await fetch(`${BASE}/query`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${ENV.ATAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});
	const ms = Date.now() - t0;
	const text = await res.text();
	console.log(`  status: ${res.status} in ${ms}ms`);
	console.log(`  body:   ${text.slice(0, 2000)}`);
	if (text.length > 2000) console.log(`  ... (${text.length - 2000} more chars)`);
}

async function main() {
	const path = process.argv[2];
	if (!path) {
		console.error('Usage: node scripts/probe-newton-vision.js <file>');
		process.exit(1);
	}
	const ext = path.split('.').pop().toLowerCase();
	const mime =
		ext === 'png' ? 'image/png'
		: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
		: ext === 'mp4' ? 'video/mp4'
		: 'application/octet-stream';
	console.log(`File: ${path}  mime: ${mime}`);

	// (1) Upload and grab a file_id.
	const uploaded = await uploadFile(resolve(path), mime);
	const fileId = uploaded?.file_id || uploaded?.id;
	if (!fileId) {
		console.error('Upload failed or no file_id returned; aborting');
		return;
	}
	console.log(`file_id: ${fileId}`);

	// (2) /query with file_ids pointing at the upload, Newton text model.
	await postQuery(
		{
			query: 'Describe what you see in the attached file. Be specific about visual elements.',
			system_prompt: 'You are a vision-capable assistant. Describe images and videos in detail.',
			instruction_prompt: 'You are a vision-capable assistant. Describe images and videos in detail.',
			file_ids: [fileId],
			model: NEWTON_MODEL,
			max_new_tokens: 300,
			sanitize: false
		},
		'A: file_ids + Newton text model'
	);

	// (3) /query with file_ids only, no prompt — see if Newton infers task.
	await postQuery(
		{
			query: 'What is this?',
			file_ids: [fileId],
			model: NEWTON_MODEL,
			max_new_tokens: 200,
			sanitize: false
		},
		'B: minimal prompt + file_ids'
	);

	// (4) data.base64_img event with base64-encoded image inline. Doc-confirmed type.
	if (mime.startsWith('image/')) {
		const b64 = readFileSync(resolve(path)).toString('base64');
		await postQuery(
			{
				query: 'Describe this.',
				model: NEWTON_MODEL,
				max_new_tokens: 200,
				sanitize: false,
				events: [
					{
						type: 'data.base64_img',
						event_data: { contents: b64, mime_type: mime }
					}
				]
			},
			'C: data.base64_img inline'
		);
	}
}

main().catch((err) => console.error('FATAL:', err));
