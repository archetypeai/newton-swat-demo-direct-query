<script>
	import { onMount } from 'svelte';
	import { cn } from '$lib/utils.js';
	import Menubar from '$lib/components/ui/patterns/menubar/index.js';
	import Button from '$lib/components/ui/primitives/button/index.js';
	import Badge from '$lib/components/ui/primitives/badge/index.js';
	import SpinnerIcon from '@lucide/svelte/icons/loader';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import StageCard from '$lib/components/ui/custom/stage-card.svelte';
	import SuggestedActions from '$lib/components/ui/custom/suggested-actions.svelte';
	import PlaybackControls from '$lib/components/ui/custom/playback-controls.svelte';
	import PlantSchematic from '$lib/components/ui/custom/plant-schematic.svelte';
	import EmbeddingPanel from '$lib/components/ui/custom/embedding-panel.svelte';
	import { fetchChunk, classifyWindow, fetchProjections, fetchSuggestions } from '$lib/api/swat.js';
	import { fetchSuggestionsDirect } from '$lib/suggestions-direct.js';

	// Mirrors src/lib/server/newton.js STAGE_COLUMNS; kept in sync manually.
	const STAGE_COLUMNS = {
		P1: ['FIT101', 'LIT101', 'MV101', 'P101'],
		P2: ['AIT201', 'AIT202', 'AIT203', 'FIT201', 'MV201', 'P203', 'P205'],
		P3: ['DPIT301', 'FIT301', 'LIT301', 'MV301', 'MV302', 'MV303', 'MV304', 'P301', 'P302'],
		P4: ['AIT401', 'AIT402', 'FIT401', 'LIT401', 'P402', 'UV401'],
		P5: [
			'AIT501', 'AIT502', 'AIT503', 'AIT504',
			'FIT501', 'FIT502', 'FIT503', 'FIT504',
			'P501', 'PIT501', 'PIT502', 'PIT503'
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
	const MONITORED_STAGE_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

	const WINDOW_SIZE = 128;
	const STEP_SIZE = 128;
	const CHUNK_SIZE = 10000;
	const REPLAY_SPEED = 10; // tick every 100ms, advance 1 row → 10× real time on 1Hz data
	// Jump into the attack-dense region (rows 1,384,098 → ~1,390,098 contain
	// ~50% attack-labeled rows). In this prepared dataset all 54,621 attack rows
	// are packed into the last ~4% of the file (1.387M+); anywhere else is all
	// normal, so starting earlier means the demo never sees a real attack.
	const INITIAL_OFFSET = 1384000;
	// Live cursor trail length per stage (oldest entries drop off).
	const TRAIL_LENGTH = 8;

	let rows = $state([]);
	let total = $state(0);
	let startOffset = $state(INITIAL_OFFSET);
	let loadedEnd = $state(0);
	let playheadIdx = $state(0);
	let playing = $state(false);
	let playInterval = null;
	let streamCounter = $state(0);
	let loadingChunk = $state(false);

	// Direct Query is stateless — no sessions, no setup. "ready" means we've loaded
	// the inference CSV chunk and projections; "classifying" appears transiently
	// during in-flight /api/classify calls.
	let sessionStatus = $state('idle'); // idle | ready | error
	let setupError = $state('');

	let stageStatuses = $state(Object.fromEntries(STAGE_IDS.map((s) => [s, 'idle'])));
	let stageLabels = $state(Object.fromEntries(STAGE_IDS.map((s) => [s, []])));
	let hasStartedPlayback = $state(false);
	let classifyInFlight = $state(false);

	// Per-stage library coords (loaded once from /api/projections) and live-cursor
	// trail (filled as classify responses arrive). Both PCA and UMAP carried in
	// parallel so the embedding panel can toggle modes without re-fetching.
	let libraryCoords = $state(null); // { P1: { columns, library: { pca:[], umap:[] } }, ... }
	let liveTrail = $state(Object.fromEntries(STAGE_IDS.map((s) => [s, []])));
	let embeddingPanelOpen = $state(false);

	let liveRow = $derived(rows[playheadIdx] ?? null);

	// Gate P6 classification on activity. P6 is the backwash loop — when FIT601 ≈ 0
	// the stage is idle/standby and classification is essentially noise.
	const P6_ACTIVITY_THRESHOLD = 0.01;
	let aiSuggestions = $state(null);
	let suggestionSource = $state('loading');
	let suggestionSignature = $state('');
	let suggestionDebounce = null;
	let suggestionFetchInFlight = false;
	let newtonApiKey = $state(null);
	let newtonEndpoint = $state(null);
	let sensorBaselines = $state(null);

	let effectiveStatuses = $derived.by(() => {
		const out = { ...stageStatuses };
		if (sessionStatus === 'ready' && hasStartedPlayback && liveRow) {
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

	onMount(() => {
		// One-time fetch of baselines + Newton creds for the direct-to-Newton suggestions path.
		fetch('/api/baselines')
			.then((r) => r.json())
			.then((data) => {
				sensorBaselines = data.baselines ?? null;
				newtonEndpoint = data.endpoint ?? null;
				newtonApiKey = data.apiKey ?? null;
			})
			.catch((err) => console.error('[baselines] failed:', err));

		// Static library projection coords for the embedding panel. Background
		// scatter. Live cursor is appended per classify response.
		fetchProjections()
			.then((data) => {
				libraryCoords = data.stages ?? null;
			})
			.catch((err) => console.warn('[projections] failed:', err));
	});

	async function handleStart() {
		if (sessionStatus === 'ready') return;
		sessionStatus = 'ready';
		setupError = '';
		for (const s of MONITORED_STAGE_IDS) stageStatuses[s] = 'ready';
	}

	function handleStop() {
		handlePause();
		sessionStatus = 'idle';
		stageStatuses = Object.fromEntries(STAGE_IDS.map((s) => [s, 'idle']));
		stageLabels = Object.fromEntries(STAGE_IDS.map((s) => [s, []]));
		liveTrail = Object.fromEntries(STAGE_IDS.map((s) => [s, []]));
		hasStartedPlayback = false;
	}

	async function classifyCurrentWindow() {
		if (sessionStatus !== 'ready') return;
		const windowEnd = (streamCounter + 1) * STEP_SIZE;
		const windowStart = windowEnd - WINDOW_SIZE;
		if (windowStart < 0 || windowEnd > rows.length) return;
		const counter = streamCounter;
		streamCounter++;
		const windowRows = rows.slice(windowStart, windowEnd);
		classifyInFlight = true;
		try {
			const result = await classifyWindow(windowRows);
			if (!hasStartedPlayback) return;
			for (const stageId of MONITORED_STAGE_IDS) {
				const stage = result.stages?.[stageId];
				if (!stage) continue;
				const upper = String(stage.label || '').toUpperCase();
				if (upper !== 'ATTACK' && upper !== 'NORMAL') continue;
				stageLabels[stageId] = [...stageLabels[stageId], upper].slice(-20);
				stageStatuses[stageId] = upper === 'ATTACK' ? 'attack' : 'normal';
				if (stage.coords) {
					const next = [...liveTrail[stageId], { ...stage.coords, label: upper, counter }];
					liveTrail[stageId] = next.slice(-TRAIL_LENGTH);
				}
			}
			if (result.errors?.length) {
				console.warn('[classify] partial errors:', result.errors);
			}
		} catch (err) {
			console.error('[classify] failed:', err);
		} finally {
			classifyInFlight = false;
		}
	}

	function handlePlay() {
		if (!rows.length) return;
		playing = true;
		hasStartedPlayback = true;

		if (sessionStatus === 'ready' && rows.length >= WINDOW_SIZE) {
			classifyCurrentWindow();
		}

		playInterval = setInterval(() => {
			if (playheadIdx < rows.length - 1) playheadIdx += 1;

			if (playheadIdx > rows.length - 1000 && loadedEnd < total) loadNextChunk();

			if (sessionStatus === 'ready' && playheadIdx >= (streamCounter + 1) * STEP_SIZE) {
				classifyCurrentWindow();
			}

			if (playheadIdx >= rows.length - 1 && loadedEnd >= total) {
				playing = false;
				clearInterval(playInterval);
			}
		}, 1000 / REPLAY_SPEED);
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
		liveTrail = Object.fromEntries(STAGE_IDS.map((s) => [s, []]));
		hasStartedPlayback = false;
		if (sessionStatus === 'ready') {
			stageStatuses = Object.fromEntries(STAGE_IDS.map((s) => [s, 'ready']));
		}
	}

	$effect(() => {
		loadInitialChunk();
	});

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

		const stageSensors = {};
		if (liveRow) {
			for (const stageId of STAGE_IDS) {
				if (effectiveStatuses[stageId] !== 'attack') continue;
				const sensors = {};
				for (const col of STAGE_COLUMNS[stageId]) sensors[col] = liveRow[col];
				stageSensors[stageId] = sensors;
			}
		}

		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error('Client timeout: 150s exceeded')), 150000)
		);

		try {
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
			aiSuggestions = result.suggestions ?? [];
			suggestionSource = result.source ?? 'error';
			suggestionSignature = result.signature ?? sig;
		} catch (err) {
			console.error('[suggestions] failed:', err);
			aiSuggestions = [];
			suggestionSource = 'error';
			suggestionSignature = sig;
		} finally {
			suggestionFetchInFlight = false;
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
		suggestionSource = 'loading';
		if (suggestionDebounce || suggestionFetchInFlight) return;
		suggestionDebounce = setTimeout(() => {
			suggestionDebounce = null;
			runSuggestionsFetch();
		}, ANOMALY_DEBOUNCE_MS);
	});
</script>

<svelte:head><title>Newton · SWaT (Direct Query)</title></svelte:head>

<a
	href="#main-content"
	class="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:ring-2 focus:ring-ring"
>
	Skip to content
</a>

{#snippet partnerSnippet()}
	<span class="text-muted-foreground font-mono text-sm tracking-wider uppercase">
		SWaT · Direct Query · 6-stage water treatment
	</span>
{/snippet}

<div
	class="bg-background text-foreground flex min-h-screen flex-col"
>
	<Menubar partnerLogo={partnerSnippet}>
		{#if sessionStatus === 'ready'}
			<Badge variant="outline" class="text-atai-good font-mono">
				Newton · Direct Query{classifyInFlight ? ' · classifying' : ' · ready'}
			</Badge>
			<Button variant="outline" size="sm" onclick={handleStop}>Stop</Button>
		{:else if sessionStatus === 'error'}
			<Badge variant="outline" class="text-atai-critical font-mono">Error</Badge>
			<Button variant="outline" size="sm" onclick={handleStart}>Retry</Button>
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
			disabled={!rows.length || sessionStatus !== 'ready'}
			onplay={handlePlay}
			onpause={handlePause}
			onreset={handleReset}
		/>
	</div>

	<main id="main-content" class="grid flex-1 grid-cols-[3fr_1fr] gap-4 p-4" style="min-height: calc(100vh - 140px);">
		<h1 class="sr-only">SWaT per-stage anomaly dashboard (Direct Query)</h1>

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

	<section class="border-border border-t" aria-label="Omega embedding visualization">
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground hover:bg-muted/40 flex w-full items-center gap-2 px-4 py-2 font-mono text-xs uppercase tracking-wider transition-colors"
			onclick={() => (embeddingPanelOpen = !embeddingPanelOpen)}
			aria-expanded={embeddingPanelOpen}
		>
			<span>Omega embeddings · 6-stage 2D projection</span>
			{#if embeddingPanelOpen}
				<ChevronDownIcon class="size-3.5" aria-hidden="true" />
			{:else}
				<ChevronUpIcon class="size-3.5" aria-hidden="true" />
			{/if}
		</button>
		{#if embeddingPanelOpen}
			<EmbeddingPanel
				stageIds={MONITORED_STAGE_IDS}
				stageMeta={STAGE_META}
				library={libraryCoords}
				trails={liveTrail}
			/>
		{/if}
	</section>

	{#if sessionStatus === 'error'}
		<div
			class="bg-destructive text-destructive-foreground fixed right-4 bottom-4 max-w-md rounded-md px-4 py-3 font-mono text-xs"
			role="alert"
		>
			Setup error: {setupError}
		</div>
	{/if}
</div>
