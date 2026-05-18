<script>
	import { cn } from '$lib/utils.js';
	import BackgroundCard from '$lib/components/ui/patterns/background-card/index.js';
	import Badge from '$lib/components/ui/primitives/badge/index.js';
	import StageSchematic from '$lib/components/ui/custom/stage-schematic.svelte';

	/**
	 * @typedef {Object} Props
	 * @property {string} stageId - e.g. "P1"
	 * @property {string} stageName - e.g. "Raw water intake"
	 * @property {string[]} columns - sensor column names for this stage
	 * @property {Record<string, string|number>|null} liveRow - latest row of sensor values
	 * @property {'normal'|'attack'|'pending'|'idle'} status
	 * @property {string[]} [recentLabels] - last N classifications for the streak strip
	 * @property {string} [class]
	 */

	/** @type {Props} */
	let {
		stageId,
		stageName,
		columns,
		liveRow = null,
		status = 'idle',
		recentLabels = [],
		class: className,
		...restProps
	} = $props();

	const STATUS_TOKEN = {
		normal: { dot: 'bg-atai-good', pill: 'text-atai-good', label: 'Normal' },
		attack: { dot: 'bg-atai-critical', pill: 'text-atai-critical', label: 'Attack' },
		warmup: { dot: 'bg-atai-warning', pill: 'text-atai-warning', label: 'Warming up' },
		pending: { dot: 'bg-atai-warning', pill: 'text-atai-warning', label: 'Classifying' },
		ready: { dot: 'bg-atai-good', pill: 'text-atai-good', label: 'Ready' },
		standby: { dot: 'bg-muted', pill: 'text-muted-foreground', label: 'Standby' },
		unmonitored: { dot: 'bg-muted', pill: 'text-muted-foreground', label: 'Not monitored' },
		idle: { dot: 'bg-atai-neutral', pill: 'text-muted-foreground', label: 'Idle' }
	};

	let tokens = $derived(STATUS_TOKEN[status] ?? STATUS_TOKEN.idle);

	function fmt(v) {
		if (v === undefined || v === null || v === '') return '—';
		const n = parseFloat(v);
		if (isNaN(n)) return String(v);
		if (Math.abs(n) >= 1000) return n.toFixed(0);
		if (Math.abs(n) >= 10) return n.toFixed(1);
		return n.toFixed(2);
	}
</script>

<BackgroundCard class={cn('flex flex-col gap-3 p-4', className)} {...restProps}>
	<header class="flex items-center justify-between">
		<div class="flex items-center gap-2">
			<span class="text-muted-foreground font-mono text-sm">{stageId}</span>
			<span class={cn('size-2 rounded-full', tokens.dot)} aria-hidden="true"></span>
		</div>
		<Badge variant="outline" class={cn('font-mono text-xs', tokens.pill)}>{tokens.label}</Badge>
	</header>

	<StageSchematic {stageId} class={cn(status === 'attack' && 'text-atai-critical/70')} />

	<p class="font-mono text-sm leading-tight">{stageName}</p>

	<dl class="flex flex-col gap-1 text-xs">
		{#each columns as col}
			<div class="flex items-baseline justify-between gap-2">
				<dt class="text-muted-foreground font-mono">{col}</dt>
				<dd class="font-mono">{fmt(liveRow?.[col])}</dd>
			</div>
		{/each}
	</dl>

	{#if recentLabels.length > 0}
		<div class="mt-auto flex items-center gap-1" aria-label="Recent classifications">
			{#each recentLabels.slice(-10) as label}
				<span
					class={cn(
						'size-1.5 rounded-full',
						label === 'ATTACK'
							? 'bg-atai-critical'
							: label === 'NORMAL'
								? 'bg-atai-good'
								: 'bg-atai-neutral'
					)}
					aria-hidden="true"
				></span>
			{/each}
		</div>
	{/if}
</BackgroundCard>
