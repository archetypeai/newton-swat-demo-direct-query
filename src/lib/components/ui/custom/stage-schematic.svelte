<script>
	import { cn } from '$lib/utils.js';

	/**
	 * @typedef {Object} Props
	 * @property {'P1'|'P2'|'P3'|'P4'|'P5'|'P6'} stageId
	 * @property {string} [class]
	 */

	/** @type {Props} */
	let { stageId, class: className, ...restProps } = $props();
</script>

<svg
	viewBox="0 0 120 40"
	class={cn('text-muted-foreground h-10 w-full', className)}
	preserveAspectRatio="xMidYMid meet"
	role="img"
	aria-label="{stageId} process schematic"
	fill="none"
	stroke="currentColor"
	stroke-width="1.25"
	stroke-linecap="round"
	stroke-linejoin="round"
	{...restProps}
>
	{#if stageId === 'P1'}
		<!-- Raw water intake: tank with water level + outflow pipe -->
		<rect x="18" y="8" width="36" height="26" rx="1" />
		<path d="M 22 18 Q 27 15 32 18 T 42 18 T 50 18" stroke-width="0.75" />
		<!-- Inflow from top -->
		<path d="M 36 2 L 36 8" />
		<path d="M 33 5 L 36 2 L 39 5" />
		<!-- Outflow pipe -->
		<line x1="54" y1="26" x2="110" y2="26" />
		<!-- Flow arrow -->
		<path d="M 106 22 L 110 26 L 106 30" />
	{:else if stageId === 'P2'}
		<!-- Chemical dosing: main pipe + small dosing tank + injection -->
		<line x1="10" y1="30" x2="110" y2="30" />
		<path d="M 106 26 L 110 30 L 106 34" />
		<!-- Chemical tank (top) -->
		<rect x="52" y="4" width="18" height="12" rx="1" />
		<!-- Connecting line -->
		<line x1="61" y1="16" x2="61" y2="22" />
		<!-- Dosing pump -->
		<circle cx="61" cy="24" r="2.5" />
		<!-- Injection into main pipe -->
		<line x1="61" y1="26.5" x2="61" y2="30" />
		<!-- Chemical drop inside tank -->
		<circle cx="61" cy="10" r="1" fill="currentColor" />
	{:else if stageId === 'P3'}
		<!-- Ultrafiltration: rounded module with hollow fibers inside -->
		<line x1="8" y1="20" x2="22" y2="20" />
		<rect x="22" y="10" width="76" height="20" rx="10" />
		<!-- Hollow fibers -->
		<line x1="30" y1="14" x2="90" y2="14" stroke-width="0.5" />
		<line x1="30" y1="18" x2="90" y2="18" stroke-width="0.5" />
		<line x1="30" y1="22" x2="90" y2="22" stroke-width="0.5" />
		<line x1="30" y1="26" x2="90" y2="26" stroke-width="0.5" />
		<line x1="98" y1="20" x2="112" y2="20" />
		<path d="M 108 16 L 112 20 L 108 24" />
	{:else if stageId === 'P4'}
		<!-- UV dechlorination: reactor cylinder with UV lamp centerline + radiating ticks -->
		<line x1="8" y1="20" x2="22" y2="20" />
		<rect x="22" y="10" width="76" height="20" rx="3" />
		<!-- UV lamp (thicker line) -->
		<line x1="30" y1="20" x2="90" y2="20" stroke-width="1.75" />
		<!-- UV rays (ticks, top and bottom) -->
		<line x1="40" y1="15" x2="40" y2="13" />
		<line x1="50" y1="15" x2="50" y2="13" />
		<line x1="60" y1="15" x2="60" y2="13" />
		<line x1="70" y1="15" x2="70" y2="13" />
		<line x1="80" y1="15" x2="80" y2="13" />
		<line x1="40" y1="25" x2="40" y2="27" />
		<line x1="50" y1="25" x2="50" y2="27" />
		<line x1="60" y1="25" x2="60" y2="27" />
		<line x1="70" y1="25" x2="70" y2="27" />
		<line x1="80" y1="25" x2="80" y2="27" />
		<line x1="98" y1="20" x2="112" y2="20" />
		<path d="M 108 16 L 112 20 L 108 24" />
	{:else if stageId === 'P5'}
		<!-- Reverse osmosis: three stacked pressure vessels, permeate exits right -->
		<line x1="8" y1="20" x2="18" y2="20" />
		<!-- Feed manifold -->
		<line x1="18" y1="6" x2="18" y2="34" />
		<!-- Three vessels -->
		<rect x="18" y="3" width="82" height="7" rx="3.5" />
		<rect x="18" y="16" width="82" height="8" rx="4" />
		<rect x="18" y="30" width="82" height="7" rx="3.5" />
		<!-- Permeate manifold -->
		<line x1="100" y1="6" x2="100" y2="34" />
		<!-- Permeate out -->
		<line x1="100" y1="20" x2="112" y2="20" stroke-width="0.9" />
		<path d="M 108 17 L 112 20 L 108 23" stroke-width="0.9" />
	{:else if stageId === 'P6'}
		<!-- Backwash: reverse-flow loop with filter body -->
		<!-- Filter block -->
		<rect x="44" y="22" width="32" height="14" rx="2" />
		<line x1="52" y1="26" x2="68" y2="26" stroke-width="0.5" />
		<line x1="52" y1="30" x2="68" y2="30" stroke-width="0.5" />
		<line x1="52" y1="34" x2="68" y2="34" stroke-width="0.5" />
		<!-- Return-flow pipe (top) going right-to-left back to filter -->
		<path d="M 96 29 L 96 10 Q 96 6 92 6 L 28 6 Q 24 6 24 10 L 24 29" />
		<!-- Reverse flow arrow -->
		<path d="M 28 3 L 24 6 L 28 9" />
		<!-- Connection to filter -->
		<line x1="24" y1="29" x2="44" y2="29" />
		<line x1="76" y1="29" x2="96" y2="29" />
	{/if}
</svg>
