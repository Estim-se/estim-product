// Config guard: files that change what runs, or who pays, outside the code review sees. It reads the commit through
// git (never the working tree) and fails on:
// - Claude Approvals or classifier files (.claude/approvals.yml or .yaml, anything under .claude/classifiers/), at any
//   depth: hosted Approvals can bill the organisation;
// - an .mcp.json at any depth: it adds tool servers to every Claude Code session opened in the repository;
// - a .claude/settings*.json at any depth that sets a credential or endpoint: apiKeyHelper, awsAuthRefresh,
//   awsCredentialExport or otelHeadersHelper (each runs a command), or an env variable named ANTHROPIC_*,
//   CLAUDE_CODE_USE_* or *_BASE_URL. These redirect a developer's token or billing. A file that isn't valid JSON fails;
// - a workflow job whose runs-on isn't ubuntu-24.04 or ubuntu-latest written out: self-hosted and larger runners run
//   jobs elsewhere or cost money, and lists, expressions and aliases can hide either;
// - an install lifecycle script in the root package.json (preinstall, install, postinstall, prepare and the like): bun
//   runs it on every laptop's bun install, with the checkout's .env files loaded.
// With --codeowners <owner/repo>@<ref> and GITHUB_TOKEN, it also asks GitHub for CODEOWNERS errors at that commit: an
// owner GitHub can't resolve silently drops that line's review request.
//
// Usage: bun scripts/ci/config-guard.ts [--codeowners <owner/repo>@<sha>]
import { type Finding, git, isMain, lineAt, lineOf, report } from './lib.ts';

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'dependencies'];
const COMMAND_SETTINGS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];
const ENV_PATTERN = /^(?:ANTHROPIC_.*|CLAUDE_CODE_USE_.*|.*_BASE_URL)$/;
const RUNNERS = new Set(['ubuntu-24.04', 'ubuntu-latest']);

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const inClaudeDir = (path: string) => path.startsWith('.claude/') || path.includes('/.claude/');

function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) as unknown };
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
  for (const key of COMMAND_SETTINGS) {
    if (key in settings) findings.push({ file: path, line: lineOf(text, `"${key}"`), problem: `"${key}" runs a command that supplies credentials or headers for every session.`, fix: 'Remove it. Credentials belong in each developer\'s own user settings, never in the repository.' });
  }
  const env = settings['env'];
  if (typeof env === 'object' && env !== null) {
    for (const name of Object.keys(env)) {
      if (ENV_PATTERN.test(name)) findings.push({ file: path, line: lineOf(text, `"${name}"`), problem: `env "${name}" can redirect a developer's token or billing to another endpoint or account.`, fix: 'Remove it from the repository settings.' });
    }
  }
  return findings;
}

export function checkWorkflow(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = [...text.matchAll(/^[ \t]*(?:-[ \t]+)?["']?runs-on["']?[ \t]*:(.*)$/gm)];
  // Any other mention outside a comment line (a flow mapping such as {runs-on: x}) is a form this check can't read.
  const mentions = text.split('\n').filter(l => !/^\s*#/.test(l) && l.includes('runs-on')).length;
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
  for (const path of git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD'], root).split('\0').filter(Boolean)) {
    const name = base(path);
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

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** CODEOWNERS errors at a commit, from GET /repos/{repo}/codeowners/errors. A failed request is a finding too. */
export async function checkCodeowners(target: string, token: string | undefined, fetcher: Fetch = fetch as unknown as Fetch): Promise<Finding[]> {
  const file = '.github/CODEOWNERS';
  const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})$/i.exec(target);
  if (!m) return [{ file, line: 1, problem: `"${target}" is not <owner>/<repo>@<full commit SHA>.`, fix: 'Pass --codeowners "$GITHUB_REPOSITORY@$GITHUB_SHA".' }];
  if (!token) return [{ file, line: 1, problem: 'GITHUB_TOKEN is not set, so the CODEOWNERS check could not ask GitHub.', fix: 'Give the step GITHUB_TOKEN: ${{ github.token }}.' }];
  try {
    const response = await fetcher(`https://api.github.com/repos/${m[1]}/codeowners/errors?ref=${m[2]}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
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
