// Config guard: files that change what runs, or who pays, outside the code review sees. It reads the commit through
// git (never the working tree) and fails on:
// - Claude Approvals or classifier files (.claude/approvals.yml or .yaml, anything under .claude/classifiers/), at any
//   depth: hosted Approvals can bill the organisation;
// - an .mcp.json at any depth: it adds tool servers to every Claude Code session opened in the repository;
// - a .claude/settings*.json at any depth that sets anything but $schema, fastMode, includeCoAuthoredBy, permissions
//   deny, ask and disableBypassPermissionsMode, and env variables named DISABLE_* or CLAUDE_CODE_DISABLE_*. Hooks,
//   statusLine, plugins, credential helpers, allow rules and other variables can run commands or redirect a
//   developer's token, billing or prompts. A file that isn't strict JSON (duplicate keys) fails;
// - a workflow job whose runs-on isn't ubuntu-24.04 or ubuntu-latest written out: self-hosted and larger runners run
//   jobs elsewhere or cost money, and lists, expressions and aliases can hide either. A job that calls another
//   repository's workflow, a bare carriage return and an escaped quoted key fail too;
// - an install lifecycle script in the root package.json (preinstall, install, postinstall, prepare and the like): bun
//   runs it on every laptop's bun install, with the checkout's .env files loaded. Duplicate keys fail;
// - a symbolic link named .claude, .github, .mcp.json, package.json or settings*.json, which would hide its target.
// With --codeowners <owner/repo>@<ref> and GITHUB_TOKEN, it also asks GitHub for CODEOWNERS errors at that commit: an
// owner GitHub can't resolve silently drops that line's review request.
//
// Usage: bun scripts/ci/config-guard.ts [--codeowners <owner/repo>@<sha>]
import { type Finding, git, isMain, lineAt, lineOf, report } from './lib.ts';
import { parseLockText } from './lockfile-guard.ts';

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'dependencies'];
// Repository settings may only turn things off or deny them. Everything else (hooks, statusLine, plugins, credential
// helpers, allow rules, endpoints) can run commands or redirect requests in every developer's session.
const SETTINGS_KEYS = new Set(['$schema', 'permissions', 'env', 'fastMode', 'includeCoAuthoredBy']);
const PERMISSION_KEYS = new Set(['deny', 'ask', 'disableBypassPermissionsMode']);
const ENV_NAME = /^(?:CLAUDE_CODE_)?DISABLE_[A-Z0-9_]+$/;
// A symbolic link with one of these names would hand the guard the link, not the file or directory it points to.
const NO_LINKS = /(?:^|\/)(?:\.claude|\.github|\.mcp\.json|package\.json|settings[^/]*\.json)$/;
const RUNNERS = new Set(['ubuntu-24.04', 'ubuntu-latest']);

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const inClaudeDir = (path: string) => path.startsWith('.claude/') || path.includes('/.claude/');

// Strict: duplicate keys fail, because bun and Claude Code may read the first where JSON.parse reads the last.
function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: parseLockText(text) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function checkSettings(path: string, text: string): Finding[] {
  const parsed = parseJson(text);
  if (parsed.error !== undefined || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return [{ file: path, line: 1, problem: `This Claude Code settings file isn't a JSON object (${parsed.error ?? 'wrong type'}), so the guard can't check it.`, fix: 'Make it a valid JSON object.' }];
  }
  const settings = parsed.value as Record<string, unknown>;
  const findings: Finding[] = [];
  const fix = 'Keep it in your own user settings. A new repository setting needs a reviewed change to scripts/ci/config-guard.ts.';
  for (const key of Object.keys(settings)) {
    if (!SETTINGS_KEYS.has(key)) findings.push({ file: path, line: lineOf(text, `"${key}"`), problem: `"${key}" isn't a setting the repository may set: it can run commands, load plugins or change where requests go in every developer's session.`, fix });
  }
  for (const key of Object.keys(record(settings['permissions']))) {
    if (!PERMISSION_KEYS.has(key)) findings.push({ file: path, line: lineOf(text, `"${key}"`), problem: `permissions "${key}" isn't allowed in the repository: only deny, ask and disableBypassPermissionsMode, which take rights away.`, fix });
  }
  for (const name of Object.keys(record(settings['env']))) {
    if (!ENV_NAME.test(name)) findings.push({ file: path, line: lineOf(text, `"${name}"`), problem: `env "${name}" isn't a DISABLE_ variable; other variables can load code, carry credentials or redirect a developer's token, billing or prompts.`, fix });
  }
  return findings;
}

