<script>
	import { onMount } from 'svelte';
	import { cn } from '$lib/utils.js';
	import Menubar from '$lib/components/ui/patterns/menubar/index.js';
	import Button from '$lib/components/ui/primitives/button/index.js';
	import Badge from '$lib/components/ui/primitives/badge/index.js';
	import SpinnerIcon from '@lucide/svelte/icons/loader';
	import StageCard from '$lib/components/ui/custom/stage-card.svelte';
	import SuggestedActions from '$lib/components/ui/custom/suggested-actions.svelte';
	import PlaybackControls from '$lib/components/ui/custom/playback-controls.svelte';
	import PlantSchematic from '$lib/components/ui/custom/plant-schematic.svelte';
	import {
		fetchChunk,
		startSessions,
		startOneSession,
		endSessions,
		streamWindow,
		fetchSuggestions
	} from '$lib/api/swat.js';
	import { fetchSuggestionsDirect } from '$lib/suggestions-direct.js';

	// Mirrors src/lib/server/newton.js STAGE_COLUMNS; kept in sync manually.
	const STAGE_COLUMNS = {
		P1: ['FIT101', 'LIT101', 'MV101', 'P101'],
		P2: ['AIT201', 'AIT202', 'AIT203', 'FIT201', 'MV201', 'P203', 'P205'],
		P3: ['DPIT301', 'FIT301', 'LIT301', 'MV301', 'MV302', 'MV303', 'MV304', 'P301', 'P302'],
		P4: ['AIT401', 'AIT402', 'FIT401', 'LIT401', 'P402', 'UV401'],
		P5: [
			'AIT501',
			'AIT502',
			'AIT503',
			'AIT504',
			'FIT501',
			'FIT502',
			'FIT503',
			'FIT504',
			'P501',
			'PIT501',
			'PIT502',
			'PIT503'
		],
		P6: ['FIT601', 'P602']
	};

	const STAGE_META = {
		P1: 'Raw water intake',
		P2: 'Chemical dosing',
		P3: 'Ultrafiltration',
		P4: 'UV dechlorination',
		P5: 'Reverse osmosis',
		P6: 'Backwash'
	};

	const STAGE_IDS = Object.keys(STAGE_COLUMNS);
	// All 6 stages monitored. Parallel mount confirmed working at 2 stages.
	const MONITORED_STAGE_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

	// Match server DEFAULT_CONFIG
	const WINDOW_SIZE = 128;
	const STEP_SIZE = 128;
	const CHUNK_SIZE = 10000;
	const REPLAY_SPEED = 10; // tick every 100ms, advance 1 row → 10× real time on 1Hz data
	// Jump straight into the attack period so the demo shows anomalies quickly.
	// SWaT normal days are first in the merged file (~604k rows); attacks begin after.
	const INITIAL_OFFSET = 701000;

	let rows = $state([]);
	let total = $state(0);
	let startOffset = $state(INITIAL_OFFSET);
	let loadedEnd = $state(0);
	let playheadIdx = $state(0);
	let playing = $state(false);
	let playInterval = null;
	let streamCounter = $state(0);
	let loadingChunk = $state(false);

	let sessionStatus = $state('idle'); // idle | connecting | active | error
	let setupStep = $state('');
	let sessions = $state([]);
	let sseSources = {}; // stageId → EventSource (not tracked)

	let stageStatuses = $state(Object.fromEntries(STAGE_IDS.map((s) => [s, 'idle'])));
	let stageLabels = $state(Object.fromEntries(STAGE_IDS.map((s) => [s, []])));
	// Tracks which per-stage SSE streams have delivered at least one inference result.
	// Play stays disabled until all 6 are ready, so the user can't advance the playhead
	// into a state where some stages silently produce nothing (the P4-stuck scenario).
	let stagesReady = $state(Object.fromEntries(STAGE_IDS.map((s) => [s, false])));
	// False until the user actually presses Play. Gates visible classifications so that
	// pre-warm results don't leak into the UI before playback starts.
	let hasStartedPlayback = $state(false);

	let liveRow = $derived(rows[playheadIdx] ?? null);
	let sessionMap = $derived(
		Object.fromEntries(sessions.map((s) => [s.stageId, s.sessionId]))
	);
	let sessionIds = $derived(sessions.map((s) => s.sessionId));
	let readyCount = $derived(MONITORED_STAGE_IDS.filter((s) => stagesReady[s]).length);
	let allStagesReady = $derived(
		sessions.length > 0 && readyCount === MONITORED_STAGE_IDS.length
	);
	let warmingUp = $derived(sessionStatus === 'active' && !allStagesReady);

	// Gate P6 classification on activity. P6 is the backwash loop — when FIT601 ≈ 0
	// the stage is idle/standby and Newton's classification is essentially noise
	// (flat sensor values + sparse attack-class examples for P6 in the n-shot corpus).
	// Only trust the classification when the backwash is actually flowing.
	const P6_ACTIVITY_THRESHOLD = 0.01;
	let aiSuggestions = $state(null);
	let suggestionSource = $state('loading');
	let suggestionSignature = $state('');
	let suggestionDebounce = null;
	let suggestionFetchInFlight = false;
	// Newton credentials + baselines for the direct-to-Newton suggestions path.
	// The SvelteKit server route was getting wedged on /query calls, so we now
	// call Newton from the browser using the apiKey returned with each session.
	let newtonApiKey = $state(null);
	let newtonEndpoint = $state(null);
	let sensorBaselines = $state(null);

	let effectiveStatuses = $derived.by(() => {
		const out = { ...stageStatuses };
		// Unmonitored stages — P2, P6 — show as a muted "Not monitored" pill once the
		// user has clicked Start analysis. Before Start, they just read "Idle" like the rest.
		if (sessionStatus === 'active') {
			for (const s of STAGE_IDS) {
				if (!MONITORED_STAGE_IDS.includes(s)) out[s] = 'unmonitored';
			}
		}
		// Standby gating for P6 only relevant when P6 is monitored, which we're not.
		// Keep the flow gate anyway in case we re-enable P6 later.
		if (hasStartedPlayback && liveRow && MONITORED_STAGE_IDS.includes('P6')) {
			const flow = parseFloat(liveRow.FIT601 ?? '0');
			if (!isNaN(flow) && flow < P6_ACTIVITY_THRESHOLD) {
				out.P6 = 'standby';
			}
		}
		return out;
	});

	async function loadInitialChunk() {
		loadingChunk = true;
		try {
			const data = await fetchChunk(startOffset, CHUNK_SIZE);
			rows = data.rows;
			total = data.total;
			loadedEnd = startOffset + data.rows.length;
		} catch (err) {
			console.error('Failed to load initial chunk:', err);
		} finally {
			loadingChunk = false;
		}
	}

	async function loadNextChunk() {
		if (loadingChunk || loadedEnd >= total) return;
		loadingChunk = true;
		try {
			const data = await fetchChunk(loadedEnd, CHUNK_SIZE);
			rows = [...rows, ...data.rows];
			loadedEnd += data.rows.length;
		} catch (err) {
			console.error('Failed to load chunk:', err);
		} finally {
			loadingChunk = false;
		}
	}

	// Session cleanup across page reloads / tab closes. Sessions created but never
	// destroyed pile up on Newton (we hit ~98 orphans across earlier dev cycles).
	// Two layers:
	//   1. localStorage holds the session IDs of the currently-active run. On mount
	//      we sync-fire a cleanup for any leftover IDs from a previous tab that
	//      crashed before Stop was clicked.
	//   2. pagehide/beforeunload fires a fetch with keepalive:true so the DELETE
	//      survives page unload.
	const ACTIVE_SESSIONS_KEY = 'swat-demo-active-sessions';

	onMount(() => {
		try {
			const stored = localStorage.getItem(ACTIVE_SESSIONS_KEY);
			if (stored) {
				const staleIds = JSON.parse(stored);
				if (Array.isArray(staleIds) && staleIds.length > 0) {
					endSessions(staleIds).catch(() => {});
				}
				localStorage.removeItem(ACTIVE_SESSIONS_KEY);
			}
		} catch {}

		// One-time fetch of precomputed sensor baselines + Newton API endpoint.
		// Used by the direct-to-Newton suggestions path.
		fetch('/api/baselines')
			.then((r) => r.json())
			.then((data) => {
				sensorBaselines = data.baselines ?? null;
				newtonEndpoint = data.endpoint ?? null;
			})
			.catch((err) => console.error('[baselines] failed:', err));

		const onUnload = () => {
			if (sessionIds.length > 0) {
				endSessions(sessionIds, { keepalive: true }).catch(() => {});
			}
		};
		window.addEventListener('pagehide', onUnload);
		return () => window.removeEventListener('pagehide', onUnload);
	});

	$effect(() => {
		// Persist the live session IDs so onMount in the next tab can clean up if we crash.
		try {
			if (sessionIds.length > 0) {
				localStorage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(sessionIds));
			} else {
				localStorage.removeItem(ACTIVE_SESSIONS_KEY);
			}
		} catch {}
	});

	// DIAGNOSTIC — remove once SSE parser alignment is confirmed.
	const SSE_DEBUG_LIMIT = 20;
	const sseDebugCounts = {};
	// Track which event types we've seen before so we can loudly log any NEW type
	// Newton emits that we weren't expecting.
	const KNOWN_SSE_TYPES = new Set([
		'sse.stream.start',
		'sse.stream.heartbeat',
		'sse.stream.end',
		'session.modify.result',
		'inference.result',
		'stream.null'
	]);
	const seenTypes = new Set();

	function parseSSELabel(event, stageId = '?') {
		let parsed;
		try {
			parsed = JSON.parse(event.data);
		} catch (err) {
			return null;
		}

		const n = (sseDebugCounts[stageId] = (sseDebugCounts[stageId] ?? 0) + 1);
		// Always log inference.result events (the signal we care about). Other types
		// are capped so heartbeat noise doesn't flood the console.
		const isUnknownType = parsed.type && !KNOWN_SSE_TYPES.has(parsed.type);
		const verbose = n <= SSE_DEBUG_LIMIT || parsed.type === 'inference.result' || isUnknownType;

		// Loudly flag any event type we weren't expecting — could be Newton signalling
		// completion or emitting classifications under a type we're filtering out.
		if (isUnknownType && !seenTypes.has(parsed.type)) {
			seenTypes.add(parsed.type);
			console.warn(
				'[SSE debug] ⚠️  UNKNOWN EVENT TYPE',
				stageId,
				parsed.type,
				'full event:',
				parsed
			);
		}

		// Every event beyond the detailed-log limit: one compact line per event so we
		// can see the stream rhythm during long silences. No event_data body to keep noise low.
		if (n > SSE_DEBUG_LIMIT && parsed.type !== 'inference.result' && !isUnknownType) {
			console.log('[SSE trace]', stageId, '#' + n, parsed.type);
		}

		// Targeted extraction — look for a 'response' field in the known nesting
		// locations only. No recursive searching; avoids false positives on any
		// stray "ATTACK" or "NORMAL" string that happens to live in metadata.
		const extract = (obj) => {
			if (!obj || typeof obj !== 'object') return null;
			const r = obj.response;
			if (typeof r === 'string') return r;
			if (Array.isArray(r) && r.length) return r[0];
			if (r && typeof r === 'object') {
				return r.class_name || r.label || r.prediction || null;
			}
			return null;
		};

		let label = null;
		if (parsed.type === 'inference.result') {
			label = extract(parsed.event_data);
		} else if (parsed.event_data) {
			label = extract(parsed.event_data) || extract(parsed.event_data.event_data);
		}

		// Only accept the two canonical class labels. Newton sometimes returns "unknown"
		// when the lens has been torn down or can't classify — we should not treat that
		// as a real classification (it'd falsely flip stagesReady during warmup).
		if (label) {
			const up = String(label).toUpperCase();
			if (up !== 'ATTACK' && up !== 'NORMAL') label = null;
		}

		if (verbose) {
			console.log(
				'[SSE debug]',
				stageId,
				'#' + n,
				'type:',
				parsed.type,
				'extracted:',
				label,
				'event_data JSON:',
				JSON.stringify(parsed.event_data).slice(0, 800)
			);
		}

		return label;
	}

	function openStageSSE(stageId, sseUrl) {
		const proxyUrl = `/api/sse-proxy?url=${encodeURIComponent(sseUrl)}`;
		const es = new EventSource(proxyUrl);
		es.onmessage = (ev) => {
			const label = parseSSELabel(ev, stageId);
			if (!label) return;
			stagesReady[stageId] = true;
			if (!hasStartedPlayback) {
				// Pre-warm result — prove the session is alive but don't reveal the label yet
				stageStatuses[stageId] = 'ready';
				return;
			}
			const upper = String(label).toUpperCase();
			stageLabels[stageId] = [...stageLabels[stageId], upper].slice(-20);
			stageStatuses[stageId] =
				upper === 'ATTACK' ? 'attack' : upper === 'NORMAL' ? 'normal' : 'pending';
		};
		es.onerror = () => {
			// Keep EventSource — browser will auto-reconnect. No need to recreate here.
		};
		sseSources[stageId] = es;
	}

	// Poll stagesReady[stageId] until true, or timeout. Lets us enforce "don't start
	// stage N+1 until stage N has landed its first inference.result".
	function waitForStageReady(stageId, timeoutMs = 180000) {
		return new Promise((resolve) => {
			const start = Date.now();
			const interval = setInterval(() => {
				if (stagesReady[stageId]) {
					clearInterval(interval);
					resolve(true);
				} else if (Date.now() - start > timeoutMs) {
					clearInterval(interval);
					console.warn(`[warmup] ${stageId} did not produce inference.result in ${timeoutMs}ms, continuing anyway`);
					resolve(false);
				}
			}, 500);
		});
	}

	async function handleStart() {
		if (sessions.length > 0) return;
		sessionStatus = 'connecting';
		setupStep = `Mounting ${MONITORED_STAGE_IDS.length} lens${MONITORED_STAGE_IDS.length > 1 ? 'es' : ''} in parallel...`;
		try {
			// Mount all stages' sessions concurrently — each is an independent lens
			// registration + session create. Server-side setup (cleanStaleLenses +
			// n-shot upload) is guarded against duplicate runs via cached file_ids.
			const newSessions = await Promise.all(
				MONITORED_STAGE_IDS.map((stageId) =>
					startOneSession(stageId, { windowSize: WINDOW_SIZE, stepSize: STEP_SIZE })
				)
			);
			sessions = newSessions;
			// Capture Newton API key so the direct-to-Newton suggestions path can call /query.
			if (newSessions[0]?.apiKey) newtonApiKey = newSessions[0].apiKey;

			for (const session of newSessions) {
				openStageSSE(session.stageId, session.sseUrl);
			}

			// Brief wait for EventSource handshakes to complete on all streams
			await new Promise((r) => setTimeout(r, 1500));

			for (const stageId of MONITORED_STAGE_IDS) {
				stagesReady[stageId] = true;
				stageStatuses[stageId] = 'ready';
			}
			sessionStatus = 'active';
			setupStep = '';
		} catch (err) {
			console.error('Session setup failed:', err);
			sessionStatus = 'error';
			setupStep = err.message;
		}
	}

	async function handleStop() {
		handlePause();
		for (const stageId of Object.keys(sseSources)) {
			try {
				sseSources[stageId].close();
			} catch {}
		}
		sseSources = {};
		if (sessionIds.length) {
			await endSessions(sessionIds).catch(() => {});
		}
		sessions = [];
		sessionStatus = 'idle';
		stageStatuses = Object.fromEntries(STAGE_IDS.map((s) => [s, 'idle']));
		stageLabels = Object.fromEntries(STAGE_IDS.map((s) => [s, []]));
		stagesReady = Object.fromEntries(STAGE_IDS.map((s) => [s, false]));
		hasStartedPlayback = false;
	}

	async function streamCurrentWindow() {
		if (!sessions.length) return;
		const windowEnd = (streamCounter + 1) * STEP_SIZE;
		const windowStart = windowEnd - WINDOW_SIZE;
		if (windowStart < 0 || windowEnd > rows.length) return;
		const windowRows = rows.slice(windowStart, windowEnd);
		try {
			await streamWindow(sessionMap, windowRows, streamCounter);
			streamCounter++;
		} catch (err) {
			console.error('Stream failed:', err);
		}
	}

	// Pre-warm Newton after sessions come up. Only purpose is to trigger the first
	// inference.result on each stage's SSE so the warmup gate can flip from
	// "Warming up" → "Ready" — actual pre-warm classifications are not shown to
	// the user (hasStartedPlayback gates display). One window is therefore enough;
	// additional windows would just queue wasted inference work on Newton's side.
	// Windows fire in parallel so the outer latency is bounded by the slowest
	// Newton response, not the sum.
	async function preWarmSessions(count = 1) {
		if (!sessions.length) return;
		const sends = [];
		for (let i = 0; i < count; i++) {
			const startIdx = (streamCounter + i) * STEP_SIZE;
			const endIdx = startIdx + WINDOW_SIZE;
			if (endIdx > rows.length) break;
			const windowRows = rows.slice(startIdx, endIdx);
			sends.push(
				streamWindow(sessionMap, windowRows, streamCounter + i).catch((err) => {
					console.error('Pre-warm send failed:', err);
				})
			);
		}
		await Promise.all(sends);
		streamCounter += sends.length;
	}

	function handlePlay() {
		if (!rows.length) return;
		playing = true;
		hasStartedPlayback = true;

		// Fire a single window at Play start so Newton starts processing immediately
		// instead of waiting ~1.3s for the playhead to advance STEP_SIZE rows.
		if (sessions.length && rows.length >= WINDOW_SIZE) {
			streamCurrentWindow();
		}

		playInterval = setInterval(() => {
			if (playheadIdx < rows.length - 1) {
				playheadIdx += 1;
			}

			// Pre-load next chunk when the playhead gets within 1000 rows of the end
			if (playheadIdx > rows.length - 1000 && loadedEnd < total) {
				loadNextChunk();
			}

			// Every STEP_SIZE rows, ship a window to Newton
			if (sessions.length && playheadIdx >= (streamCounter + 1) * STEP_SIZE) {
				streamCurrentWindow();
			}

			if (playheadIdx >= rows.length - 1 && loadedEnd >= total) {
				playing = false;
				clearInterval(playInterval);
			}
		}, 1000 / REPLAY_SPEED); // 100ms per tick
	}

	function handlePause() {
		playing = false;
		if (playInterval) clearInterval(playInterval);
	}

	function handleReset() {
		handlePause();
		playheadIdx = 0;
		streamCounter = 0;
		stageLabels = Object.fromEntries(STAGE_IDS.map((s) => [s, []]));
		hasStartedPlayback = false;
		if (sessionStatus === 'active') {
			stageStatuses = Object.fromEntries(STAGE_IDS.map((s) => [s, 'ready']));
		}
	}

	$effect(() => {
		loadInitialChunk();
	});

	// Debounced Newton-suggestion trigger: whenever the set of ATTACK stages changes,
	// wait ANOMALY_DEBOUNCE_MS for the state to settle, then ask Newton to generate
	// operator actions. On error or while waiting, the panel shows a loading/error
	// message — we do not render any fallback actions.
	const ANOMALY_DEBOUNCE_MS = 2000;
	let anomalySignature = $derived.by(() => {
		return ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
			.filter((id) => effectiveStatuses[id] === 'attack')
			.sort()
			.join(',');
	});

	async function runSuggestionsFetch() {
		if (suggestionFetchInFlight) return;
		const sig = anomalySignature;
		if (!sig) return;
		suggestionFetchInFlight = true;
		suggestionSource = 'loading';
		console.log('[suggestions] fetch firing for', sig);

		const stageSensors = {};
		if (liveRow) {
			for (const stageId of STAGE_IDS) {
				if (effectiveStatuses[stageId] !== 'attack') continue;
				const sensors = {};
				for (const col of STAGE_COLUMNS[stageId]) {
					sensors[col] = liveRow[col];
				}
				stageSensors[stageId] = sensors;
			}
		}

		// Client-side safety timeout — if the server stalls past this, mark as
		// error so the UI doesn't sit in "analysing…" forever. Bumped from 90s to
		// 150s because Newton /query is reaching that range for the full 6-stage
		// prompt with baselines.
		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error('Client timeout: 150s exceeded')), 150000)
		);

		try {
			// Direct-to-Newton path: browser → Newton /query, bypassing our SvelteKit
			// route (which was getting wedged at 150s). Falls back to the server
			// route if credentials or baselines aren't loaded yet.
			const canCallDirect = newtonApiKey && newtonEndpoint && sensorBaselines;
			const fetcher = canCallDirect
				? fetchSuggestionsDirect({
						apiKey: newtonApiKey,
						endpoint: newtonEndpoint,
						baselines: sensorBaselines,
						stageStatuses: effectiveStatuses,
						stageSensors
					})
				: fetchSuggestions(effectiveStatuses, stageSensors);
			const result = await Promise.race([fetcher, timeoutPromise]);
			console.log(
				'[suggestions]',
				canCallDirect ? 'direct' : 'server',
				'got',
				result.source,
				result.suggestions?.length ?? 0,
				'cards'
			);
			aiSuggestions = result.suggestions ?? [];
			suggestionSource = result.source ?? 'error';
			suggestionSignature = result.signature ?? sig;
		} catch (err) {
			console.error('[suggestions] failed:', err);
			aiSuggestions = [];
			suggestionSource = 'error';
			// Record the signature even on error so the effect doesn't immediately
			// re-trigger another fetch for the same attack set. Prevents a tight
			// retry loop when Newton is failing.
			suggestionSignature = sig;
		} finally {
			suggestionFetchInFlight = false;
			// Signature may have moved while the fetch was in flight. If it did,
			// kick off another fetch right away so cards keep up without the user
			// waiting another debounce cycle.
			if (anomalySignature && anomalySignature !== suggestionSignature) {
				runSuggestionsFetch();
			}
		}
	}

	$effect(() => {
		const sig = anomalySignature;

		if (!sig) {
			if (suggestionDebounce) {
				clearTimeout(suggestionDebounce);
				suggestionDebounce = null;
			}
			aiSuggestions = [];
			suggestionSource = 'newton';
			suggestionSignature = '';
			return;
		}

		if (sig === suggestionSignature && aiSuggestions) return;

		// Do not restart the debounce on every signature change — that was making
		// the fetch never fire during attack flapping. Instead: if nothing is
		// scheduled and nothing is in flight, schedule one debounced fetch. Further
		// signature churn just sits; when the in-flight fetch returns, its finally
		// block will re-fetch if the signature has moved on.
		suggestionSource = 'loading';
		if (suggestionDebounce || suggestionFetchInFlight) return;

		suggestionDebounce = setTimeout(() => {
			suggestionDebounce = null;
			runSuggestionsFetch();
		}, ANOMALY_DEBOUNCE_MS);
	});
