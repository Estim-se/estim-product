import unittest

from gate.common import load
from gate.tiers import classify, estimate, glob_re

SPEC = load('tiers.json')


def tier(files):
    """files: path -> content as the PR leaves it."""
    changes = [{'path': p, 'status': 'M'} for p in files]
    return classify(changes, lambda c: files[c['path']].encode(), SPEC)


class TiersTest(unittest.TestCase):
    def test_globs(self):
        self.assertTrue(glob_re('**/*.sql').match('a.sql'))
        self.assertTrue(glob_re('**/*.sql').match('docs/x/a.sql'))
        self.assertTrue(glob_re('supabase/functions/**').match('supabase/functions/_shared/auth.ts'))
        self.assertFalse(glob_re('src/start.ts').match('src/start.tsx'))
        self.assertFalse(glob_re('src/*.ts').match('src/a/b.ts'))

    def test_risk_paths_content_and_sql_in_markdown(self):
        self.assertEqual(tier({'supabase/functions/x/index.ts': 'x'})[0], 'RISK')
        self.assertEqual(tier({'src/routes/api/public/receive.ts': 'x', 'README.md': '# a'})[0], 'RISK')
        self.assertEqual(tier({'docs/fix.sql': 'select 1'})[0], 'RISK')
        self.assertEqual(tier({'src/lib/x.ts': 'export const f = createServerFn({ method: "POST" })'}), ('RISK', ['src/lib/x.ts']))
        self.assertEqual(tier({'docs/plan.md': 'Run this:\n\n```sql\nalter table quotes add column x int;\n```\n'})[0], 'RISK')
        self.assertEqual(tier({'docs/plan.md': 'Then ALTER TABLE quotes ADD x;'})[0], 'LITE')  # mid-sentence prose is not SQL
        self.assertEqual(tier({'docs/plan.md': 'create policy "x" on quotes using (true);'})[0], 'RISK')

    def test_generated_types_are_light_not_risky(self):
        self.assertEqual(tier({'src/integrations/supabase/types.ts': 'export type X = 1'})[0], 'LITE')
        self.assertEqual(tier({'src/integrations/supabase/client.server.ts': 'x'})[0], 'RISK')

    def test_lite_needs_every_file_light(self):
        self.assertEqual(tier({'README.md': '# a', 'bun.lock': '{}'})[0], 'LITE')
        self.assertEqual(tier({'README.md': '# a', 'src/lib/quote.ts': 'x'})[0], 'NORMAL')
        self.assertEqual(classify([], lambda c: b'', SPEC)[0], 'NORMAL')

    def test_estimate_grows_with_bytes_and_opus(self):
        small, large = estimate('NORMAL', 2_000, SPEC), estimate('NORMAL', 1_000_000, SPEC)
        self.assertLess(small, large)
        self.assertLess(small, SPEC['tiers']['NORMAL']['cap_usd'])
        self.assertGreater(large, SPEC['tiers']['NORMAL']['cap_usd'])  # ten large files: too large for one review
        self.assertGreater(estimate('RISK', 10_000, SPEC), estimate('NORMAL', 10_000, SPEC))
