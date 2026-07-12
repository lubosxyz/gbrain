/**
 * The slug taxonomy for "a page with no inbound link here is expected, not a
 * content gap" — pseudo-pages, auto-generated files, raw dumps, staging areas.
 *
 * A leaf module ON PURPOSE. Both `commands/orphans.ts` (the orphan report) and
 * `core/trusted-graph-coverage.ts` (the health metric) need this taxonomy, and
 * the engine imports the latter. Living here — importing nothing — keeps that
 * out of a cycle: an engine → trusted-graph-coverage → commands/orphans →
 * engine loop is exactly what a `commands/` module reaching back into engine
 * types created.
 */

/** Slug suffixes that are always auto-generated root files. */
export const AUTO_SUFFIX_PATTERNS = ['/_index', '/log'];

/** Page slugs that are pseudo-pages by convention. */
export const PSEUDO_SLUGS = new Set(['_atlas', '_index', '_stats', '_orphans', '_scratch', 'claude']);

/** Slug segment that marks raw sources. */
export const RAW_SEGMENT = '/raw/';

/** Slug prefixes where no inbound links is expected. */
export const DENY_PREFIXES = [
  'output/',
  'dashboards/',
  'scripts/',
  'templates/',
  'openclaw/config/',
];

/** First slug segments where no inbound links is expected. */
export const FIRST_SEGMENT_EXCLUSIONS = new Set(['scratch', 'thoughts', 'catalog', 'entities']);

/**
 * Returns true if a slug should be excluded from orphan reporting by default.
 * These are pages where having no inbound links is expected / not a content
 * problem. The single TS-side source of truth; `trusted-graph-coverage.ts`
 * generates its SQL predicate from the same constants and a parity test pins
 * the two evaluators together.
 */
export function shouldExclude(slug: string): boolean {
  // Pseudo-pages (exact match)
  if (PSEUDO_SLUGS.has(slug)) return true;

  // Auto-generated suffix patterns
  for (const suffix of AUTO_SUFFIX_PATTERNS) {
    if (slug.endsWith(suffix)) return true;
  }

  // Raw source slugs
  if (slug.includes(RAW_SEGMENT)) return true;

  // Deny-prefix slugs
  for (const prefix of DENY_PREFIXES) {
    if (slug.startsWith(prefix)) return true;
  }

  // First-segment exclusions
  const firstSegment = slug.split('/')[0];
  if (FIRST_SEGMENT_EXCLUSIONS.has(firstSegment)) return true;

  return false;
}
