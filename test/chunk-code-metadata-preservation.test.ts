/**
 * Regression: every re-embed path (`embed.ts`, `embed-stale.ts`) rebuilds
 * ChunkInput from only {chunk_index, chunk_text, chunk_source, embedding,
 * token_count} and re-upserts. The upsert's ON CONFLICT branch used to take
 * `language = EXCLUDED.language` etc. unconditionally, so a metadata-blind
 * writer NULLed out the tree-sitter columns the code chunker had written.
 *
 * Downstream blast radius: `symbol_name_qualified` is the ONLY key the
 * symbol resolver's candidate index is built from, so a wiped brain resolves
 * 0% of its call graph while `code-graph-readiness` still reports "ready".
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
}, 60_000);

describe('code metadata survives metadata-blind chunk upserts', () => {
  const codeChunk: ChunkInput = {
    chunk_index: 0,
    chunk_text: 'export function parseInput(x: string) { return x.trim(); }',
    chunk_source: 'compiled_truth',
    language: 'typescript',
    symbol_name: 'parseInput',
    symbol_type: 'function',
    start_line: 1,
    end_line: 1,
    parent_symbol_path: ['mod'],
    doc_comment: 'Parses input.',
    symbol_name_qualified: 'mod.parseInput',
  };

  async function seedCodePage(): Promise<void> {
    await engine.putPage('code/parser-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'parser.ts (typescript)',
      compiled_truth: codeChunk.chunk_text,
      timeline: '',
    });
    await engine.upsertChunks('code/parser-ts', [codeChunk]);
  }

  test('chunker-written metadata round-trips through the initial upsert', async () => {
    await seedCodePage();
    const [chunk] = await engine.getChunks('code/parser-ts');
    expect(chunk!.symbol_name_qualified).toBe('mod.parseInput');
    expect(chunk!.language).toBe('typescript');
  });

  test('a metadata-blind re-embed does NOT wipe code metadata', async () => {
    await seedCodePage();

    // Exactly what embed.ts:embedPage / embed-stale.ts build: text unchanged,
    // no code columns supplied.
    const reEmbed: ChunkInput = {
      chunk_index: 0,
      chunk_text: codeChunk.chunk_text,
      chunk_source: 'compiled_truth',
      embedding: new Float32Array(1536).fill(0.1),
      token_count: 14,
    };
    await engine.upsertChunks('code/parser-ts', [reEmbed]);

    const [chunk] = await engine.getChunks('code/parser-ts');
    expect(chunk!.symbol_name_qualified).toBe('mod.parseInput');
    expect(chunk!.language).toBe('typescript');
    expect(chunk!.symbol_name).toBe('parseInput');
    expect(chunk!.symbol_type).toBe('function');
    expect(chunk!.start_line).toBe(1);
    expect(chunk!.end_line).toBe(1);
    expect(chunk!.doc_comment).toBe('Parses input.');
    expect(chunk!.parent_symbol_path).toEqual(['mod']);
    // The embedding the blind writer DID supply must still land. getChunks()
    // never returns the vector itself, so `embedded_at` is the observable.
    expect(chunk!.embedded_at).not.toBeNull();
  });

  test('a metadata-blind re-embed with CHANGED text still preserves metadata', async () => {
    // reindex --contextual prepends context to chunk_text and supplies no
    // code columns. Text changing must not be read as "the chunker retracted
    // the symbol".
    await seedCodePage();
    await engine.upsertChunks('code/parser-ts', [{
      chunk_index: 0,
      chunk_text: 'Context: parser module.\n' + codeChunk.chunk_text,
      chunk_source: 'compiled_truth',
    }]);

    const [chunk] = await engine.getChunks('code/parser-ts');
    expect(chunk!.symbol_name_qualified).toBe('mod.parseInput');
    expect(chunk!.language).toBe('typescript');
  });

  test('a prose chunk landing on a fenced_code index does NOT inherit its metadata', async () => {
    // Markdown pages interleave `chunk_source='fenced_code'` chunks (which DO
    // carry language/symbol, extracted through the code chunker) with
    // metadata-free `compiled_truth` prose. Dropping a fence shifts a prose
    // chunk onto the index the fence used to hold. Without the chunk_source
    // clause in METADATA_BLIND_WRITER, that prose row would inherit the fence's
    // language forever and `code-def` would answer with prose.
    await engine.putPage('notes/snippet', {
      type: 'note',
      title: 'Snippet',
      compiled_truth: 'prose',
      timeline: '',
    });
    await engine.upsertChunks('notes/snippet', [{
      chunk_index: 0,
      chunk_text: 'def parse(x):\n    return x.strip()',
      chunk_source: 'fenced_code',
      language: 'python',
      symbol_name: 'parse',
      symbol_type: 'function',
      symbol_name_qualified: 'parse',
    }]);

    // The fence is deleted; a prose chunk takes index 0.
    await engine.upsertChunks('notes/snippet', [{
      chunk_index: 0,
      chunk_text: 'Just prose now, the code block is gone.',
      chunk_source: 'compiled_truth',
    }]);

    const [chunk] = await engine.getChunks('notes/snippet');
    expect(chunk!.chunk_source).toBe('compiled_truth');
    expect(chunk!.language).toBeNull();
    expect(chunk!.symbol_name_qualified).toBeNull();
    expect(chunk!.symbol_name).toBeNull();
  });

  test('the chunker CAN still retract a symbol (supplies partial metadata)', async () => {
    // A real re-chunk that turns a symbol chunk into a plain-text chunk sets
    // `language` (code chunker always stamps it) but no symbol. That writer is
    // authoritative: the stale symbol identity must be dropped, not preserved.
    await seedCodePage();
    await engine.upsertChunks('code/parser-ts', [{
      chunk_index: 0,
      chunk_text: '// just a comment banner',
      chunk_source: 'compiled_truth',
      language: 'typescript',
    }]);

    const [chunk] = await engine.getChunks('code/parser-ts');
    expect(chunk!.language).toBe('typescript');
    expect(chunk!.symbol_name_qualified).toBeNull();
    expect(chunk!.symbol_name).toBeNull();
    expect(chunk!.doc_comment).toBeNull();
  });
});
