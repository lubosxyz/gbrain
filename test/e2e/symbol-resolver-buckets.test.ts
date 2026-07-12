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
  symbolUnmatchedBuckets,
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

  test('a NAMED but unsupported language is unsupported_language', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.erl');
    const caller = await insertChunkRaw(engine, page, 0, { language: 'erlang', qualified: null });
    await insertEdge(engine, caller, 'caller', 'gen_server', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.unsupported_language).toBe(1);
    expect(stats.unmatched_buckets.missing_symbol_metadata).toBe(0);
  });

  test('a NULL language is missing metadata, never "unsupported language"', async () => {
    // The exact shape a metadata wipe leaves behind: the blind writer nulled
    // `language` along with the symbol columns. Reporting `unsupported_language`
    // here would send an operator to teach qualified-names.ts a language it
    // already supports, instead of re-chunking.
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunkRaw(engine, page, 0, { language: null, qualified: null });
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.missing_symbol_metadata).toBe(1);
    expect(stats.unmatched_buckets.unsupported_language).toBe(0);
  });

  test('a definition on a soft-deleted page is not cross_file_same_source', async () => {
    // Soft-deleted pages keep their chunks until purge. A definition no normal
    // read can reach is not "it exists, just in another file".
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageB = await insertCodePage(engine, 's', 'src/b.ts');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunk(engine, pageB, 0, 'parseInput', 'typescript');
    await engine.executeRaw(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [pageB]);
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(0);
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(1);
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

  test('a QUALIFIED target with a mere leaf collision is NOT bare_token_vs_qualified', async () => {
    // Target `Widget.get`; the page declares `Other.get`. The leaves collide but
    // the target is not bare, so calling it bare_token_vs_qualified would hide a
    // genuine miss. It must fall through to the cross-file probe instead.
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    await insertChunk(engine, page, 1, 'Other.get', 'typescript');
    await insertEdge(engine, caller, 'caller', 'Widget.get', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.bare_token_vs_qualified).toBe(0);
    // `Widget.get` is declared nowhere → honest unknown (get's leaf being a
    // builtin doesn't apply: the target is qualified, so isLanguageBuiltin is
    // false).
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(1);
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

  test('a user symbol shadowing a builtin name is ambiguous, not a confident answer', async () => {
    // `items.filter(…)` and a call to a project-defined `filter()` produce the
    // same bare token. Calling it cross-file would over-claim; calling it a
    // builtin would bury a real miss. Neither, then.
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageB = await insertCodePage(engine, 's', 'src/b.ts');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunk(engine, pageB, 0, 'filter', 'typescript');
    await insertEdge(engine, caller, 'caller', 'filter', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.ambiguous_bare_token).toBe(1);
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(0);
    expect(stats.unmatched_buckets.builtin_or_external).toBe(0);
  });

  test('a .ts caller resolves a definition in a .tsx file (same family)', async () => {
    // The extractor emits no cross-language calls, but TS/JS variants call each
    // other freely. A byte-exact language filter would strand this.
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageB = await insertCodePage(engine, 's', 'src/b.tsx');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunkRaw(engine, pageB, 0, { language: 'tsx', qualified: 'Widget.parseInput', bare: 'parseInput' });
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(1);
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(0);
  });

  test('a same-named declaration in ANOTHER language never explains the edge', async () => {
    // The extractor emits no cross-language calls, so a Python `filter()` must
    // not be offered as the reason a TypeScript edge missed.
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageB = await insertCodePage(engine, 's', 'src/b.py');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunkRaw(engine, pageB, 0, { language: 'python', qualified: 'helper', bare: 'helper' });
    await insertEdge(engine, caller, 'caller', 'helper', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(0);
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(1);
  });


  test('a registered language without a LANG_CONFIG entry is NOT unsupported', async () => {
    // buildQualifiedName falls back to a dot-joined scope path for C#, C++, PHP
    // and friends, so their chunks DO enter the candidate index and DO resolve.
    // Bucketing them as `unsupported_language` would hide a real cross-file miss
    // behind a reason that isn't true.
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.cs');
    const pageB = await insertCodePage(engine, 's', 'src/b.cs');
    const caller = await insertChunk(engine, pageA, 0, 'Caller', 'c_sharp');
    await insertChunk(engine, pageB, 0, 'ParseInput', 'c_sharp');
    await insertEdge(engine, caller, 'Caller', 'ParseInput', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.unsupported_language).toBe(0);
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(1);
  });

  test('a QUALIFIED target is never written off as a builtin', async () => {
    // `Widget::get` has a user-owned namespace. Matching its leaf against `get`
    // would file a real resolver miss under "that's just stdlib".
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    await insertEdge(engine, caller, 'caller', 'Widget.get', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.builtin_or_external).toBe(0);
    expect(stats.unmatched_buckets.no_candidate_anywhere).toBe(1);
  });

  test('the bare-name arm sees a method stored under a qualified name', async () => {
    // The extractor emits bare `get`; the definition is stored qualified as
    // `Widget.get`, so the exact-name probe misses and only the bare arm sees it.
    // `get` is also a builtin, so the honest verdict is ambiguity — but the
    // point is that the bare arm fired at all: without it this lands in
    // `builtin_or_external` and the project's own method is written off.
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageB = await insertCodePage(engine, 's', 'src/b.ts');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunkRaw(engine, pageB, 0, { language: 'typescript', qualified: 'Widget.get', bare: 'get' });
    await insertEdge(engine, caller, 'caller', 'get', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.ambiguous_bare_token).toBe(1);
    expect(stats.unmatched_buckets.builtin_or_external).toBe(0);
  });

  test('a non-builtin bare name elsewhere in the source IS cross-file', async () => {
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const pageB = await insertCodePage(engine, 's', 'src/b.ts');
    const caller = await insertChunk(engine, pageA, 0, 'caller', 'typescript');
    await insertChunkRaw(engine, pageB, 0, { language: 'typescript', qualified: 'Mod.parseInput', bare: 'parseInput' });
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.unmatched_buckets.cross_file_same_source).toBe(1);
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

  test('a soft-deleted page leaves both numerator and denominator', async () => {
    await registerSource(engine, 's');
    const pageA = await insertCodePage(engine, 's', 'src/a.ts');
    const callerA = await insertChunk(engine, pageA, 0, 'callerA', 'typescript');
    await insertChunk(engine, pageA, 1, 'parseInput', 'typescript');
    await insertEdge(engine, callerA, 'callerA', 'parseInput', 's');
    await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });

    expect((await symbolEdgeCoverage(engine, { sourceId: 's' })).pages_with_edges).toBe(1);

    await engine.executeRaw(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [pageA]);
    const cov = await symbolEdgeCoverage(engine, { sourceId: 's' });
    expect(cov.pages_with_edges).toBe(0);
    expect(cov.pages_with_resolved_edges).toBe(0);
    expect(cov.page_coverage).toBe(0);
  });

  test('a brain with no code edges reports 0, not NaN', async () => {
    const cov = await symbolEdgeCoverage(engine);
    expect(cov.pages_with_edges).toBe(0);
    expect(cov.page_coverage).toBe(0);
  });
});

describe('symbolUnmatchedBuckets (committed state)', () => {
  test('the diagnosis survives the walk that produced it', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    await insertEdge(engine, caller, 'caller', 'trim', 's');
    await insertEdge(engine, caller, 'caller', 'someVendorHelper', 's');

    const first = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(first.unmatched_buckets.builtin_or_external).toBe(1);
    expect(first.unmatched_buckets.no_candidate_anywhere).toBe(1);

    // The second pass walks nothing — the watermark advanced. Walk-scoped stats
    // go to zero; the persisted diagnosis must not.
    const second = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(second.chunks_walked).toBe(0);
    expect(second.unmatched_buckets.builtin_or_external).toBe(0);

    const committed = await symbolUnmatchedBuckets(engine, { sourceId: 's' });
    expect(committed.builtin_or_external).toBe(1);
    expect(committed.no_candidate_anywhere).toBe(1);
  });

  test('an edge that later resolves stops reporting why it once did not', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect((await symbolUnmatchedBuckets(engine, { sourceId: 's' })).no_candidate_anywhere).toBe(1);

    // The definition arrives (a later sync indexes it) and the resolver re-walks.
    await insertChunk(engine, page, 1, 'parseInput', 'typescript');
    await engine.executeRaw(`UPDATE content_chunks SET edges_backfilled_at = NULL`, []);
    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.edges_resolved).toBe(1);

    const committed = await symbolUnmatchedBuckets(engine, { sourceId: 's' });
    expect(UNMATCHED_REASONS.reduce((n, r) => n + committed[r], 0)).toBe(0);
  });

  test('an edge wiped after it resolved ends up ONLY unmatched, never both', async () => {
    // Reproduces the wipe timeline: the edge resolved once (carries
    // resolved_chunk_id), the page's metadata was then nulled, and the version
    // bump forces a re-walk. It must not be counted as both resolved AND
    // unmatched.
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    const def = await insertChunk(engine, page, 1, 'parseInput', 'typescript');
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect((await symbolEdgeCoverage(engine, { sourceId: 's' })).pages_with_resolved_edges).toBe(1);

    // Wipe the definition's qualified name (the metadata-blind writer's damage)
    // and force a re-walk.
    await engine.executeRaw(
      `UPDATE content_chunks SET symbol_name_qualified = NULL, symbol_name = NULL WHERE id = $1`,
      [def],
    );
    await engine.executeRaw(`UPDATE content_chunks SET edges_backfilled_at = NULL`, []);
    await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });

    // Exactly one of the two states, never both.
    const cov = await symbolEdgeCoverage(engine, { sourceId: 's' });
    const buckets = await symbolUnmatchedBuckets(engine, { sourceId: 's' });
    expect(cov.pages_with_resolved_edges).toBe(0);
    expect(UNMATCHED_REASONS.reduce((n, r) => n + buckets[r], 0)).toBe(1);

    const both = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM code_edges_symbol
        WHERE edge_metadata ? 'resolved_chunk_id' AND edge_metadata ? 'unmatched_reason'`,
      [],
    );
    expect(Number(both[0]!.n)).toBe(0);
  });

  test('an edge that becomes ambiguous drops its stale resolved_chunk_id', async () => {
    // One candidate first (resolves), then a duplicate definition appears and a
    // re-walk sees two (ambiguous). The old resolved_chunk_id must not survive,
    // or symbolEdgeCoverage would keep counting it as resolved to a stale chunk.
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    await insertChunk(engine, page, 1, 'parseInput', 'typescript');
    await insertEdge(engine, caller, 'caller', 'parseInput', 's');

    await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect((await symbolEdgeCoverage(engine, { sourceId: 's' })).pages_with_resolved_edges).toBe(1);

    // A second chunk with the same qualified name → now ambiguous.
    await insertChunk(engine, page, 2, 'parseInput', 'typescript');
    await engine.executeRaw(`UPDATE content_chunks SET edges_backfilled_at = NULL`, []);
    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect(stats.edges_ambiguous).toBe(1);

    const both = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM code_edges_symbol
        WHERE edge_metadata ? 'resolved_chunk_id' AND edge_metadata ? 'ambiguous'`,
      [],
    );
    expect(Number(both[0]!.n)).toBe(0);
    // And it no longer counts as resolved.
    expect((await symbolEdgeCoverage(engine, { sourceId: 's' })).pages_with_resolved_edges).toBe(0);
  });

  test('a soft-deleted page stops contributing its reasons', async () => {
    await registerSource(engine, 's');
    const page = await insertCodePage(engine, 's', 'src/a.ts');
    const caller = await insertChunk(engine, page, 0, 'caller', 'typescript');
    await insertEdge(engine, caller, 'caller', 'someVendorHelper', 's');
    await resolveSymbolEdgesIncremental(engine, { sourceId: 's' });
    expect((await symbolUnmatchedBuckets(engine, { sourceId: 's' })).no_candidate_anywhere).toBe(1);

    await engine.executeRaw(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [page]);
    expect((await symbolUnmatchedBuckets(engine, { sourceId: 's' })).no_candidate_anywhere).toBe(0);
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
  meta: { language: string | null; qualified: string | null; bare?: string | null },
): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name_qualified, symbol_name, symbol_type)
     VALUES ($1, $2, $3, 'compiled_truth', $4, $5, $6, 'function')
     RETURNING id`,
    [pageId, chunkIndex, `// chunk ${chunkIndex}`, meta.language, meta.qualified, meta.bare ?? null],
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
