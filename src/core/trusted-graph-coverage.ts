/**
 * `trusted_graph_coverage` — the fraction of knowledge pages that are actually
 * reachable through an edge a human meant.
 *
 * ## Why not orphan rate
 *
 * `orphan_pages` counts every row in `pages`, so on any brain with a code
 * source it is dominated by code-chunk pages, which are wired through
 * `code_edges_symbol` and never through `links`. A real brain reads
 * "3891/3893 orphans (99.9%)" and the number carries no signal: it cannot get
 * better, and it says nothing about whether the prose graph is navigable.
 *
 * Coverage fixes the denominator (only pages that *should* be linked) and
 * tightens the numerator (only edges that mean something).
 *
 * ## Eligible pages (denominator)
 *
 * A live `page_kind = 'markdown'` page that is not:
 *   - a raw capture — `inbox/` is the triage staging area (see
 *     minions/handlers/ingest-capture.ts); an untriaged capture is not yet
 *     knowledge. Promotion out of `inbox/` makes it eligible, which is exactly
 *     the behaviour we want to reward.
 *   - a machine receipt — `extract_receipt` pages record extraction outcomes.
 *   - empty or boilerplate — under MIN_KNOWLEDGE_CHARS of body text.
 *   - a pseudo/auto page — reuses `shouldExclude` from the orphans command so
 *     "what counts as a real knowledge page" has exactly one definition.
 *
 * `page_kind IN ('code','image')` is excluded wholesale: code pages live in the
 * symbol graph (see chunkers/symbol-resolver.ts `symbolEdgeCoverage`, the code
 * counterpart of this metric), images in neither.
 *
 * ## Trusted edges (numerator)
 *
 * A link in either direction to a live page, whose `link_source` is not
 * `'mentions'`. Auto-linked body-text mentions are graph-completeness signal,
 * not human-intent signal — `getBacklinkCounts` already excludes them from
 * search ranking for the same reason. Direction is not constrained: a hub page
 * that only links out is genuinely part of the graph.
 *
 * Deliberately NOT counted as trusted: kNN / embedding-similarity edges. None
 * are written today, and none should be until the edge model carries a type and
 * provenance — otherwise this metric would score a brain on edges nobody chose.
 */

import type { BrainEngine } from './engine.ts';
import { shouldExclude } from '../commands/orphans.ts';

/**
 * Shorter than a sentence — a write-probe, a stub, or a title with no body.
 * Calibrated against real brains: the gap between the longest probe page (~20
 * chars) and the shortest genuine preference page (~92 chars) is wide and
 * empty, so the threshold is not load-bearing.
 */
export const MIN_KNOWLEDGE_CHARS = 40;

/** Slug prefix of the capture triage staging area. */
const RAW_CAPTURE_PREFIX = 'inbox/';

/** Page types written by machines to record an outcome, never to hold knowledge. */
const MACHINE_STUB_TYPES = new Set(['extract_receipt']);

export interface PagesBySurface {
  /** Live markdown knowledge pages, raw captures excluded. */
  prose: number;
  /** Live `page_kind = 'code'` pages — the symbol graph's territory. */
  code: number;
  /** Live `page_kind = 'image'` pages. */
  image: number;
  /** Live markdown pages still sitting in the `inbox/` triage area. */
  raw_capture: number;
}

export interface TrustedGraphCoverage {
  /** Knowledge pages that could carry a trusted edge. */
  eligible_pages: number;
  /** Of those, how many have >= 1 trusted edge (inbound or outbound). */
  covered_pages: number;
  /** covered_pages / eligible_pages; 0 when there is nothing to cover. */
  coverage: number;
  /** Why pages dropped out of the denominator. Sums with eligible_pages to the markdown page count. */
  excluded: {
    raw_capture: number;
    machine_stub: number;
    empty_or_boilerplate: number;
    pseudo_or_auto: number;
  };
}

interface MarkdownPageRow {
  slug: string;
  type: string;
  content_len: number;
  has_trusted_edge: boolean;
}

/**
 * A link that is not an auto-generated body-text mention, pointing at or coming
 * from a live page. Shared by both EXISTS arms so the two directions cannot
 * drift apart.
 */
const TRUSTED_LINK_PREDICATE = `l.link_source IS DISTINCT FROM 'mentions'`;

export async function computeTrustedGraphCoverage(engine: BrainEngine): Promise<TrustedGraphCoverage> {
  // Filter what SQL filters cheaply (kind, liveness); hand the rest to
  // `shouldExclude` so the slug taxonomy has a single home. Bounded by the
  // markdown page count, which is orders of magnitude below the code-chunk count
  // this metric exists to ignore.
  const rows = await engine.executeRaw<MarkdownPageRow>(
    `SELECT
       p.slug,
       p.type,
       length(btrim(p.compiled_truth))::int AS content_len,
       (
         EXISTS (
           SELECT 1 FROM links l
           JOIN pages src ON src.id = l.from_page_id
           WHERE l.to_page_id = p.id AND src.deleted_at IS NULL AND ${TRUSTED_LINK_PREDICATE}
         )
         OR EXISTS (
           SELECT 1 FROM links l
           JOIN pages dst ON dst.id = l.to_page_id
           WHERE l.from_page_id = p.id AND dst.deleted_at IS NULL AND ${TRUSTED_LINK_PREDICATE}
         )
       ) AS has_trusted_edge
     FROM pages p
     WHERE p.deleted_at IS NULL
       AND p.page_kind = 'markdown'`,
    [],
  );

  const excluded = { raw_capture: 0, machine_stub: 0, empty_or_boilerplate: 0, pseudo_or_auto: 0 };
  let eligible_pages = 0;
  let covered_pages = 0;

  for (const row of rows) {
    if (row.slug.startsWith(RAW_CAPTURE_PREFIX)) {
      excluded.raw_capture += 1;
      continue;
    }
    if (MACHINE_STUB_TYPES.has(row.type)) {
      excluded.machine_stub += 1;
      continue;
    }
    if (Number(row.content_len) < MIN_KNOWLEDGE_CHARS) {
      excluded.empty_or_boilerplate += 1;
      continue;
    }
    if (shouldExclude(row.slug)) {
      excluded.pseudo_or_auto += 1;
      continue;
    }
    eligible_pages += 1;
    if (row.has_trusted_edge) covered_pages += 1;
  }

  return {
    eligible_pages,
    covered_pages,
    coverage: eligible_pages > 0 ? covered_pages / eligible_pages : 0,
    excluded,
  };
}

export async function computePagesBySurface(engine: BrainEngine): Promise<PagesBySurface> {
  const rows = await engine.executeRaw<{ page_kind: string; raw_capture: number; total: number }>(
    `SELECT
       p.page_kind,
       count(*) FILTER (WHERE p.slug LIKE $1)::int AS raw_capture,
       count(*)::int AS total
     FROM pages p
     WHERE p.deleted_at IS NULL
     GROUP BY p.page_kind`,
    [`${RAW_CAPTURE_PREFIX}%`],
  );

  const surface: PagesBySurface = { prose: 0, code: 0, image: 0, raw_capture: 0 };
  for (const row of rows) {
    const total = Number(row.total);
    const rawCapture = Number(row.raw_capture);
    if (row.page_kind === 'markdown') {
      surface.raw_capture = rawCapture;
      surface.prose = total - rawCapture;
    } else if (row.page_kind === 'code') {
      surface.code = total;
    } else if (row.page_kind === 'image') {
      surface.image = total;
    }
  }
  return surface;
}
