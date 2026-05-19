<script>
	import { onMount, onDestroy } from 'svelte';
	import { cn } from '$lib/utils.js';
	import Button from '$lib/components/ui/primitives/button/index.js';

	/**
	 * @typedef {Object} Coord
	 * @property {number} x
	 * @property {number} y
	 * @property {string} [label]
	 *
	 * @typedef {Object} StageLib
	 * @property {string[]} columns
	 * @property {{ pca: Coord[], umap: Coord[] }} library
	 *
	 * @typedef {Object} TrailPoint
	 * @property {[number, number]} pca
	 * @property {[number, number]} umap
	 * @property {string} label
	 * @property {number} counter
	 *
	 * @typedef {Object} Props
	 * @property {string[]} stageIds
	 * @property {Record<string,string>} stageMeta
	 * @property {Record<string, StageLib>|null} library
	 * @property {Record<string, TrailPoint[]>} trails
	 */

	/** @type {Props} */
	let { stageIds, stageMeta, library, trails } = $props();

	let mode = $state('pca'); // 'pca' | 'umap'
	let containers = $state({}); // stageId → DOM node
	let Plotly = null;
	let plotsInited = $state(false);

	// Lazy-load plotly.js client-side only.
	onMount(async () => {
		const mod = await import('plotly.js-dist-min');
		Plotly = mod.default || mod;
		plotsInited = true;
	});

	onDestroy(() => {
		if (!Plotly) return;
		for (const el of Object.values(containers)) {
			try {
				Plotly.purge(el);
			} catch {}
		}
	});

	const NORMAL_COLOR = 'rgba(80, 180, 110, 0.85)'; // matches atai-good
	const ATTACK_COLOR = 'rgba(245, 87, 87, 0.9)'; // matches atai-critical
	const INFERENCE_NORMAL = 'rgba(80, 180, 110, 0.18)';
	const INFERENCE_ATTACK = 'rgba(245, 87, 87, 0.22)';
	const CURSOR_FILL_NORMAL = 'rgba(80, 180, 110, 1)';
	const CURSOR_FILL_ATTACK = 'rgba(245, 87, 87, 1)';

	function inferenceTraces(stageId) {
		const sample = library?.[stageId]?.inferenceSample?.[mode];
		if (!sample || !sample.length) return [];
		const normal = { x: [], y: [] };
		const attack = { x: [], y: [] };
		for (const c of sample) {
			if (c.x == null || c.y == null) continue;
			(c.label === 'ATTACK' ? attack : normal).x.push(c.x);
			(c.label === 'ATTACK' ? attack : normal).y.push(c.y);
		}
		return [
			{
				x: normal.x,
				y: normal.y,
				mode: 'markers',
				type: 'scattergl',
				name: 'NORMAL (inference)',
				marker: { size: 3, color: INFERENCE_NORMAL, line: { width: 0 } },
				hoverinfo: 'name',
				showlegend: false
			},
			{
				x: attack.x,
				y: attack.y,
				mode: 'markers',
				type: 'scattergl',
				name: 'ATTACK (inference)',
				marker: { size: 3, color: INFERENCE_ATTACK, line: { width: 0 } },
				hoverinfo: 'name',
				showlegend: false
			}
		];
	}

	function libraryTraces(stageId) {
		if (!library?.[stageId]?.library) return [];
		const coords = library[stageId].library[mode];
		const normal = { x: [], y: [] };
		const attack = { x: [], y: [] };
		for (const c of coords) {
			(c.label === 'ATTACK' ? attack : normal).x.push(c.x);
			(c.label === 'ATTACK' ? attack : normal).y.push(c.y);
		}
		return [
			{
				x: normal.x,
				y: normal.y,
				mode: 'markers',
				type: 'scattergl',
				name: 'NORMAL (lib)',
				marker: { size: 7, color: NORMAL_COLOR, line: { width: 1, color: 'rgba(255,255,255,0.4)' } },
				hoverinfo: 'name',
				showlegend: false
			},
			{
				x: attack.x,
				y: attack.y,
				mode: 'markers',
				type: 'scattergl',
				name: 'ATTACK (lib)',
				marker: { size: 7, color: ATTACK_COLOR, line: { width: 1, color: 'rgba(255,255,255,0.4)' } },
				hoverinfo: 'name',
				showlegend: false
			}
		];
	}

	function trailTraces(stageId) {
		const trail = trails?.[stageId] ?? [];
		if (trail.length === 0) return [{ x: [], y: [], type: 'scattergl', mode: 'lines' }];
		const xs = trail.map((p) => p[mode][0]);
		const ys = trail.map((p) => p[mode][1]);
		const head = trail[trail.length - 1];
		const headColor = head.label === 'ATTACK' ? CURSOR_FILL_ATTACK : CURSOR_FILL_NORMAL;
		return [
			{
				x: xs,
				y: ys,
				type: 'scattergl',
				mode: 'lines+markers',
				line: { color: 'rgba(160, 160, 160, 0.5)', width: 1 },
				marker: { size: 4, color: 'rgba(160, 160, 160, 0.5)', line: { width: 0 } },
				hoverinfo: 'skip',
				showlegend: false
			},
			{
				x: [xs[xs.length - 1]],
				y: [ys[ys.length - 1]],
				type: 'scatter',
				mode: 'markers',
				marker: {
					size: 11,
					color: headColor,
					line: { width: 2, color: 'rgba(255,255,255,0.9)' }
				},
				hoverinfo: 'name',
				name: head.label,
				showlegend: false
			}
		];
	}

	function layoutFor(stageId) {
		const acc = library?.[stageId]?.looAccuracy;
		const accStr = acc == null ? '' : ` · LOO ${Math.round(acc * 100)}%`;
		const accColor = acc == null
			? 'rgba(220,220,220,0.7)'
			: acc >= 0.8
				? 'rgba(80, 180, 110, 0.95)'
				: acc >= 0.65
					? 'rgba(220, 180, 60, 0.95)'
					: 'rgba(245, 87, 87, 0.95)';
		return {
			margin: { l: 24, r: 8, t: 22, b: 22 },
			showlegend: false,
			xaxis: { showgrid: true, gridcolor: 'rgba(255,255,255,0.05)', zeroline: false, ticks: '', showticklabels: false },
			yaxis: { showgrid: true, gridcolor: 'rgba(255,255,255,0.05)', zeroline: false, ticks: '', showticklabels: false },
			paper_bgcolor: 'rgba(0,0,0,0)',
			plot_bgcolor: 'rgba(0,0,0,0)',
			font: { color: 'rgba(220,220,220,0.7)', family: 'ui-monospace, SFMono-Regular, monospace', size: 10 },
			title: { text: `${stageId} · ${stageMeta?.[stageId] ?? ''}`, font: { size: 11 }, x: 0.02, xanchor: 'left', y: 0.97 },
			annotations: acc == null
				? []
				: [
						{
							text: `LOO ${Math.round(acc * 100)}%`,
							xref: 'paper',
							yref: 'paper',
							x: 0.98,
							y: 0.97,
							xanchor: 'right',
							yanchor: 'top',
							showarrow: false,
							font: { size: 10, color: accColor, family: 'ui-monospace, SFMono-Regular, monospace' }
						}
					]
		};
	}

	function refreshAll() {
		if (!Plotly) return;
		for (const stageId of stageIds) {
			const el = containers[stageId];
			if (!el) continue;
			// Order matters: inference sample (bottom) → library dots (mid) → live cursor (top).
			const data = [...inferenceTraces(stageId), ...libraryTraces(stageId), ...trailTraces(stageId)];
			try {
				Plotly.react(el, data, layoutFor(stageId), { displayModeBar: false, responsive: true });
			} catch (err) {
				console.warn('[embedding-panel] plot failed for', stageId, err);
			}
		}
	}

	// Re-render whenever inputs change. Plotly.react is diff-aware so this is cheap.
	$effect(() => {
		// Touch reactive deps to keep effect tracking accurate.
		mode;
		library;
		trails;
		plotsInited;
		if (plotsInited) refreshAll();
	});
