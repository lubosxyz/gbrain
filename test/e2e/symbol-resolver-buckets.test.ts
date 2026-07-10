/**
 * Unmatched-reason buckets + source-wide page coverage.
 *
 * `edges_unmatched` alone reads as "the resolver failed N times". Most of those
 * N are edges leaving the indexed corpus (builtins, third-party deps) and some
 * are a symptom of an upstream data problem. Each bucket pins one of those
 * stories so the number becomes actionable.
 *
 * PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  resolveSymbolEdgesIncremental,
  symbolEdgeCoverage,
  UNMATCHED_REASONS,
} from '../../src/core/chunkers/symbol-resolver.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('unmatched reason buckets', () => {
  test('buckets sum to edges_unmatched', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    for (const target of ['trim', 'someExternalThing', 'alsoMissing']) {
      await insertEdge(engine, caller, 'caller', target, 's');
    }

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    const sum = UNMATCHED_REASONS.reduce((n, r) => n + stats.unmatched_buckets[r], 0);
    expect(sum).toBe(stats.edges_unmatched);
    expect(stats.edges_unmatched).toBe(3);
  });

  test('missing_symbol_metadata: the page carries no qualified names at all', async () => {
    // Exactly the shape a metadata-wiping re-embed left behind: the edge knows
    // its caller's qualified name, but no chunk on the page has one, so the
    // candidate index for that page is empty and nothing could ever match.
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunkRaw(engine, page, 0, { language: 'typescript', qualified: null });
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.missing_symbol_metadata).toBe(1);
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(0);
  });

  test('unsupported_language outranks missing metadata — it is the root cause', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.erl');
    const caller = await insertChunkRaw(engine, page, 0, { language: 'erlang', qualified: null });
    await insertEdge(engine, caller, 'caller', 'gen_server', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.unsupported_language).toBe(1);
    expect(stats.unmatched_buckets.missing_symbol_metadata).toBe(0);
  });

  test('bare_token_vs_qualified: the file declares Class.render, the edge says render', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    await insertChunk(engine, page, 1, 'Widget.render', 'typescript');
    await insertEdge(engine, caller, 'caller', 'render', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.bare_token_vs_qualified).toBe(1);
  });

  test('cross_file_same_source: the definition exists, just not in this file', async () => {
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageB = await insertCodePage(engine, 's', 'src/b.ts');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunk(engine, pageB, 0, 'parseInput', 'typescript');
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(1);
    // Deliberately NOT resolved: widening past same-file scope is a separate
    // change with its own traversal consequences.
    expect(stats.edges_resolved).toBe(0);
  });

  test('a same-name definition in ANOTHER source does not count as cross-file', async () => {
    await registerSource(engine, 's');
    await registerSource(engine, 'other');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageOther = await insertCodePage(engine, 'other', 'src/b.ts');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunk(engine, pageOther, 0, 'parseInput', 'typescript');
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(0);
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(1);
  });

  test('builtin_or_external: stdlib and prototype methods are not failures', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    for (const target of ['trim', 'Promise', 'useState']) {
      await insertEdge(engine, caller, 'caller', target, 's');
    }

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.builtin_or_external).toBe(3);
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(0);
  });

  test('a user-defined symbol shadowing a builtin name is cross-file, not builtin', async () => {
    // Precedence guard: cross_file is checked BEFORE builtin, so a project that
    // defines its own `filter()` is never written off as stdlib.
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageB = await insertCodePage(engine, 's', 'src/b.ts');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunk(engine, pageB, 0, 'filter', 'typescript');
    await insertEdge(engine, caller, 'caller', 'filter', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(1);
    expect(stats.unmatched_buckets.builtin_or_external).toBe(0);
  });

  test('no_candidate_anywhere is the honest fallback', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    await insertEdge(engine, caller, 'caller', 'someVendorHelper', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(1);
  });
});

describe('symbolEdgeCoverage', () => {
  test('counts pages, not edges, and survives a walk that does nothing', async () => {
    await registerSource(engine, 's');
    // Page A resolves (caller + definition in the same file).
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const callerA = await insertChunk(engine, pageA, 0, 'callerA', 'typescript');
    await insertChunk(engine, pageA, 1, 'parseInput', 'typescript');
    await insertEdge(engine, callerA, 'callerA', 'parseInput', 's');
    // Page B only reaches builtins — has edges, resolves none.
    const pageB = await insertCodePage(engine, 's', 'src/b.ts');
    const callerB = await insertChunk(engine, pageB, 0, 'callerB', 'typescript');
    await insertEdge(engine, callerB, 'callerB', 'trim', 's');
    // Page C has no edges at all — neither covered nor uncovered.
    await insertCodePage(engine, 's', 'src/c.ts');

    await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });

    const cov = await symbolEdgeCoverage(engine, { sourceId: 's' });
    expect(cov.pages_with_resolved_edges).toBe(1);
    expect(cov.pages_with_edges).toBe(2);
    expect(cov.page_coverage).toBeCloseTo(0.5, 5);

    // Second walk finds nothing pending (watermark advanced) — coverage must
    // still report the brain's real state, not this tick's zero.
    const second = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(second.edges_resolved).toBe(0);
    const again = await symbolEdgeCoverage(engine, { sourceId: 's' });
    expect(again.page_coverage).toBeCloseTo(0.5, 5);
  });

  test('a brain with no code edges reports 0, not NaN', async () => {
    const cov = await symbolEdgeCoverage(engine);
    expect(cov.pages_with_edges).toBe(0);
    expect(cov.page_coverage).toBe(0);
  });
});

// --- helpers (mirror test/e2e/symbol-resolver-pglite.test.ts) ---

async function registerSource(engine: PGLiteEngine, id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, `/fake/${id}`],
  );
}

async function insertCodePage(engine: PGLiteEngine, sourceId: string, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ($1, $2, $3, 'code', 'code', '', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [slug, sourceId, slug],
  );
  return rows[0]!.id;
}

/** A chunk the code chunker produced: language + qualified name both present. */
async function insertChunk(
  engine: PGLiteEngine,
  pageId: number,
  chunkIndex: number,
  qualified: string,
  language: string,
): Promise<number> {
  return insertChunkRaw(engine, pageId, chunkIndex, { language, qualified });
}

async function insertChunkRaw(
  engine: PGLiteEngine,
  pageId: number,
  chunkIndex: number,
  meta: { language: string | null; qualified: string | null },
): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name_qualified, symbol_type)
     VALUES ($1, $2, $3, 'compiled_truth', $4, $5, 'function')
     RETURNING id`,
    [pageId, chunkIndex, `// chunk ${chunkIndex}`, meta.language, meta.qualified],
  );
  return rows[0]!.id;
}

async function insertEdge(
  engine: PGLiteEngine,
  fromChunkId: number,
  fromSymbol: string,
  toSymbol: string,
  sourceId: string,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
     VALUES ($1, $2, $3, 'calls', $4, '{}'::jsonb)`,
    [fromChunkId, fromSymbol, toSymbol, sourceId],
  );
}
