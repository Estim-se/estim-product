import { afterEach, describe, expect, it } from 'vitest';
import { authenticates, checkEdgeFunctions, configOverrides, remappingKeys } from './edge-guard';
import { formatFinding } from './lib';
import { tempDir, writeFiles } from './test-helpers';

const COMPANY = `import { requireCompany } from "../_shared/auth.ts";\nDeno.serve(async (req) => { const auth = await requireCompany(req); return new Response("ok"); });\n`;
let cleanup = () => {};
afterEach(() => cleanup());

function repo(files: Record<string, string>) {
  const t = tempDir();
  cleanup = t.cleanup;
  writeFiles(t.dir, { 'scripts/ci/edge-guard-allowlist.json': '[]', 'supabase/functions/_shared/auth.ts': 'export {}', ...files });
  return t.dir;
}
const messages = (root: string) => checkEdgeFunctions(root).map(formatFinding);

describe('edge guard: authentication in index.ts', () => {
  it('passes a function that calls an imported guard', () => {
    expect(messages(repo({ 'supabase/functions/ok/index.ts': COMPANY }))).toEqual([]);
  });
  it('accepts every listed guard and the internal-key comparison', () => {
    expect(authenticates(`import { requireSystem } from '../_shared/system-auth.ts'; await requireSystem(req);`)).toBe(true);
    expect(authenticates(`import { startMessageJob } from '../_shared/message-job.ts'; await startMessageJob(req);`)).toBe(true);
    expect(authenticates(`import { env, verifyNylasSignature } from '../_shared/nylas.ts'; await verifyNylasSignature(raw, h, s);`)).toBe(true);
    expect(authenticates(`import * as auth from '../_shared/auth.ts'; await auth.requireCompany(req);`)).toBe(true);
    expect(authenticates(`const e = Deno.env.get("INTERNAL_FUNCTION_KEY") ?? ""; const s = req.headers.get("x-internal-key") ?? ""; if (!safeEqual(s, e)) return deny();`)).toBe(true);
  });
  it('fails a function without a guard call, naming file:line, the problem and the fix', () => {
    const out = messages(repo({ 'supabase/functions/open/index.ts': 'Deno.serve(() => new Response("hi"));\n' }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^supabase\/functions\/open\/index\.ts:1: Edge Function "open" never authenticates the caller\. Fix: Call requireCompany\(req\)/);
  });
  it('does not count a guard in a comment, a string, a local copy or from another module', () => {
    expect(authenticates(`// await requireCompany(req)\nDeno.serve(() => new Response("x"));`)).toBe(false);
    expect(authenticates(`/* requireCompany(req) */ const s = "requireCompany(req)";`)).toBe(false);
    expect(authenticates(`const requireCompany = (r: Request) => null; requireCompany(req);`)).toBe(false);
    expect(authenticates(`import { requireCompany } from './fake-auth.ts'; requireCompany(req);`)).toBe(false);
    expect(authenticates(`import type { requireCompany } from '../_shared/auth.ts'; requireCompany(req);`)).toBe(false);
    expect(authenticates(`const s = req.headers.get("x-internal-key");`)).toBe(false);
  });
});

describe('edge guard: entry files', () => {
  it('fails a function without index.ts', () => {
    expect(messages(repo({ 'supabase/functions/js/index.js': 'Deno.serve(() => new Response("x"));' }))).toEqual([
      expect.stringMatching(/^supabase\/functions\/js\/index\.ts:1: Edge Function "js" has no index\.ts\. Fix:/),
      expect.stringMatching(/^supabase\/functions\/js\/index\.js:1: Edge Function "js" has a second entry file "index\.js"\. Fix:/),
    ]);
  });
  it('fails other index files and JavaScript files anywhere in the function', () => {
    const out = messages(repo({ 'supabase/functions/f/index.ts': COMPANY, 'supabase/functions/f/index.tsx': '', 'supabase/functions/f/lib/x.mjs': '', 'supabase/functions/f/y.cjs': '', 'supabase/functions/f/z.jsx': '' }));
    expect(out).toHaveLength(4);
    expect(out.join('\n')).toContain('supabase/functions/f/lib/x.mjs:1: Edge Function "f" contains a JavaScript file');
  });
  it('ignores _shared', () => {
    expect(messages(repo({ 'supabase/functions/ok/index.ts': COMPANY, 'supabase/functions/_shared/helper.js': '' }))).toEqual([]);
  });
});

describe('edge guard: entry and import remapping', () => {
  it('fails entrypoint or import_map for a function in config.toml', () => {
    expect(configOverrides('[functions.a]\nverify_jwt = false\nentrypoint = "./x.js"\n[functions.b]\nimport_map = "./m.json"\n')).toEqual([{ line: 3, key: 'entrypoint' }, { line: 5, key: 'import_map' }]);
    expect(configOverrides('[functions]\na = { entrypoint = "x.ts" }\nfunctions.c.import_map = "m"\n')).toEqual([{ line: 2, key: 'entrypoint' }, { line: 3, key: 'import_map' }]);
    expect(configOverrides('[functions.a]\nverify_jwt = false # entrypoint = "x"\n[db]\nentrypoint = 1\n')).toEqual([]);
    const out = messages(repo({ 'supabase/functions/ok/index.ts': COMPANY, 'supabase/config.toml': '[functions.ok]\nentrypoint = "./other.ts"\n' }));
    expect(out).toEqual([expect.stringMatching(/^supabase\/config\.toml:2: A function sets entrypoint, .* Fix: Remove entrypoint/)]);
  });
  it('fails imports, scopes or importMap in deno.json, deno.jsonc and import_map.json', () => {
    expect(remappingKeys('{\n  // comment "imports"\n  "imports": { "a": "b" },\n}')).toEqual([{ key: 'imports', line: 3 }]);
    expect(remappingKeys('{ "compilerOptions": {} }')).toEqual([]);
    expect(remappingKeys('{ not json')).toBeNull();
    const out = messages(repo({ 'supabase/functions/ok/index.ts': COMPANY, 'supabase/functions/deno.jsonc': '{\n "scopes": {}\n}', 'supabase/functions/ok/import_map.json': '{"imports":{}}', 'supabase/functions/_shared/deno.json': '{"importMap":"./m.json"}' }));
    expect(out).toEqual([
      expect.stringMatching(/^supabase\/functions\/_shared\/deno\.json:1: deno\.json has "importMap"/),
      expect.stringMatching(/^supabase\/functions\/deno\.jsonc:2: deno\.jsonc has "scopes"/),
      expect.stringMatching(/^supabase\/functions\/ok\/import_map\.json:1: import_map\.json has "imports"/),
    ]);
  });
});

describe('edge guard: allowlist', () => {
  it('exempts a listed function and requires a reason', () => {
    const open = 'Deno.serve(() => new Response("public"));';
    expect(messages(repo({ 'supabase/functions/open/index.ts': open, 'scripts/ci/edge-guard-allowlist.json': '[{"function":"open","rule":"auth-call","reason":"Public health check."}]' }))).toEqual([]);
    expect(messages(repo({ 'supabase/functions/open/index.ts': open, 'scripts/ci/edge-guard-allowlist.json': '[{"function":"open","rule":"auth-call","reason":" "}]' }))).toEqual([
      expect.stringMatching(/^scripts\/ci\/edge-guard-allowlist\.json:1: Entry 1 has no reason\./),
      expect.stringMatching(/^supabase\/functions\/open\/index\.ts:1: /),
    ]);
  });
  it('fails a stale or unknown entry', () => {
    const out = messages(repo({ 'supabase/functions/ok/index.ts': COMPANY, 'scripts/ci/edge-guard-allowlist.json': '[{"function":"gone","rule":"auth-call","reason":"x"},{"function":"ok","rule":"config","reason":"x"}]' }));
    expect(out.join('\n')).toContain('Unknown rule "config"');
    expect(out.join('\n')).toContain('The exception for "gone" (auth-call) is not needed.');
  });
});
