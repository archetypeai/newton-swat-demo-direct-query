<script>
	import { cn } from '$lib/utils.js';
	import Button from '$lib/components/ui/primitives/button/index.js';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import ResetIcon from '@lucide/svelte/icons/rotate-ccw';

	/**
	 * @typedef {Object} Props
	 * @property {boolean} playing
	 * @property {number} current
	 * @property {number} total
	 * @property {number} [speed]
	 * @property {boolean} [disabled]
	 * @property {() => void} onplay
	 * @property {() => void} onpause
	 * @property {() => void} onreset
	 * @property {string} [class]
	 */

	/** @type {Props} */
	let {
		playing,
		current,
		total,
		speed = 10,
		disabled = false,
		onplay,
		onpause,
		onreset,
		class: className,
		...restProps
	} = $props();

	let progressPct = $derived(total > 0 ? ((current / total) * 100).toFixed(1) : '0.0');
</script>

<div class={cn('flex items-center gap-3', className)} {...restProps}>
	{#if playing}
		<Button variant="outline" size="sm" onclick={onpause} {disabled} aria-label="Pause">
			<PauseIcon aria-hidden="true" />
			Pause
		</Button>
	{:else}
		<Button variant="default" size="sm" onclick={onplay} {disabled} aria-label="Play">
			<PlayIcon aria-hidden="true" />
			Play
		</Button>
	{/if}

	<Button variant="outline" size="icon-sm" onclick={onreset} {disabled} aria-label="Reset">
		<ResetIcon aria-hidden="true" />
	</Button>

	<div class="text-muted-foreground font-mono text-xs">
		<span>{current.toLocaleString()}</span>
		<span class="mx-1">/</span>
		<span>{total.toLocaleString()}</span>
		<span class="ml-2">({progressPct}%)</span>
	</div>

	<div class="text-muted-foreground ml-auto font-mono text-xs">{speed}× replay</div>
</div>
