/**
 * v0.34 W0c — within-file two-pass symbol resolver.
 *
 * The edge-extractor (edge-extractor.ts) emits BARE callee tokens during
 * sync (`f`, `m`, `render`, etc.). Multi-class codebases have many same-
 * named methods; pre-v0.34 the call graph aliased every same-named symbol
 * across classes because there was no qualified-name resolution.
 *
 * This module is the second pass: for each unresolved edge in
 * code_edges_symbol whose owning chunk shares a file with one or more
 * candidate `symbol_name_qualified` matches, we either:
 *
 *   - Mark it resolved (edge_metadata.resolved_chunk_id = <id>) when
 *     exactly ONE chunk in the same page has a matching qualified name.
 *   - Mark it ambiguous (edge_metadata.ambiguous = true + candidates list)
 *     when 2+ chunks match — the caller still got information they didn't
 *     have before (we know it could be any of {X, Y, Z}, not "this is
 *     definitely `render`").
 *   - Leave it untouched if zero chunks match (call is to something
 *     defined in another file — caller's resolver expands via two-pass).
 *
 * Idempotency: every chunk we walk gets `content_chunks.edges_backfilled_at
 * = NOW()` after its edges are processed. Resume picks up rows where the
 * watermark is NULL or older than EDGE_EXTRACTOR_VERSION_TS — when the
 * extractor's shape changes, bump the constant and the next cycle re-runs.
 *
 * Batched: BATCH_SIZE chunks per transaction; one batch is the atomic unit.
 * Crashes lose at most one batch.
 *
 * Per D2 from eng review: a cycle phase (resolve_symbol_edges_incremental)
 * runs this on the autopilot's quick-cycle path so sync stays fast AND
 * agents see resolved edges within ~60s of writes.
 *
 *                       ┌─────────────────────────────┐
 *                       │ chunks where                │
 *  resolver enqueues ──►│  edges_backfilled_at IS NULL│
 *                       │  OR < EDGE_EXTRACTOR_TS     │
 *                       └─────────────────────────────┘
 *                                  │
 *                                  ▼
 *                       ┌─────────────────────────────┐
 *                       │ BATCH (200 chunks)          │
 *                       │ — for each: load edges,     │
 *                       │   resolve via same-page     │
 *                       │   symbol_name_qualified     │
 *                       │ — write edge_metadata       │
 *                       │ — set edges_backfilled_at   │
 *                       └─────────────────────────────┘
 *                                  │
 *                                  ▼
 *                            COMMIT batch
 *                                  │
 *                                  ▼
 *                          repeat or return
 */

import type { BrainEngine } from '../engine.ts';
import { supportsQualifiedNames } from './qualified-names.ts';
import { isLanguageBuiltin } from './symbol-builtins.ts';

/**
 * Bump this ISO timestamp whenever the extractor or resolver shape
 * changes. Rows resolved by an OLDER version are re-walked on the next
 * resolver pass.
 *
 * Format: ISO-8601 UTC. Comparable via `<` in SQL.
 *
 * 2026-05-14T00:00:00Z — v0.34 W1: receiver-type resolution emits
 * qualified names (Class::method, module::method) for the 3 MUST-resolve
 * patterns in JS/TS/TSX + Python.
 * 2026-05-14T01:00:00Z — v0.34 W2: edge-extractor now emits `imports`
 * and `references` edges alongside calls. JS/TS/TSX + Python get imports;
 * TS only gets references.
 * 2026-07-10T00:00:00Z — resolver shape change: unmatched edges are classified
 * into reason buckets. Without a bump every existing brain's watermark already
 * sits past the old stamp, so the resolver would walk zero chunks, the buckets
 * would report all-zero forever, and the brains that most need the diagnosis
 * (metadata-wiped ones) would look clean. The re-walk is DB-only — no LLM, no
 * embeddings — and resumes across cycles via the same watermark.
 */
export const EDGE_EXTRACTOR_VERSION_TS = '2026-07-10T00:00:00Z';

export const BATCH_SIZE = 200;

/**
 * Why an edge stayed unmatched. Ordered most-actionable → least: the
 * classifier walks this ladder top-down and stops at the first hit, so a
 * bucket only ever contains edges the buckets above it could not explain.
 *
 * Every reason is decided from data already on hand (chunk metadata, the
 * per-page candidate index, one batched cross-file probe) — no LLM, no
 * heuristics that could silently reclassify a real resolution failure as
 * "expected".
 */