</script>

<div class="bg-muted/20 flex flex-col gap-2 px-4 py-3">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="flex flex-col gap-1">
			<div class="text-foreground font-mono text-xs">
				{#if mode === 'pca'}
					PCA-2 · linear projection · live cursor enabled
				{:else}
					UMAP-2 · non-linear · 188 library points per stage
				{/if}
			</div>
			<div class="text-muted-foreground text-xs leading-relaxed">
				Each scatter is one stage's Omega embedding space reduced to 2D. Three layers:
				<span class="text-foreground">faint dots</span> are inference-timeline windows
				colored by their ground-truth label (where actual playback windows land);
				<span class="text-foreground">bright ringed dots</span> are the 188 n-shot library
				examples KNN votes against (<span class="text-atai-good">green=NORMAL</span>,
				<span class="text-atai-critical">red=ATTACK</span>);
				the <span class="text-foreground">large ringed circle</span> with a gray trail is
				the current playback window. LOO (top-right of each scatter) is the library's
				leave-one-out KNN accuracy in the full embedding space — it tells you whether the
				classifier actually works for that stage, independent of how the 2D picture looks.
				<span class="text-atai-good">≥80% green</span>,
				<span class="text-atai-warning">65-80% amber</span>,
				<span class="text-atai-critical">&lt;65% red</span>. If the inference layer is empty,
				run <span class="font-mono">node scripts/build-inference-sample.js</span>.
			</div>
		</div>
		<div class="flex gap-1 shrink-0">
			<Button
				variant={mode === 'pca' ? 'default' : 'outline'}
				size="sm"
				onclick={() => (mode = 'pca')}
			>
				PCA
			</Button>
			<Button
				variant={mode === 'umap' ? 'default' : 'outline'}
				size="sm"
				onclick={() => (mode = 'umap')}
			>
				UMAP
			</Button>
		</div>
	</div>

	<div class="grid grid-cols-6 gap-2">
		{#each stageIds as stageId (stageId)}
			<div
				class="border-border bg-background/40 rounded-md border"
				style="height: 240px;"
				bind:this={containers[stageId]}
			></div>
		{/each}
	</div>
</div>
