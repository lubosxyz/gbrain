/**
 * End-to-end proof of the bug the metadata guard closes.
 *
 * The chain that broke in production:
 *   importCodeFile()  → chunks carry symbol_name_qualified, edges are emitted
 *   embed --stale     → re-upserts chunks WITHOUT code metadata
 *   ON CONFLICT       → language / symbol_name_qualified / … = NULL
 *   resolve_symbol_edges → candidate index empty → 0% of the call graph resolves
 *   code-graph-readiness → still reports "ready", because the watermark advanced
 *
 * A brain in that state answers `code-callers` with silence and looks healthy
 * doing it. This test drives the real importer, the real blind re-embed, and
 * the real resolver.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import {
  resolveSymbolEdgesIncremental,
  symbolEdgeCoverage,
  EDGE_EXTRACTOR_VERSION_TS,
} from '../../src/core/chunkers/symbol-resolver.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const SOURCE = 'default';

/**
 * Both functions are deliberately fat: `mergeSmallSiblings` folds adjacent tiny
 * symbols into one merged chunk with no `symbol_name_qualified`, and a merged
 * chunk emits no edges at all — a toy two-liner would test nothing.
 */
const SRC = `
export function parseInput(raw: string, opts: { strict?: boolean } = {}): string {
  if (typeof raw !== 'string') throw new TypeError('raw must be a string');
  const trimmed = raw.trim();
  if (trimmed.length === 0 && opts.strict) {
    throw new Error('empty input rejected under strict mode');
  }
  const collapsed = trimmed.replace(/\\s+/g, ' ');
  if (collapsed.startsWith('#')) {
    console.warn('comment line passed to parseInput:', collapsed.slice(0, 32));
  }
  if (collapsed.length > 4096) {
    console.warn('unusually long input:', collapsed.length);
  }
  return collapsed.toLowerCase();
}

export function handleRequest(raw: string, opts: { strict?: boolean } = {}): string {
  if (!raw) {
    console.warn('handleRequest called with empty payload');
    return '';
  }
  const parsed = parseInput(raw, opts);
  if (parsed.startsWith('ping')) {
    console.log('responding to ping with', parsed.length, 'chars');
    return 'pong';
  }
  if (parsed.includes('error')) {
    console.warn('client reported an error:', parsed.slice(0, 64));
    return 'ack-error';
  }
  return parsed;
}
`;

let engine: PGLiteEngine;

// initSchema replays 117 migrations; paying that once per FILE (not per test)
// keeps this suite inside bun's hook timeout.
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

// TRUNCATE CASCADE over the full table set after a tree-sitter import overruns
// bun's 5s default hook timeout on PGLite/WASM.
beforeEach(async () => {
  await resetPgliteState(engine);
}, 60_000);

/** Rewind the resolver watermark so the next pass re-walks every chunk. */
async function rewindWatermark(): Promise<void> {
  await engine.executeRaw(`UPDATE content_chunks SET edges_backfilled_at = NULL`, []);
}

/** Exactly what embed.ts / embed-stale.ts hand to upsertChunks. */
async function blindReEmbed(slug: string): Promise<void> {
  const existing = await engine.getChunks(slug);
  const blind: ChunkInput[] = existing.map((c) => ({
    chunk_index: c.chunk_index,
    chunk_text: c.chunk_text,
    chunk_source: c.chunk_source,
    token_count: c.token_count ?? undefined,
  }));
  await engine.upsertChunks(slug, blind);
}

describe('the code graph survives a metadata-blind re-embed', () => {
  test('handleRequest → parseInput resolves, and still resolves after embed --stale', async () => {
    const result = await importCodeFile(engine, 'src/parser.ts', SRC, { noEmbed: true, sourceId: SOURCE });
    expect(result.status).not.toBe('skipped');

    const edges = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM code_edges_symbol WHERE to_symbol_qualified = 'parseInput'`,
      [],
    );
    expect(Number(edges[0]!.n)).toBeGreaterThan(0);

    // Baseline: the resolver finds the same-file definition.
    const first = await resolveSymbolEdgesIncremental(engine, { sourceId: SOURCE });
    expect(first.edges_resolved).toBeGreaterThan(0);
    expect(first.unmatched_buckets.missing_symbol_metadata).toBe(0);

    const before = await symbolEdgeCoverage(engine, { sourceId: SOURCE });
    expect(before.page_coverage).toBe(1);

    // The regression: a plain re-embed touches every chunk on the page.
    await blindReEmbed(result.slug);

    const chunks = await engine.getChunks(result.slug);
    const qualified = chunks.filter((c) => c.symbol_name_qualified !== null);
    expect(qualified.length).toBeGreaterThan(0);

    // Re-walk from scratch: the candidate index must still be there.
    await rewindWatermark();
    const second = await resolveSymbolEdgesIncremental(engine, { sourceId: SOURCE });
    expect(second.edges_resolved).toBeGreaterThan(0);
    expect(second.unmatched_buckets.missing_symbol_metadata).toBe(0);

    const after = await symbolEdgeCoverage(engine, { sourceId: SOURCE });
    expect(after.page_coverage).toBe(1);
  }, 120_000);

  test('a wiped page is reported as missing_symbol_metadata, not as an unexplained miss', async () => {
    // Simulate the damage an already-wiped brain carries, and assert the new
    // bucket names it. This is the signal that tells an operator to re-sync
    // rather than to go hunting for a resolver bug.
    await importCodeFile(engine, 'src/parser.ts', SRC, { noEmbed: true, sourceId: SOURCE });
    // The blind writer nulled `language` too — reproduce the real shape, not a
    // convenient one. An earlier version of this test kept `language` and so
    // never noticed the classifier answering `unsupported_language`.
    await engine.executeRaw(
      `UPDATE content_chunks
          SET symbol_name_qualified = NULL, symbol_name = NULL, symbol_type = NULL,
              language = NULL, parent_symbol_path = NULL, doc_comment = NULL`,
      [],
    );
    await rewindWatermark();

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: SOURCE });
    expect(stats.edges_resolved).toBe(0);
    expect(stats.unmatched_buckets.missing_symbol_metadata).toBeGreaterThan(0);

    const cov = await symbolEdgeCoverage(engine, { sourceId: SOURCE });
    expect(cov.page_coverage).toBe(0);
    expect(cov.pages_with_edges).toBe(1);
  }, 120_000);

  test('EDGE_EXTRACTOR_VERSION_TS still gates the re-walk', async () => {
    await importCodeFile(engine, 'src/parser.ts', SRC, { noEmbed: true, sourceId: SOURCE });
    await resolveSymbolEdgesIncremental(engine, { sourceId: SOURCE });

    // Watermark now >= version stamp: a second pass walks nothing.
    const idempotent = await resolveSymbolEdgesIncremental(engine, { sourceId: SOURCE });
    expect(idempotent.chunks_walked).toBe(0);
    expect(EDGE_EXTRACTOR_VERSION_TS).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 120_000);
});
