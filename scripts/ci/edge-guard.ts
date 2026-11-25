// Edge Function guard. Every function directory in supabase/functions/ (all but _shared) must:
// - have index.ts as its only entry: no other index.* file and no JavaScript file anywhere in the directory;
// - authenticate in index.ts: call requireCompany(, requireSystem(, startMessageJob( or verifyNylasSignature( imported
//   from its _shared module, or compare the x-internal-key header with the INTERNAL_FUNCTION_KEY setting.
// Also, nothing may move the entry or remap imports: supabase/config.toml may not set entrypoint or import_map for a
// function, and no deno.json, deno.jsonc or import_map.json under supabase/functions may have imports, scopes or
// importMap. Exceptions only through scripts/ci/edge-guard-allowlist.json, each with a reason.
//
// Usage: bun scripts/ci/edge-guard.ts [--root <repo>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { type Finding, isMain, lineOf, readAllowlist, report } from './lib.ts';

export const ALLOWLIST = 'scripts/ci/edge-guard-allowlist.json';
const RULES = ['auth-call', 'entry-files'] as const;
type Rule = (typeof RULES)[number];

/** Each accepted guard call and the only module it may come from (as written in a function's index.ts). */
export const GUARD_IMPORTS: Record<string, string> = {
  requireCompany: '../_shared/auth.ts',
  requireSystem: '../_shared/system-auth.ts',
  startMessageJob: '../_shared/message-job.ts',
  verifyNylasSignature: '../_shared/nylas.ts',
};

const JS_FILE = /\.(?:js|mjs|cjs|jsx)$/i;
const toPosix = (p: string) => p.split(sep).join('/');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const stringValue = (node: ts.Node | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/** Whether index.ts authenticates: an accepted guard call (correctly imported) or the internal-key comparison. */
export function authenticates(source: string): boolean {
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const locals = new Map<string, string>(); // local name -> guard name
  const namespaces = new Map<string, string>(); // namespace -> module
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) namespaces.set(clause.namedBindings.name.text, from);
    else for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (GUARD_IMPORTS[imported] === from) locals.set(element.name.text, imported);
    }
  }
  let guardCall = false, headerRead = false, keyRead = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && locals.has(callee.text)) guardCall = true;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const module = namespaces.get(callee.expression.text);
        if (module !== undefined && GUARD_IMPORTS[callee.name.text] === module) guardCall = true;
      }
      // <request>.headers.get("x-internal-key") and Deno.env.get("INTERNAL_FUNCTION_KEY")
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'get') {
        const target = callee.expression, arg = stringValue(node.arguments[0]);
        if (ts.isPropertyAccessExpression(target) && target.name.text === 'headers' && arg?.toLowerCase() === 'x-internal-key') headerRead = true;
        if (target.getText(file).replace(/\s/g, '') === 'Deno.env' && arg === 'INTERNAL_FUNCTION_KEY') keyRead = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return guardCall || (headerRead && keyRead);
}

/** Lines of supabase/config.toml that set entrypoint or import_map for a function. */
export function configOverrides(toml: string): { line: number; key: string }[] {
  const hits: { line: number; key: string }[] = [];
  let section = '';
  toml.split('\n').forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      section = (header[1] ?? '').replace(/\s/g, '').replace(/"/g, '');
      return;
    }
    const assignment = /^([A-Za-z0-9_."'\s-]+?)\s*=(.*)$/.exec(line);
    if (!assignment) return;
    const key = (assignment[1] ?? '').replace(/\s/g, '').replace(/["']/g, '');
    const path = section ? `${section}.${key}` : key;
    if (!/^functions(\.|$)/.test(path)) return;
    const lastKey = path.split('.').pop() ?? '';
    const inline = /\b(entrypoint|import_map)\s*=/.exec(assignment[2] ?? '');
    if (lastKey === 'entrypoint' || lastKey === 'import_map') hits.push({ line: index + 1, key: lastKey });
    else if (inline) hits.push({ line: index + 1, key: inline[1] ?? '' });
  });
  return hits;
}

/** Top-level keys of a deno.json(c) or import map that remap imports, with their lines. */
export function remappingKeys(text: string): { key: string; line: number }[] | null {
  // JSONC: drop comments outside strings and trailing commas, keeping offsets for line numbers.
  let clean = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      clean += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { clean += ' '; i++; }
      clean += text[i] ?? '';
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      clean += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else clean += c;
  }
  let data: unknown;
  try {
    data = JSON.parse(clean.replace(/,(\s*[}\]])/g, ' $1'));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  return ['imports', 'scopes', 'importMap'].filter(key => key in data).map(key => ({ key, line: lineOf(clean, `"${key}"`) }));
}

