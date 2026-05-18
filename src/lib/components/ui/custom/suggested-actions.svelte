<script>
	import { cn } from '$lib/utils.js';
	import BackgroundCard from '$lib/components/ui/patterns/background-card/index.js';
	import Badge from '$lib/components/ui/primitives/badge/index.js';
	import * as ScrollArea from '$lib/components/ui/primitives/scroll-area/index.js';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import CircleDotIcon from '@lucide/svelte/icons/circle-dot';

	/**
	 * @typedef {Object} Suggestion
	 * @property {string} origin
	 * @property {string} target
	 * @property {'upstream'|'local'|'downstream'} direction
	 * @property {string} text
	 */

	/**
	 * @typedef {Object} Props
	 * @property {Record<string,'normal'|'attack'|'pending'|'idle'|'standby'>} stageStatuses
	 * @property {Record<string,string>} [stageNames]
	 * @property {Suggestion[]|null} [aiSuggestions] - Newton-generated; null while loading or on error
	 * @property {'newton'|'newton-cached'|'loading'|'error'} [source]
	 * @property {string} [class]
	 */

	/** @type {Props} */
	let {
		stageStatuses,
		stageNames = {},
		aiSuggestions = null,
		source = 'loading',
		class: className,
		...restProps
	} = $props();

	const STAGE_ORDER = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

	let anomalous = $derived(STAGE_ORDER.filter((s) => stageStatuses[s] === 'attack'));
	// Filter stale cards for stages that have since recovered. Prior Newton response
	// persists across signature changes to avoid flicker during transitions, so we
	// gate by the current anomalous set to hide obsolete guidance.
	let suggestions = $derived((aiSuggestions ?? []).filter((s) => anomalous.includes(s.origin)));

	const SOURCE_LABEL = {
		newton: 'Newton reasoning',
		'newton-cached': 'Newton reasoning (cached)',
		loading: 'Newton analysing…',
		error: 'Newton unavailable'
	};
	const SOURCE_TONE = {
		newton: 'text-atai-good',
		'newton-cached': 'text-atai-good',
		loading: 'text-atai-warning',
		error: 'text-atai-critical'
	};

	const ICON_BY_DIR = {
		upstream: ArrowUpIcon,
		downstream: ArrowDownIcon,
		local: CircleDotIcon
	};
</script>

<BackgroundCard class={cn('flex h-full flex-col gap-3 p-4', className)} {...restProps}>
	<header class="flex flex-col gap-1">
		<div class="flex items-baseline justify-between">
			<h2 class="font-mono text-sm">Suggested actions</h2>
			<span class="text-muted-foreground font-mono text-xs">
				{suggestions.length} active · {anomalous.length} stage{anomalous.length === 1 ? '' : 's'}
			</span>
		</div>
		<span class={cn('font-mono text-[10px] uppercase tracking-wider', SOURCE_TONE[source])}>
			{SOURCE_LABEL[source]}
		</span>
	</header>

	{#if suggestions.length === 0}
		<p class="text-muted-foreground flex-1 text-xs">
			{#if source === 'error'}
				Newton query failed. Actions will resume once the next anomaly set triggers a retry.
			{:else if source === 'loading' || anomalous.length > 0}
				Newton is analysing current plant state. Actions will appear shortly.
			{:else}
				No anomalies detected. Operator guidance will appear here when a stage flags attack-class.
			{/if}
		</p>
	{:else}
		<ScrollArea.Root class="min-h-0 flex-1">
			<ul role="list" class="flex flex-col gap-2 pr-2">
				{#each suggestions as s}
					{@const Icon = ICON_BY_DIR[s.direction]}
					<li
						role="listitem"
						class="border-border flex items-start gap-3 rounded-md border p-3"
					>
						<Icon
							class={cn(
								'mt-0.5 size-4 shrink-0',
								s.direction === 'local' ? 'text-atai-warning' : 'text-muted-foreground'
							)}
							aria-hidden="true"
						/>
						<div class="flex min-w-0 flex-1 flex-col gap-1">
							<div class="flex items-center gap-2">
								<Badge variant="outline" class="text-atai-critical font-mono text-[10px]">
									{s.origin} anomaly
								</Badge>
								<span class="text-muted-foreground font-mono text-[10px] uppercase">
									{s.direction}
								</span>
								{#if s.direction !== 'local'}
									<Badge variant="outline" class="font-mono text-[10px]">
										→ {s.target}
									</Badge>
								{/if}
							</div>
							<p class="text-sm">{s.text}</p>
						</div>
					</li>
				{/each}
			</ul>
		</ScrollArea.Root>
	{/if}
</BackgroundCard>
