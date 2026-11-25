// Edge Function guard. Every function directory in supabase/functions/ (all but _shared) must:
// - have index.ts as its only entry: no other index.* file and no JavaScript file anywhere in the directory;
// - authenticate in index.ts: call requireCompany(, requireSystem(, startMessageJob( or verifyNylasSignature( bound to
//   the import from its _shared module (not a local or parameter of the same name), or compare the x-internal-key
//   header with the INTERNAL_FUNCTION_KEY setting (=== / !==, or a call such as safeEqual(a, b)).
// Also, nothing may move the entry or remap imports: supabase/config.toml (read with a real TOML parser) may not set
// entrypoint or import_map for a function, and no deno.json, deno.jsonc or import_map.json anywhere in supabase/ or at
// the repository root may have imports, scopes or importMap. Exceptions only through
// scripts/ci/edge-guard-allowlist.json, each with a reason.
//
// This is a static heuristic: it does not prove the guard call runs (dead code passes), and it trusts the _shared
// modules, so those need review of their own.
//
// Usage: bun scripts/ci/edge-guard.ts [--root <repo>]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { type Finding, isMain, lineAt, lineOf, readAllowlist, report } from './lib.ts';

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

/** Parses index.ts into a one-file program (no lib, no module resolution) so names resolve to their declarations. */
function parse(source: string): { file: ts.SourceFile; checker: ts.TypeChecker } {
  const name = '/index.ts';
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host: ts.CompilerHost = {
    getSourceFile: f => (f === name ? file : undefined), fileExists: f => f === name, readFile: () => undefined, writeFile: () => {},
    getDefaultLibFileName: () => '/lib.d.ts', useCaseSensitiveFileNames: () => true, getCanonicalFileName: f => f, getCurrentDirectory: () => '/', getNewLine: () => '\n',
  };
  const program = ts.createProgram({ rootNames: [name], options: { noLib: true, noResolve: true, types: [] }, host });
  return { file: program.getSourceFile(name) ?? file, checker: program.getTypeChecker() };
}

const importOf = (declaration: ts.Declaration | undefined): ts.ImportDeclaration | undefined => {
  let node: ts.Node | undefined = declaration;
  while (node && !ts.isImportDeclaration(node)) node = node.parent;
  return node;
};
const moduleOf = (declaration: ts.ImportDeclaration) => (ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : '');

/** Whether a call's callee is one of the guards, bound to its import from the right _shared module. */
function isGuardCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const declaration = checker.getSymbolAtLocation(callee)?.declarations?.[0];
    if (!declaration || !ts.isImportSpecifier(declaration) || declaration.isTypeOnly) return false;
    const imp = importOf(declaration);
    const imported = (declaration.propertyName ?? declaration.name).text;
    return imp !== undefined && !imp.importClause?.isTypeOnly && GUARD_IMPORTS[imported] === moduleOf(imp);
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const declaration = checker.getSymbolAtLocation(callee.expression)?.declarations?.[0];
    if (!declaration || !ts.isNamespaceImport(declaration)) return false;
    const imp = importOf(declaration);
    return imp !== undefined && !imp.importClause?.isTypeOnly && GUARD_IMPORTS[callee.name.text] === moduleOf(imp);
  }
  return false;
}

type KeySide = 'header' | 'setting';
/** <request>.headers.get("x-internal-key") is the header; Deno.env.get("INTERNAL_FUNCTION_KEY") is the setting. */
function readOf(node: ts.Node, file: ts.SourceFile): KeySide | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'get') return null;
  const target = node.expression.expression, arg = stringValue(node.arguments[0]);
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'headers' && arg?.toLowerCase() === 'x-internal-key') return 'header';
  if (target.getText(file).replace(/\s/g, '') === 'Deno.env' && arg === 'INTERNAL_FUNCTION_KEY') return 'setting';
  return null;
}

/** Which key an expression carries: the read itself, through ?? / || defaults, casts, .trim() and local constants. */
function sideOf(node: ts.Expression, file: ts.SourceFile, checker: ts.TypeChecker, depth = 0): KeySide | null {
  if (depth > 8) return null;
  const next = (e: ts.Expression) => sideOf(e, file, checker, depth + 1);
  const direct = readOf(node, file);
  if (direct) return direct;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return next(node.expression);
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return next(node.left);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length === 0 && /^(trim|toString)$/.test(node.expression.name.text)) return next(node.expression.expression);
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isIdentifier(declaration.name)) return next(declaration.initializer);
  }
  return null;
}