export type UnmatchedReason =
  /** The calling chunk names a language that has no qualified-name convention,
   *  so nothing in it can ever enter the candidate index. Fix = teach
   *  qualified-names.ts. */
  | 'unsupported_language'
  /** The calling chunk has no `language` at all, or its PAGE has zero chunks
   *  carrying `symbol_name_qualified`. Either way the index for that page is
   *  empty and no match was ever possible. Fix = re-chunk the file;
   *  historically this was a metadata wipe, see chunk-metadata-sql.ts. */
  | 'missing_symbol_metadata'
  /** Same page holds a chunk whose qualified name ENDS in the target token
   *  (index has `Class.render`, the edge points at bare `render`). Fix =
   *  emit receiver-qualified targets in edge-extractor.ts. */
  | 'bare_token_vs_qualified'
  /** A live page elsewhere in this source declares that symbol — under exactly
   *  this qualified name, or under this bare name. The definition is real and
   *  only the same-file scope kept us from it. Resolvable by widening the
   *  resolver, which is deliberately out of scope for this pass. */
  | 'cross_file_same_source'
  /** Target is a language builtin, global, or stdlib member — an edge leaving
   *  the indexed corpus. Not a failure. */
  | 'builtin_or_external'
  /** Nothing named that exists anywhere in the source. Third-party dependency,
   *  dynamic dispatch, or dead code. The honest "we don't know" bucket. */
  | 'no_candidate_anywhere';

export const UNMATCHED_REASONS: readonly UnmatchedReason[] = [
  'unsupported_language',
  'missing_symbol_metadata',
  'bare_token_vs_qualified',
  'cross_file_same_source',
  'builtin_or_external',
  'no_candidate_anywhere',
] as const;

export type UnmatchedBuckets = Record<UnmatchedReason, number>;

export function emptyUnmatchedBuckets(): UnmatchedBuckets {
  return {
    unsupported_language: 0,
    missing_symbol_metadata: 0,
    bare_token_vs_qualified: 0,
    cross_file_same_source: 0,
    builtin_or_external: 0,
    no_candidate_anywhere: 0,
  };
}

export interface ResolverStats {
  chunks_walked: number;
  edges_examined: number;
  edges_resolved: number;
  edges_ambiguous: number;
  edges_unmatched: number;
  /** Per-reason breakdown of `edges_unmatched`. Sums to `edges_unmatched`. */
  unmatched_buckets: UnmatchedBuckets;
  batches: number;
  ms: number;
}

/**
 * Source-wide, walk-independent view of how much of the call graph actually
 * resolved — the metric `edges_resolved` cannot give you, because a tick that
 * walks zero pending chunks reports zero resolutions on a fully-resolved brain.
 *
 * Denominator is pages with >= 1 outbound symbol edge (a page with no calls
 * cannot be covered or uncovered). `code-graph-readiness.ts` answers "has the
 * sweep finished?"; this answers "did the sweep find anything?".
 */
export interface SymbolEdgeCoverage {
  pages_with_resolved_edges: number;
  pages_with_edges: number;
  /** pages_with_resolved_edges / pages_with_edges, 0 when the denominator is 0. */
  page_coverage: number;
}

export interface ResolverOpts {
  /** Required: scope resolution to one source. v0.34 doesn't do cross-source. */
  sourceId: string;
  /** Cap on chunks walked per call. Default: BATCH_SIZE * 10 = 2000 per cycle tick. */
  maxChunks?: number;
  /** Optional progress callback for long backfills. */
  onProgress?: (stats: ResolverStats) => void;
}

interface UnresolvedEdgeRow {
  id: number;
  from_chunk_id: number;
  to_symbol_qualified: string;
  edge_type: string;
  edge_metadata: Record<string, unknown> | null;
}

interface ChunkCandidate {
  id: number;
  page_id: number;
}

interface ChunkRow {
  id: number;
  page_id: number;
  language: string | null;
}

