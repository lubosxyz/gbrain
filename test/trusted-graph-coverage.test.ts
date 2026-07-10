import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  computeTrustedGraphCoverage,
  computePagesBySurface,
  MIN_KNOWLEDGE_CHARS,
} from '../src/core/trusted-graph-coverage.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const BODY = 'x'.repeat(MIN_KNOWLEDGE_CHARS + 10);

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

describe('trusted_graph_coverage', () => {
  async function page(slug: string, extra: Record<string, unknown> = {}): Promise<void> {
    await engine.putPage(slug, {
      type: 'concept',
      title: slug,
      compiled_truth: BODY,
      timeline: '',
      ...extra,
    } as never);
  }

  test('a human-authored link covers both endpoints', async () => {
    await page('concepts/alpha');
    await page('concepts/beta');
    await engine.addLink('concepts/alpha', 'concepts/beta', 'ctx', 'references', 'markdown');

    const c = await computeTrustedGraphCoverage(engine);
    expect(c.eligible_pages).toBe(2);
    // Outbound counts too: a hub that only links out is in the graph.
    expect(c.covered_pages).toBe(2);
    expect(c.coverage).toBe(1);
  });

  test('an auto-linked mention is NOT a trusted edge', async () => {
    await page('concepts/alpha');
    await page('concepts/beta');
    await engine.addLink('concepts/alpha', 'concepts/beta', 'ctx', 'references', 'mentions');

    const c = await computeTrustedGraphCoverage(engine);
    expect(c.eligible_pages).toBe(2);
    expect(c.covered_pages).toBe(0);
    expect(c.coverage).toBe(0);
  });

  test('code pages are outside the denominator entirely', async () => {
    await page('concepts/alpha');
    await engine.putPage('code/thing-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'thing.ts',
      compiled_truth: BODY,
      timeline: '',
    } as never);

    const c = await computeTrustedGraphCoverage(engine);
    expect(c.eligible_pages).toBe(1);

    const surface = await computePagesBySurface(engine);
    expect(surface.prose).toBe(1);
    expect(surface.code).toBe(1);
  });

  test('raw captures are excluded until promoted out of inbox/', async () => {
    await page('inbox/2026-07-10-abc123');
    await page('concepts/alpha');

    const c = await computeTrustedGraphCoverage(engine);
    expect(c.eligible_pages).toBe(1);
    expect(c.excluded.raw_capture).toBe(1);

    const surface = await computePagesBySurface(engine);
    expect(surface.raw_capture).toBe(1);
    expect(surface.prose).toBe(1);
  });

  test('machine receipts, stubs and pseudo-pages leave the denominator', async () => {
    await page('extracts/run-1', { type: 'extract_receipt' });
    await page('concepts/stub', { compiled_truth: 'too short' });
    await page('_atlas');
    await page('concepts/alpha');

    const c = await computeTrustedGraphCoverage(engine);
    expect(c.eligible_pages).toBe(1);
    expect(c.excluded.machine_stub).toBe(1);
    expect(c.excluded.empty_or_boilerplate).toBe(1);
    expect(c.excluded.pseudo_or_auto).toBe(1);
  });

  test('an empty brain reports 0 coverage, not NaN', async () => {
    const c = await computeTrustedGraphCoverage(engine);
    expect(c.eligible_pages).toBe(0);
    expect(c.coverage).toBe(0);
  });

  test('getHealth surfaces the metric alongside the raw orphan count', async () => {
    await page('concepts/alpha');
    await page('concepts/beta');
    await engine.addLink('concepts/alpha', 'concepts/beta', 'ctx', 'references', 'markdown');
    await engine.putPage('code/thing-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'thing.ts',
      compiled_truth: BODY,
      timeline: '',
    } as never);

    const h = await engine.getHealth();
    // The code page is an "orphan" and always will be — it lives in the symbol
    // graph. That's precisely what makes orphan_pages the wrong north star.
    expect(h.orphan_pages).toBe(1);
    expect(h.trusted_graph_coverage).toBe(1);
    expect(h.trusted_graph_eligible_pages).toBe(2);
    expect(h.pages_by_surface).toEqual({ prose: 2, code: 1, image: 0, raw_capture: 0 });
  });
});