const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const COMPARE_CALL = /equal|compare|match|verify/i;

/** Whether index.ts authenticates: an accepted guard call (bound to its import) or the internal-key comparison. */
export function authenticates(source: string): boolean {
  const { file, checker } = parse(source);
  let found = false;
  const pair = (a: ts.Expression, b: ts.Expression) => {
    const x = sideOf(a, file, checker), y = sideOf(b, file, checker);
    return x !== null && y !== null && x !== y;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      if (isGuardCall(node, checker)) found = true;
      // safeEqual(supplied, expected), timingSafeEqual(a, b): a call named for comparing, given both keys.
      const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (COMPARE_CALL.test(name) && node.arguments.some((a, i) => node.arguments.some((b, j) => i < j && pair(a, b)))) found = true;
    }
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind) && pair(node.left, node.right)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

type TomlParse = (text: string) => unknown;
/** Bun's built-in TOML parser; outside bun (vitest on Node) the same parser in a bun subprocess. */
export const parseToml: TomlParse = text => {
  const bun = (globalThis as { Bun?: { TOML: { parse(t: string): unknown } } }).Bun;
  if (bun) return bun.TOML.parse(text);
  const result = spawnSync('bun', ['-e', 'process.stdout.write(JSON.stringify(Bun.TOML.parse(await Bun.stdin.text())))'], { input: text, cwd: tmpdir(), encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'bun could not parse the TOML.');
  return JSON.parse(result.stdout) as unknown;
};

const OVERRIDE_KEYS = ['entrypoint', 'import_map'];
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The places where supabase/config.toml sets entrypoint or import_map anywhere under [functions], read with a real
 * TOML parser so quoted and escaped keys count. Throws when the file is not valid TOML.
 */
export function configOverrides(toml: string, parseTomlText: TomlParse = parseToml): { line: number; key: string }[] {
  const data = parseTomlText(toml);
  const functions = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['functions'] : undefined;
  const hits: { line: number; key: string }[] = [];
  // Best-effort line for a hit: where the key is written plainly, else the function's table, else line 1.
  const clean = toml.split('\n').map(l => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
  const lineFor = (key: string, fn: string) => {
    for (const needle of [new RegExp(String.raw`(?:^|[\s{,."'])${escapeRegExp(key)}["']?\s*=`, 'm'), new RegExp(String.raw`functions\s*\.\s*["']?${escapeRegExp(fn)}\b`)]) {
      const m = needle.exec(clean);
      if (m) return lineAt(clean, m.index + Math.max(0, m[0].search(/\S/)));
    }
    return 1;
  };
  const walk = (value: unknown, fn: string) => {
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (OVERRIDE_KEYS.includes(key)) hits.push({ line: lineFor(key, fn), key });
      walk(child, fn || key);
    }
  };
  walk(functions, '');
  return hits.sort((a, b) => a.line - b.line);
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

const DENO_CONFIGS = ['deno.json', 'deno.jsonc', 'import_map.json'];

export function checkEdgeFunctions(root: string, parseTomlText: TomlParse = parseToml): Finding[] {
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
  for (const name of existsSync(functionsDir) ? readdirSync(functionsDir).sort() : []) {
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
    let hits: { line: number; key: string }[] = [];
    try {
      hits = configOverrides(readFileSync(configPath, 'utf8'), parseTomlText);
    } catch (error) {
      findings.push({ file: 'supabase/config.toml', line: 1, problem: `config.toml cannot be parsed as TOML (${(error as Error).message.split('\n')[0]}), so it may set entrypoint or import_map.`, fix: 'Make it valid TOML.' });
    }
    for (const hit of hits) {
      findings.push({ file: 'supabase/config.toml', line: hit.line, problem: `A function sets ${hit.key}, which moves its entry or remaps its imports past this guard.`, fix: `Remove ${hit.key}; functions use the default index.ts and plain relative or npm: imports.` });
    }
  }
  // Deno also reads config files in parent directories, so look everywhere in supabase/ and at the root.
  const supabaseDir = join(root, 'supabase');
  const configFiles = [...(existsSync(supabaseDir) ? walk(supabaseDir) : []), ...DENO_CONFIGS.map(f => join(root, f)).filter(f => existsSync(f))];
  for (const file of configFiles) {
    const base = file.slice(file.lastIndexOf(sep) + 1);
    if (!DENO_CONFIGS.includes(base)) continue;
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