/** Last segment of a qualified name: `Admin::UsersController#render` → `render`. */
function qualifiedLeaf(qualified: string): string {
  return qualified.split(/::|#|\./).pop() ?? qualified;
}

/**
 * Resolve unresolved edges for chunks whose `edges_backfilled_at` is
 * stale or null. Returns stats; updates DB in BATCH_SIZE-chunk transactions.
 */
export async function resolveSymbolEdgesIncremental(
  engine: BrainEngine,
  opts: ResolverOpts,
): Promise<ResolverStats> {
  const start = Date.now();
  const maxChunks = opts.maxChunks ?? BATCH_SIZE * 10;
  const stats: ResolverStats = {
    chunks_walked: 0,
    edges_examined: 0,
    edges_resolved: 0,
    edges_ambiguous: 0,
    edges_unmatched: 0,
    unmatched_buckets: emptyUnmatchedBuckets(),
    batches: 0,
    ms: 0,
  };

  let processed = 0;
  while (processed < maxChunks) {
    const remaining = maxChunks - processed;
    const batchSize = Math.min(BATCH_SIZE, remaining);

    // Find chunks that need walking: edges_backfilled_at is NULL OR older
    // than the extractor version timestamp. Scoped to source.
    // `language` rides along so unmatched edges can be bucketed by the
    // calling chunk's language without a second lookup.
    const chunks = await engine.executeRaw<ChunkRow>(
      `SELECT cc.id, cc.page_id, cc.language
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.source_id = $1
          AND (cc.edges_backfilled_at IS NULL
               OR cc.edges_backfilled_at < $2::timestamptz)
        ORDER BY cc.id
        LIMIT $3`,
      [opts.sourceId, EDGE_EXTRACTOR_VERSION_TS, batchSize],
    );

    if (chunks.length === 0) break;

    await processChunkBatch(engine, opts.sourceId, chunks, stats);
    stats.batches += 1;
    processed += chunks.length;

    if (opts.onProgress) {
      stats.ms = Date.now() - start;
      opts.onProgress(stats);
    }
  }

  stats.ms = Date.now() - start;
  return stats;
}

async function processChunkBatch(
  engine: BrainEngine,
  sourceId: string,
  chunks: ChunkRow[],
  stats: ResolverStats,
): Promise<void> {
  // Load all unresolved edges for the batch in one query.
  const chunkIds = chunks.map((c) => c.id);
  const edges = await engine.executeRaw<UnresolvedEdgeRow>(
    `SELECT id, from_chunk_id, to_symbol_qualified, edge_type, edge_metadata
       FROM code_edges_symbol
      WHERE from_chunk_id = ANY($1::int[])
        AND source_id = $2`,
    [chunkIds, sourceId],
  );

  // Group edges by from_chunk_id so we know which chunks have which edges.
  const edgesByChunkId = new Map<number, UnresolvedEdgeRow[]>();
  for (const e of edges) {
    const arr = edgesByChunkId.get(e.from_chunk_id) ?? [];
    arr.push(e);
    edgesByChunkId.set(e.from_chunk_id, arr);
  }

  // Build the set of page_ids we need to look up symbol candidates in.
  const pageByChunkId = new Map(chunks.map((c) => [c.id, c.page_id]));
  const pagesToProbe = Array.from(new Set(chunks.map((c) => c.page_id)));

  // Distinct (page_id, to_symbol_qualified) lookups to do.
  const lookups = new Set<string>();
  for (const e of edges) {
    const pageId = pageByChunkId.get(e.from_chunk_id);
    if (pageId === undefined) continue;
    lookups.add(`${pageId} ${e.to_symbol_qualified}`);
  }

  // One-shot per-page candidate map. We pre-load all qualified symbol names
  // for every page in the batch, then resolve in-memory. `leavesByPage` is the
  // same data keyed by trailing segment, so an unmatched bare token can be told
  // apart from a token nothing in the file declares.
  const candidatesByKey = new Map<string, ChunkCandidate[]>();
  const leavesByPage = new Map<number, Set<string>>();
  const qualCountByPage = new Map<number, number>();
  if (pagesToProbe.length > 0) {
    const rows = await engine.executeRaw<{ id: number; page_id: number; symbol_name_qualified: string }>(
      `SELECT id, page_id, symbol_name_qualified
         FROM content_chunks
        WHERE page_id = ANY($1::int[])
          AND symbol_name_qualified IS NOT NULL`,
      [pagesToProbe],
    );
    for (const r of rows) {
      const key = `${r.page_id} ${r.symbol_name_qualified}`;
      const list = candidatesByKey.get(key) ?? [];
      list.push({ id: r.id, page_id: r.page_id });
      candidatesByKey.set(key, list);

      const leaves = leavesByPage.get(r.page_id) ?? new Set<string>();
      leaves.add(qualifiedLeaf(r.symbol_name_qualified));
      leavesByPage.set(r.page_id, leaves);

      qualCountByPage.set(r.page_id, (qualCountByPage.get(r.page_id) ?? 0) + 1);
    }
  }

  // Resolve each edge.
  const toResolve: Array<{ edgeId: number; chunkId: number }> = [];
  const toAmbiguous: Array<{ edgeId: number; candidateIds: number[] }> = [];
  /** Unmatched edges the cheap in-memory ladder could not explain on its own. */
  const needsCrossFileProbe: Array<{ target: string; language: string | null }> = [];
  const chunkById = new Map(chunks.map((c) => [c.id, c]));

  for (const e of edges) {
    stats.edges_examined += 1;
    const pageId = pageByChunkId.get(e.from_chunk_id);
    if (pageId === undefined) {
      // Calling chunk vanished between the two queries. Nothing to explain.
      stats.edges_unmatched += 1;
      stats.unmatched_buckets.no_candidate_anywhere += 1;
      continue;
    }
    const key = `${pageId} ${e.to_symbol_qualified}`;
    const candidates = candidatesByKey.get(key) ?? [];
    if (candidates.length === 1) {
      toResolve.push({ edgeId: e.id, chunkId: candidates[0]!.id });
      stats.edges_resolved += 1;
      continue;
    }
    if (candidates.length > 1) {
      toAmbiguous.push({ edgeId: e.id, candidateIds: candidates.map((c) => c.id) });
      stats.edges_ambiguous += 1;
      continue;
    }

    // No same-file candidate. Edge stays as-is — caller's two-pass walk can
    // still expand it via cross-file resolution later. Classify WHY it missed,
    // walking the reason ladder most-actionable first.
    stats.edges_unmatched += 1;
    const language = chunkById.get(e.from_chunk_id)?.language ?? null;

    if (language === null) {
      // A code chunk with no language never carried metadata, or had it wiped.
      // Do NOT read this as "unsupported language": that would send an operator
      // to teach qualified-names.ts a language it already knows, when the real
      // remedy is a re-chunk. The wiping writer nulled `language` too.
      stats.unmatched_buckets.missing_symbol_metadata += 1;
    } else if (!supportsQualifiedNames(language)) {
      stats.unmatched_buckets.unsupported_language += 1;
    } else if ((qualCountByPage.get(pageId) ?? 0) === 0) {
      stats.unmatched_buckets.missing_symbol_metadata += 1;
    } else if (leavesByPage.get(pageId)?.has(qualifiedLeaf(e.to_symbol_qualified))) {
      stats.unmatched_buckets.bare_token_vs_qualified += 1;
    } else {
      needsCrossFileProbe.push({ target: e.to_symbol_qualified, language });
    }
  }

  // One batched probe settles cross_file_same_source for every leftover edge:
  // does any LIVE page in this source declare that exact qualified name? Pages
  // inside the soft-delete window still hold their chunks, and a definition no
  // normal read can reach is not "the definition exists, just elsewhere". A hit means
  // the definition is real and only the same-file scope kept us from it — a
  // resolver limitation, not a missing symbol. A miss falls through to the
  // builtin classifier, then to the honest unknown bucket.
  if (needsCrossFileProbe.length > 0) {
    const targets = Array.from(new Set(needsCrossFileProbe.map((p) => p.target)));
    // Match the target BOTH ways. `symbol_name_qualified` catches an exact hit;
    // `symbol_name` (the bare name) catches the far more common shape, where the
    // extractor emitted a bare `get` and the definition is stored qualified as
    // `Widget.get`. Without the bare arm, a project's own `get()` one file over
    // falls through to the builtin classifier and a real resolver miss is
    // written off as stdlib.
    const rows = await engine.executeRaw<{ symbol_name_qualified: string | null; symbol_name: string | null }>(
      `SELECT DISTINCT cc.symbol_name_qualified, cc.symbol_name
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.source_id = $1
          AND p.deleted_at IS NULL
          AND (cc.symbol_name_qualified = ANY($2::text[]) OR cc.symbol_name = ANY($2::text[]))`,
      [sourceId, targets],
    );
    const declaredInSource = new Set<string>();
    for (const r of rows) {
      if (r.symbol_name_qualified) declaredInSource.add(r.symbol_name_qualified);
      if (r.symbol_name) declaredInSource.add(r.symbol_name);
    }

    for (const { target, language } of needsCrossFileProbe) {
      if (declaredInSource.has(target)) {
        stats.unmatched_buckets.cross_file_same_source += 1;
      } else if (isLanguageBuiltin(target, language)) {
        stats.unmatched_buckets.builtin_or_external += 1;
      } else {
        stats.unmatched_buckets.no_candidate_anywhere += 1;
      }
    }
  }

  // Persist edge metadata updates in batches.
  for (const r of toResolve) {
    await engine.executeRaw(
      `UPDATE code_edges_symbol
          SET edge_metadata = COALESCE(edge_metadata, '{}'::jsonb) || jsonb_build_object('resolved_chunk_id', $1::int)
        WHERE id = $2`,
      [r.chunkId, r.edgeId],
    );
  }
  for (const a of toAmbiguous) {
    await engine.executeRaw(
      `UPDATE code_edges_symbol
          SET edge_metadata = COALESCE(edge_metadata, '{}'::jsonb)
                           || jsonb_build_object('ambiguous', true,
                                                 'candidates', $1::text::jsonb)
        WHERE id = $2`,
      [JSON.stringify(a.candidateIds), a.edgeId],
    );
  }

  // Mark the whole batch as backfilled — regardless of whether any edges
  // resolved. A chunk with zero unresolved edges still needs the watermark
  // bumped or it'll get re-walked every cycle tick forever.
  await engine.executeRaw(
    `UPDATE content_chunks SET edges_backfilled_at = NOW() WHERE id = ANY($1::int[])`,
    [chunkIds],
  );

  stats.chunks_walked += chunks.length;
}

/**
 * Read the resolution outcome from a single edge's metadata, if any.
 * Returns null when the edge hasn't been processed by the resolver yet.
 *
 * Public helper for downstream code (two-pass.ts, code_blast op) that
 * wants to use the resolver's output without parsing edge_metadata JSON
 * directly.
 */
export type EdgeResolution =
  | { kind: 'resolved'; chunk_id: number }
  | { kind: 'ambiguous'; candidate_chunk_ids: number[] }
  | { kind: 'unresolved' };

export function readEdgeResolution(metadata: Record<string, unknown> | null | undefined): EdgeResolution {
  if (!metadata) return { kind: 'unresolved' };
  if (typeof metadata.resolved_chunk_id === 'number') {
    return { kind: 'resolved', chunk_id: metadata.resolved_chunk_id };
  }
  if (metadata.ambiguous === true && Array.isArray(metadata.candidates)) {
    const candidates = metadata.candidates.filter((c): c is number => typeof c === 'number');
    if (candidates.length > 0) {
      return { kind: 'ambiguous', candidate_chunk_ids: candidates };
    }
  }
  return { kind: 'unresolved' };
}

/**
 * Source-wide page coverage of the resolved call graph.
 *
 * Counts PAGES, not edges: one page with 900 resolved edges next to 900 pages
 * with none is a graph you cannot navigate, and an edge ratio hides that. The
 * denominator is pages with at least one outbound symbol edge — a page that
 * calls nothing is neither covered nor uncovered.
 *
 * Read straight from committed `edge_metadata` rather than from whatever this
 * process happened to walk, so a tick that finds zero pending chunks still
 * reports the brain's true coverage instead of 0.
 */
export async function symbolEdgeCoverage(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<SymbolEdgeCoverage> {
  const params: unknown[] = [];
  let scope = '';
  if (opts.sourceId) {
    params.push(opts.sourceId);
    scope = `WHERE e.source_id = $${params.length}`;
  }
  // `pages` is joined only to drop soft-deleted rows: their chunks and edges
  // survive until purge, and a hidden page belongs in neither the numerator nor
  // the denominator. Mirrors the cross-file probe's liveness rule.
  const deletedFilter = scope ? 'AND p.deleted_at IS NULL' : 'WHERE p.deleted_at IS NULL';
  const rows = await engine.executeRaw<{ pages_resolved: number; pages_with_edges: number }>(
    `SELECT
       count(DISTINCT cc.page_id) FILTER (WHERE e.edge_metadata ? 'resolved_chunk_id')::int AS pages_resolved,
       count(DISTINCT cc.page_id)::int AS pages_with_edges
     FROM code_edges_symbol e
     JOIN content_chunks cc ON cc.id = e.from_chunk_id
     JOIN pages p ON p.id = cc.page_id
     ${scope} ${deletedFilter}`,
    params,
  );
  const pages_with_resolved_edges = Number(rows[0]?.pages_resolved ?? 0);
  const pages_with_edges = Number(rows[0]?.pages_with_edges ?? 0);
  return {
    pages_with_resolved_edges,
    pages_with_edges,
    page_coverage: pages_with_edges > 0 ? pages_with_resolved_edges / pages_with_edges : 0,
  };
}
