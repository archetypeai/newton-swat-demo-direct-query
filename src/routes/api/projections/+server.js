import { json } from '@sveltejs/kit';
import { getLibraryProjections } from '$lib/server/projections.js';

// Returns the static library 2D coords (PCA + UMAP) for all stages.
// Client fetches this once on mount to render the static background scatters
// in the embedding-viz panel. Live cursor coords come from /api/classify.
export async function GET() {
	try {
		const stages = await getLibraryProjections();
		return json({ stages });
	} catch (err) {
		return json({ error: err.message }, { status: 500 });
	}
}