</script>

<svelte:head><title>Newton · SWaT</title></svelte:head>

<a
	href="#main-content"
	class="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:ring-2 focus:ring-ring"
>
	Skip to content
</a>

{#snippet partnerSnippet()}
	<span class="text-muted-foreground font-mono text-sm tracking-wider uppercase">
		SWaT · 6-stage water treatment
	</span>
{/snippet}

<div
	class="bg-background text-foreground grid h-screen grid-rows-[auto_auto_auto_1fr] overflow-hidden"
>
	<Menubar partnerLogo={partnerSnippet}>
		{#if sessionStatus === 'active' && warmingUp}
			<Badge variant="outline" class="text-atai-warning font-mono">
				<SpinnerIcon class="size-3 animate-spin" aria-hidden="true" />
				Warming up · {readyCount}/{MONITORED_STAGE_IDS.length} stages ready
			</Badge>
			<Button
				variant="outline"
				size="sm"
				onclick={() => {
					for (const s of MONITORED_STAGE_IDS) {
						stagesReady[s] = true;
						if (stageStatuses[s] === 'warmup') stageStatuses[s] = 'ready';
					}
				}}
			>
				Skip
			</Button>
			<Button variant="outline" size="sm" onclick={handleStop}>Stop</Button>
		{:else if sessionStatus === 'active'}
			<Badge variant="outline" class="text-atai-good font-mono">Newton · 6 sessions ready</Badge>
			<Button variant="outline" size="sm" onclick={handleStop}>Stop</Button>
		{:else if sessionStatus === 'connecting'}
			<Button variant="default" size="sm" disabled>
				<SpinnerIcon class="size-3.5 animate-spin" aria-hidden="true" />
				{setupStep || 'Connecting...'}
			</Button>
		{:else}
			<Button variant="default" size="sm" onclick={handleStart} disabled={!rows.length}>
				Start analysis
			</Button>
		{/if}
	</Menubar>

	<div class="border-border flex items-center gap-4 border-b px-4 py-2">
		<PlaybackControls
			{playing}
			current={startOffset + playheadIdx}
			{total}
			speed={REPLAY_SPEED}
			disabled={!rows.length || warmingUp}
			onplay={handlePlay}
			onpause={handlePause}
			onreset={handleReset}
		/>
	</div>

	<main id="main-content" class="grid grid-cols-[3fr_1fr] gap-4 overflow-hidden p-4">
		<h1 class="sr-only">SWaT per-stage anomaly dashboard</h1>

		<div class="flex min-h-0 flex-col gap-3 overflow-hidden">
			<section aria-label="Plant process flow" class="shrink-0">
				<PlantSchematic stageStatuses={effectiveStatuses} class="max-h-44" />
			</section>

			<section
				class="grid min-h-0 flex-1 grid-cols-6 gap-3 overflow-hidden"
				aria-label="Process stages"
			>
				{#each STAGE_IDS as stageId}
					<StageCard
						{stageId}
						stageName={STAGE_META[stageId]}
						columns={STAGE_COLUMNS[stageId]}
						{liveRow}
						status={effectiveStatuses[stageId]}
						recentLabels={stageLabels[stageId]}
						class="min-h-0 overflow-hidden"
					/>
				{/each}
			</section>
		</div>

		<section class="min-h-0 overflow-hidden" aria-label="Suggested actions">
			<SuggestedActions
				stageStatuses={effectiveStatuses}
				stageNames={STAGE_META}
				{aiSuggestions}
				source={suggestionSource}
			/>
		</section>
	</main>

	{#if sessionStatus === 'error'}
		<div
			class="bg-destructive text-destructive-foreground fixed right-4 bottom-4 max-w-md rounded-md px-4 py-3 font-mono text-xs"
			role="alert"
		>
			Session setup error: {setupStep}
		</div>
	{/if}
</div>
