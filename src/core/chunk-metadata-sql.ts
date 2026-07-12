/**
 * Shared SQL fragment guarding the tree-sitter columns on `content_chunks`
 * against metadata-blind writers.
 *
 * The code chunker owns `language` / `symbol_name` / `symbol_type` /
 * `start_line` / `end_line` / `parent_symbol_path` / `doc_comment` /
 * `symbol_name_qualified`. Several other writers legitimately re-upsert a
 * chunk row without ever knowing those columns exist:
 *
 *   - `embed.ts` (embedPage / embed --all) and `embed-stale.ts` rebuild
 *     ChunkInput from {chunk_index, chunk_text, chunk_source, embedding,
 *     token_count} and re-upsert to attach a fresh embedding.
 *   - `contextual-retrieval-service.ts` and `reindex --contextual` rewrite
 *     `chunk_text` with a prepended context header.
 *   - `migrate-engine.ts` copies rows between engines.
 *
 * Taking `EXCLUDED.<col>` unconditionally in the ON CONFLICT branch let any
 * of those writers NULL the chunker's output. That silently decapitated the
 * code graph: `symbol_name_qualified` is the only key the symbol resolver
 * builds its candidate index from, so a wiped brain resolves 0% of its call
 * graph — while `code-graph-readiness.ts` still reports `ready`, because it
 * probes the `edges_backfilled_at` watermark, never whether a match was
 * possible.
 *
 * Rule: a writer is metadata-blind when it supplies NONE of the eight columns
 * AND leaves `chunk_source` as it found it. Then the existing values survive.
 * Any other writer is authoritative for ALL eight — that's how a real re-chunk
 * retracts a symbol.
 *
 * The `chunk_source` clause is what makes "supplies nothing" safe to read as
 * "isn't the chunker". Markdown pages carry `chunk_source='fenced_code'` chunks
 * that DO have `language`/`symbol_name` (import-file.ts extracts fenced blocks
 * through the code chunker), interleaved with metadata-free
 * `chunk_source='compiled_truth'` prose. Editing a page can drop a fence and
 * shift a prose chunk onto the index a fenced_code chunk used to hold; without
 * this clause the prose row would inherit that fence's language and symbol
 * forever, and `code-def` would answer with prose.
 *
 * Deliberately NOT predicated on `chunk_text` changing: `reindex --contextual`
 * rewrites the text while supplying no code metadata, and that must not read
 * as "the chunker retracted the symbol".
 *
 * Pinned by test/chunk-code-metadata-preservation.test.ts. Mirrored verbatim
 * into both engines from here so postgres and pglite cannot drift.
 */
export const METADATA_BLIND_WRITER = `(
  EXCLUDED.chunk_source IS NOT DISTINCT FROM content_chunks.chunk_source
  AND EXCLUDED.language IS NULL
  AND EXCLUDED.symbol_name IS NULL
  AND EXCLUDED.symbol_type IS NULL
  AND EXCLUDED.start_line IS NULL
  AND EXCLUDED.end_line IS NULL
  AND EXCLUDED.parent_symbol_path IS NULL
  AND EXCLUDED.doc_comment IS NULL
  AND EXCLUDED.symbol_name_qualified IS NULL
)`;
