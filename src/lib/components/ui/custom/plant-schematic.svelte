<script>
	import { cn } from '$lib/utils.js';

	/**
	 * @typedef {Object} Props
	 * @property {Record<string,'normal'|'attack'|'pending'|'idle'>} stageStatuses
	 * @property {string} [class]
	 */

	/** @type {Props} */
	let { stageStatuses = {}, class: className, ...restProps } = $props();

	function stageClass(stageId) {
		const s = stageStatuses[stageId] ?? 'idle';
		if (s === 'attack') return 'text-atai-critical';
		if (s === 'normal') return 'text-atai-good';
		if (s === 'ready') return 'text-atai-good';
		if (s === 'pending' || s === 'warmup') return 'text-atai-warning';
		// standby, unmonitored, idle — all muted
		return 'text-muted-foreground';
	}

	// Stage x-centers are positioned at 1/12, 3/12, 5/12, 7/12, 9/12, 11/12 of the
	// 1200-unit viewBox so each stage sits above its corresponding card in the
	// 6-column grid below. Equipment widths are tuned to leave a consistent pipe
	// segment between stages.
</script>

<svg
	viewBox="0 0 1200 190"
	class={cn('w-full', className)}
	preserveAspectRatio="xMidYMid meet"
	role="img"
	aria-label="Six-stage water treatment plant process flow"
	fill="none"
	stroke-width="1.25"
	stroke-linecap="round"
	stroke-linejoin="round"
	{...restProps}
