#!/usr/bin/env bash
# CI guard: fail if any source file uses the buggy `${JSON.stringify(x)}::jsonb`
# template-string pattern instead of postgres.js's `sql.json(x)`.
#
# This is best-effort static analysis. It catches the common copy-paste form
# that caused the v0.12.0 silent-data-loss bug (JSONB columns stored as
# string literals on Postgres while PGLite hid the bug). Multi-line and
# helper-wrapped variants are NOT caught here — those are covered by
# test/e2e/postgres-jsonb.test.ts which round-trips actual writes through
# real Postgres and asserts `frontmatter->>'k'` returns objects, not strings.
#
# Usage: scripts/check-jsonb-pattern.sh
# Exit:  0 when no matches, 1 when matches found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Match the interpolated form: ${JSON.stringify(...)}::jsonb
# Using grep -P for Perl-compatible regex (lookahead-free pattern is enough here).
PATTERN='\$\{JSON\.stringify\([^)]*\)\}::jsonb'

if grep -rEn "$PATTERN" src/ 2>/dev/null; then
  echo
  echo "ERROR: Found JSON.stringify(...)::jsonb pattern in src/."
  echo "       postgres.js v3 stringifies again, producing JSONB string literals."
  echo "       Use sql.json(x) instead. See feedback_postgres_jsonb_double_encode.md."
  exit 1
fi

echo "OK: no JSON.stringify(x)::jsonb interpolation pattern in src/"

# Positional form: an executeRaw / executeRawDirect call that binds a
# JSON.stringify(...) string param into a bare `$N::jsonb` cast. postgres.js
# describes the parameter as jsonb (via the cast) and serializes the already-
# stringified value AGAIN, producing a JSONB string scalar — silent corruption
# everywhere, and a hard CHECK failure on op_checkpoints.completed_keys. The
# interpolation check above does NOT catch this because the param is positional,
# not template-interpolated. Fix: pass the JS value directly (objects only;
# executeRawJsonb rejects top-level arrays) or cast `$N::text::jsonb` so Postgres
# parses the JSON text into real jsonb. `executeRawJsonb(...)` is exempt — it
# passes JS objects, not JSON.stringify, and the `executeRaw(` token below does
# not match `executeRawJsonb(`.
POSITIONAL_HITS=$(
  find src -name '*.ts' -not -path '*/node_modules/*' -print0 2>/dev/null \
  | xargs -0 perl -0777 -ne '
      while (/\bexecuteRaw(?:Direct)?\s*\(/g) {
        my $at = pos();
        my $win = substr($_, $at, 1200);
        $win =~ s/;.*//s;                       # bound to the statement
        next unless $win =~ /\$[0-9]+::jsonb/;   # bare positional jsonb (not ::text::jsonb)
        next unless $win =~ /JSON\.stringify\s*\(/;
        my $line = 1 + (substr($_, 0, $at) =~ tr/\n//);
        print "$ARGV:$line: executeRaw with bare \$N::jsonb + JSON.stringify (positional double-encode)\n";
      }
    ' 2>/dev/null
)
if [ -n "$POSITIONAL_HITS" ]; then
  echo "$POSITIONAL_HITS"
  echo
  echo "ERROR: positional JSON.stringify(...) bound to a bare \$N::jsonb cast."
  echo "       postgres.js re-stringifies it into a JSONB string scalar on Postgres."
  echo "       Pass the JS value directly, or cast \$N::text::jsonb."
  exit 1
fi
echo "OK: no positional JSON.stringify + \$N::jsonb double-encode pattern in src/"

# v0.13.1 #219: guard against max_stalled DEFAULT 1 regressing in any schema
# source file. DEFAULT 1 dead-lettered any SIGKILL'd job on first stall, making
# the "10/10 rescued" claim false for out-of-the-box users. Default is 5 now.
MAX_STALLED_PATTERN='max_stalled\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1\b'

if grep -rEn "$MAX_STALLED_PATTERN" src/schema.sql src/core/migrate.ts src/core/pglite-schema.ts src/core/schema-embedded.ts 2>/dev/null; then
  echo
  echo "ERROR: max_stalled DEFAULT 1 reintroduced in schema."
  echo "       Must be DEFAULT 5 to preserve SIGKILL-rescue guarantee. See #219."
  exit 1
fi

echo "OK: max_stalled defaults are 5 in all schema sources"