export function checkWorkflow(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  if (/\r(?!\n)/.test(text)) findings.push({ file: path, line: 1, problem: 'A bare carriage return is a line break to YAML but not to this guard.', fix: 'Save the file with \\n line endings.' });
  if (/^[ \t]*(?:-[ \t]+)?"[^"\n]*\\[^"\n]*"[ \t]*:/m.test(text)) findings.push({ file: path, line: 1, problem: 'A quoted key with an escape sequence can spell runs-on or uses in a form this guard can\'t read.', fix: 'Write keys plainly.' });
  for (const m of text.matchAll(/^[ \t]*(?:-[ \t]+)?uses[ \t]*:[ \t]*["']?([^"'\s#]+)/gm)) {
    const target = m[1] ?? '';
    if (target.includes('.github/workflows/') && !target.startsWith('./')) findings.push({ file: path, line: lineAt(text, m.index ?? 0), problem: `The job calls another repository's workflow (${target}), whose jobs pick their own runners.`, fix: 'Call only workflows in this repository (uses: ./.github/workflows/...).' });
  }
  const lines = [...text.matchAll(/^[ \t]*(?:-[ \t]+)?["']?runs-on["']?[ \t]*:(.*)$/gm)];
  // Any other mention outside a comment line (a flow mapping such as {runs-on: x}) is a form this check can't read.
  const mentions = text.split('\n').filter(l => !/^\s*#/.test(l) && /runs-on["']?\s*:/.test(l)).length;
  if (mentions > lines.length) findings.push({ file: path, line: 1, problem: 'runs-on appears in a form this guard can\'t read (a flow mapping or similar).', fix: 'Write each job\'s runs-on as its own line: runs-on: ubuntu-24.04.' });
  for (const m of lines) {
    const raw = (m[1] ?? '').replace(/[ \t]#.*$/, '').trim();
    const value = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
    if (RUNNERS.has(value)) continue;
    findings.push({ file: path, line: lineAt(text, m.index ?? 0), problem: `runs-on ${raw === '' ? 'is a list or block' : JSON.stringify(raw)}, not ubuntu-24.04 or ubuntu-latest written out.`, fix: 'Use runs-on: ubuntu-24.04. Another runner needs a reviewed change to scripts/ci/config-guard.ts.' });
  }
  return findings;
}

export function checkPackageScripts(text: string): Finding[] {
  const parsed = parseJson(text);
  const scripts = (parsed.value as { scripts?: unknown } | undefined)?.scripts;
  if (parsed.error !== undefined) return [{ file: 'package.json', line: 1, problem: `package.json isn't valid JSON (${parsed.error}).`, fix: 'Fix the JSON.' }];
  if (typeof scripts !== 'object' || scripts === null) return [];
  const at = text.indexOf('"scripts"');
  return LIFECYCLE.filter(name => name in scripts).map(name => ({
    file: 'package.json',
    line: lineOf(text, `"${name}"`, Math.max(at, 0)),
    problem: `The "${name}" script runs on every bun install, on every laptop, with the checkout's .env files loaded.`,
    fix: 'Remove it, or run the step by hand as a named script. An install script needs a reviewed change to scripts/ci/config-guard.ts.',
  }));
}

export function checkConfig(root: string): Finding[] {
  const findings: Finding[] = [];
  const read = (path: string) => git(['cat-file', 'blob', `HEAD:${path}`], root);
  for (const line of git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], root).split('\0').filter(Boolean)) {
    // <mode> <type> <sha>\t<path>
    const mode = line.slice(0, line.indexOf(' '));
    const path = line.slice(line.indexOf('\t') + 1);
    const name = base(path);
    if (mode === '120000' && NO_LINKS.test(path)) {
      findings.push({ file: path, line: 1, problem: `${path} is a symbolic link, so the guard would read the link, not what Claude Code, bun or GitHub read.`, fix: 'Commit it as a regular file or directory.' });
      continue;
    }
    if (inClaudeDir(path) && (/(?:^|\/)\.claude\/approvals\.ya?ml$/.test(path) || /(?:^|\/)\.claude\/classifiers\//.test(path))) {
      findings.push({ file: path, line: 1, problem: 'Claude Approvals policies and classifiers turn on a hosted review that can bill the organisation.', fix: 'Delete the file. The review gate is .github/workflows/review*.yml.' });
    } else if (name === '.mcp.json') {
      findings.push({ file: path, line: 1, problem: 'An .mcp.json adds tool servers to every Claude Code session opened in this repository.', fix: 'Delete it and configure MCP servers in your own user settings.' });
    } else if (inClaudeDir(path) && /^settings.*\.json$/.test(name) && /(?:^|\/)\.claude\/[^/]+$/.test(path)) {
      findings.push(...checkSettings(path, read(path)));
    } else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) {
      findings.push(...checkWorkflow(path, read(path)));
    } else if (path === 'package.json') {
      findings.push(...checkPackageScripts(read(path)));
    }
  }
  return findings;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** CODEOWNERS errors at a commit, from GET /repos/{repo}/codeowners/errors. A failed request is a finding too. */
export async function checkCodeowners(target: string, token: string | undefined, fetcher: Fetch = fetch as unknown as Fetch): Promise<Finding[]> {
  const file = '.github/CODEOWNERS';
  const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})$/i.exec(target);
  if (!m) return [{ file, line: 1, problem: `"${target}" is not <owner>/<repo>@<full commit SHA>.`, fix: 'Pass --codeowners "$GITHUB_REPOSITORY@$GITHUB_SHA".' }];
  if (!token) return [{ file, line: 1, problem: 'GITHUB_TOKEN is not set, so the CODEOWNERS check could not ask GitHub.', fix: 'Give the step GITHUB_TOKEN: ${{ github.token }}.' }];
  try {
    const response = await fetcher(`https://api.github.com/repos/${m[1]}/codeowners/errors?ref=${m[2]}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return [{ file, line: 1, problem: `GitHub answered ${response.status} for the CODEOWNERS errors, so they could not be checked.`, fix: 'Run ci again; if it persists, check the file in the GitHub UI.' }];
    const errors = (await response.json() as { errors?: unknown }).errors;
    if (!Array.isArray(errors)) return [{ file, line: 1, problem: 'GitHub\'s answer had no errors list.', fix: 'Run ci again.' }];
    return errors.map(e => {
      const error = e as { line?: unknown; message?: unknown; kind?: unknown; path?: unknown };
      return { file: typeof error.path === 'string' ? error.path : file, line: typeof error.line === 'number' ? error.line : 1, problem: `CODEOWNERS: ${typeof error.message === 'string' ? error.message.trim() : String(error.kind ?? 'error')}`, fix: 'Fix the line: every owner must be a user or team with write access, and the pattern valid.' };
    });
  } catch (error) {
    return [{ file, line: 1, problem: `The CODEOWNERS check could not reach GitHub (${(error as Error).message}).`, fix: 'Run ci again.' }];
  }
}

if (isMain(import.meta.url)) {
  const at = process.argv.indexOf('--codeowners');
  const findings = checkConfig(process.cwd());
  const remote = at > 0 ? checkCodeowners(process.argv[at + 1] ?? '', process.env['GITHUB_TOKEN']) : Promise.resolve([]);
  void remote.then(more => process.exit(report('config-guard', [...findings, ...more])));
}