>
	<!-- Main process flow line from raw to treated -->
	<g class="text-muted-foreground" stroke="currentColor">
		<line x1="40" y1="80" x2="1160" y2="80" />
		<!-- Flow arrows between stages -->
		<path d="M 36 76 L 40 80 L 36 84" />
		<path d="M 236 76 L 240 80 L 236 84" />
		<path d="M 436 76 L 440 80 L 436 84" />
		<path d="M 636 76 L 640 80 L 636 84" />
		<path d="M 836 76 L 840 80 L 836 84" />
		<path d="M 1056 76 L 1060 80 L 1056 84" />
		<path d="M 1156 76 L 1160 80 L 1156 84" />
	</g>

	<!-- RAW inlet label -->
	<text
		x="8"
		y="72"
		class="text-muted-foreground"
		fill="currentColor"
		stroke="none"
		font-size="9"
		font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
	>
		RAW
	</text>

	<!-- TREATED outlet label -->
	<text
		x="1162"
		y="72"
		class="text-muted-foreground"
		fill="currentColor"
		stroke="none"
		font-size="9"
		font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
	>
		TREATED
	</text>

	<!-- P1: Raw intake tank (center x=100) -->
	<g class={stageClass('P1')} stroke="currentColor">
		<rect x="50" y="50" width="100" height="56" rx="2" />
		<path d="M 60 70 Q 70 66 80 70 T 100 70 T 120 70 T 140 70" stroke-width="0.7" />
		<line x1="75" y1="44" x2="75" y2="50" />
		<path d="M 72 47 L 75 44 L 78 47" />
		<circle cx="142" cy="55" r="3.5" fill="currentColor" stroke="none" />
	</g>

	<!-- P2: Chemical dosing (center x=300) -->
	<g class={stageClass('P2')} stroke="currentColor">
		<rect x="278" y="32" width="44" height="20" rx="1" />
		<circle cx="300" cy="42" r="1.3" fill="currentColor" stroke="none" />
		<line x1="300" y1="52" x2="300" y2="66" />
		<circle cx="300" cy="69" r="3" />
		<line x1="300" y1="72" x2="300" y2="80" />
		<circle cx="334" cy="36" r="3.5" fill="currentColor" stroke="none" />
	</g>

	<!-- P3: Ultrafiltration module (center x=500) -->
	<g class={stageClass('P3')} stroke="currentColor">
		<rect x="440" y="62" width="120" height="36" rx="18" />
		<line x1="458" y1="70" x2="542" y2="70" stroke-width="0.5" />
		<line x1="458" y1="76" x2="542" y2="76" stroke-width="0.5" />
		<line x1="458" y1="84" x2="542" y2="84" stroke-width="0.5" />
		<line x1="458" y1="90" x2="542" y2="90" stroke-width="0.5" />
		<circle cx="552" cy="55" r="3.5" fill="currentColor" stroke="none" />
	</g>

	<!-- P4: UV reactor (center x=700) -->
	<g class={stageClass('P4')} stroke="currentColor">
		<rect x="640" y="64" width="120" height="32" rx="3" />
		<line x1="656" y1="80" x2="744" y2="80" stroke-width="1.6" />
		<!-- UV rays -->
		<line x1="666" y1="68" x2="666" y2="65" />
		<line x1="684" y1="68" x2="684" y2="65" />
		<line x1="700" y1="68" x2="700" y2="65" />
		<line x1="716" y1="68" x2="716" y2="65" />
		<line x1="732" y1="68" x2="732" y2="65" />
		<line x1="666" y1="92" x2="666" y2="95" />
		<line x1="684" y1="92" x2="684" y2="95" />
		<line x1="700" y1="92" x2="700" y2="95" />
		<line x1="716" y1="92" x2="716" y2="95" />
		<line x1="732" y1="92" x2="732" y2="95" />
		<circle cx="752" cy="55" r="3.5" fill="currentColor" stroke="none" />
	</g>

	<!-- P5: RO array (center x=900) -->
	<g class={stageClass('P5')} stroke="currentColor">
		<rect x="840" y="50" width="120" height="12" rx="6" />
		<rect x="840" y="68" width="120" height="12" rx="6" />
		<rect x="840" y="86" width="120" height="12" rx="6" />
		<line x1="840" y1="50" x2="840" y2="98" />
		<line x1="960" y1="50" x2="960" y2="98" />
		<circle cx="965" cy="42" r="3.5" fill="currentColor" stroke="none" />
	</g>

	<!-- P6: Backwash sub-system (center x=1100) — sits below main flow, loops back to P3 -->
	<g class={stageClass('P6')} stroke="currentColor">
		<rect x="1050" y="108" width="100" height="20" rx="2" />
		<!-- Pump marker -->
		<circle cx="1100" cy="118" r="4" />
		<circle cx="1100" cy="118" r="1" fill="currentColor" stroke="none" />
		<circle cx="1143" cy="114" r="3" fill="currentColor" stroke="none" />
	</g>

	<!-- Backwash recycle path: P5 reject → P6 (short), then P6 → P3 (long return) -->
	<g class="text-muted-foreground" stroke="currentColor" stroke-dasharray="3 2">
		<!-- From P5 reject down and right into P6 top -->
		<path d="M 960 100 L 960 118 L 1050 118" />
		<!-- Arrow into P6 -->
		<path d="M 1046 114 L 1050 118 L 1046 122" fill="none" stroke-dasharray="none" />
		<!-- From P6 left side all the way back under main flow, up into P3 bottom -->
		<path d="M 1050 122 L 500 122 L 500 98" />
		<!-- Arrow into P3 -->
		<path d="M 496 102 L 500 98 L 504 102" fill="none" stroke-dasharray="none" />
	</g>

	<!-- Stage labels aligned to card centers: 100, 300, 500, 700, 900, 1100 -->
	{#each [{ id: 'P1', name: 'Raw intake', x: 100 }, { id: 'P2', name: 'Chemical dosing', x: 300 }, { id: 'P3', name: 'Ultrafiltration', x: 500 }, { id: 'P4', name: 'UV dechlorination', x: 700 }, { id: 'P5', name: 'Reverse osmosis', x: 900 }, { id: 'P6', name: 'Backwash', x: 1100 }] as s}
		<text
			x={s.x}
			y="148"
			class={stageClass(s.id)}
			fill="currentColor"
			stroke="none"
			text-anchor="middle"
			font-size="11"
			font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
		>
			{s.id}
		</text>
		<text
			x={s.x}
			y="162"
			class="text-muted-foreground"
			fill="currentColor"
			stroke="none"
			text-anchor="middle"
			font-size="9"
			font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
		>
			{s.name}
		</text>
		<!-- Pin tick: short vertical mark from label down to card top -->
		<line
			x1={s.x}
			y1="172"
			x2={s.x}
			y2="186"
			class="text-muted-foreground"
			stroke="currentColor"
			stroke-width="0.8"
			stroke-dasharray="1 2"
		/>
	{/each}
</svg>