export function checkEdgeFunctions(root: string): Finding[] {
  const findings: Finding[] = [];
  const functionsDir = join(root, 'supabase', 'functions');
  const rel = (p: string) => toPosix(relative(root, p));
  const allow = readAllowlist(join(root, ALLOWLIST), ALLOWLIST, ['function', 'rule'] as const);
  findings.push(...allow.findings);
  for (const entry of allow.entries) {
    if (!(RULES as readonly string[]).includes(entry.rule)) findings.push({ file: ALLOWLIST, line: entry.line, problem: `Unknown rule "${entry.rule}".`, fix: `Use one of: ${RULES.join(', ')}. Config and import-map rules have no exceptions.` });
  }
  const used = new Set<(typeof allow.entries)[number]>();
  const allowed = (fn: string, rule: Rule) => {
    const hit = allow.entries.find(e => e.function === fn && e.rule === rule);
    if (hit) used.add(hit);
    return hit !== undefined;
  };
  if (!existsSync(functionsDir)) return findings;

  for (const name of readdirSync(functionsDir).sort()) {
    const dir = join(functionsDir, name);
    if (name === '_shared' || !statSync(dir).isDirectory()) continue;
    const files = walk(dir);
    const index = join(dir, 'index.ts');
    if (!allowed(name, 'entry-files')) {
      if (!existsSync(index)) findings.push({ file: rel(index), line: 1, problem: `Edge Function "${name}" has no index.ts.`, fix: 'Add index.ts as its only entry file (TypeScript, Deno.serve).' });
      for (const file of files) {
        const base = file.slice(dir.length + 1);
        if (/^index\./i.test(base) && base !== 'index.ts') findings.push({ file: rel(file), line: 1, problem: `Edge Function "${name}" has a second entry file "${base}".`, fix: 'Keep index.ts as the only entry: rename or remove this file.' });
        else if (JS_FILE.test(base)) findings.push({ file: rel(file), line: 1, problem: `Edge Function "${name}" contains a JavaScript file; the guard checks TypeScript entries only.`, fix: 'Convert it to TypeScript (.ts) or remove it.' });
      }
    }
    if (existsSync(index) && !allowed(name, 'auth-call') && !authenticates(readFileSync(index, 'utf8'))) {
      findings.push({ file: rel(index), line: 1, problem: `Edge Function "${name}" never authenticates the caller.`, fix: `Call requireCompany(req), requireSystem(req), startMessageJob(req) or verifyNylasSignature(...) imported from ${[...new Set(Object.values(GUARD_IMPORTS))].join(', ')}, or compare req.headers.get("x-internal-key") with Deno.env.get("INTERNAL_FUNCTION_KEY"). A public function needs an entry with a reason in ${ALLOWLIST}.` });
    }
  }

  const configPath = join(root, 'supabase', 'config.toml');
  if (existsSync(configPath)) {
    for (const hit of configOverrides(readFileSync(configPath, 'utf8'))) {
      findings.push({ file: 'supabase/config.toml', line: hit.line, problem: `A function sets ${hit.key}, which moves its entry or remaps its imports past this guard.`, fix: `Remove ${hit.key}; functions use the default index.ts and plain relative or npm: imports.` });
    }
  }
  for (const file of walk(functionsDir)) {
    const base = file.slice(file.lastIndexOf(sep) + 1);
    if (!['deno.json', 'deno.jsonc', 'import_map.json'].includes(base)) continue;
    const text = readFileSync(file, 'utf8');
    const keys = remappingKeys(text);
    if (keys === null) findings.push({ file: rel(file), line: 1, problem: `${base} cannot be parsed, so it may remap imports.`, fix: 'Make it valid JSON(C) without imports, scopes or importMap, or remove it.' });
    else for (const k of keys) findings.push({ file: rel(file), line: k.line, problem: `${base} has "${k.key}", which can remap the guard modules.`, fix: `Remove "${k.key}"; import _shared modules by relative path and packages with npm: specifiers.` });
  }

  for (const entry of allow.entries) {
    if ((RULES as readonly string[]).includes(entry.rule) && !used.has(entry)) {
      findings.push({ file: ALLOWLIST, line: entry.line, problem: `The exception for "${entry.function}" (${entry.rule}) is not needed.`, fix: 'Remove the stale entry so a future function with that name is checked.' });
    }
  }
  return findings;
}

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--root');
  const root = at > 0 ? (process.argv[at + 1] ?? process.cwd()) : process.cwd();
  process.exit(report('edge-guard', checkEdgeFunctions(root)));
}

