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
 * Rule: a writer that supplies NONE of the eight columns is not the chunker,
 * so the existing values survive. A writer that supplies ANY of them is
 * authoritative for ALL of them — that's how a real re-chunk retracts a
 * symbol (the code chunker always stamps `language`, even on the plain-text
 * chunks between symbols, so "supplies nothing" can never be a chunker).
 *
 * Deliberately NOT predicated on `chunk_text` changing: `reindex --contextual`
 * rewrites the text while supplying no code metadata, and that must not read
 * as "the chunker retracted the symbol".
 *
 * Pinned by test/chunk-code-metadata-preservation.test.ts. Mirrored verbatim
 * into both engines from here so postgres and pglite cannot drift.
 */
export const METADATA_BLIND_WRITER = `(
  EXCLUDED.language IS NULL
  AND EXCLUDED.symbol_name IS NULL
  AND EXCLUDED.symbol_type IS NULL
  AND EXCLUDED.start_line IS NULL
  AND EXCLUDED.end_line IS NULL
  AND EXCLUDED.parent_symbol_path IS NULL
  AND EXCLUDED.doc_comment IS NULL
  AND EXCLUDED.symbol_name_qualified IS NULL
)`;
