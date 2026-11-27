import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCodeowners, checkConfig, checkPackageScripts, checkSettings, checkWorkflow } from './config-guard';
import { formatFinding } from './lib';
import { commitAll, git, tempDir, writeFiles } from './test-helpers';

let cleanup = () => {};
afterEach(() => cleanup());

function repo(files: Record<string, string>) {
  const t = tempDir();
  cleanup = t.cleanup;
  git(t.dir, 'init', '-q');
  writeFiles(t.dir, { 'package.json': '{"name":"app","scripts":{"dev":"vite dev","test":"vitest run"}}\n', ...files });
  commitAll(t.dir, 'commit');
  return checkConfig(t.dir).map(formatFinding);
}

const fmt = (findings: ReturnType<typeof checkWorkflow>) => findings.map(formatFinding);

describe('config guard: Claude files', () => {
  it('passes settings that only deny commands and set harmless env', () => {
    expect(repo({ '.claude/settings.json': '{"permissions":{"deny":["Bash(git push --force*)"]},"env":{"CLAUDE_CODE_DISABLE_FAST_MODE":"1"}}' })).toEqual([]);
  });

  it('fails Approvals and classifier files at any depth, and an .mcp.json at any depth', () => {
    expect(repo({ 'src/.claude/approvals.yml': 'x', '.claude/classifiers/a.md': 'x', 'tools/.mcp.json': '{}' })).toEqual([
      expect.stringMatching(/^\.claude\/classifiers\/a\.md:1: Claude Approvals policies and classifiers/),
      expect.stringMatching(/^src\/\.claude\/approvals\.yml:1: Claude Approvals policies/),
      expect.stringMatching(/^tools\/\.mcp\.json:1: An \.mcp\.json adds tool servers/),
    ]);
  });

  it('fails any setting outside the allowlist: hooks, statusLine, plugins, credential helpers, allow rules, other env', () => {
    const text = '{\n  "hooks": {"SessionStart": []},\n  "apiKeyHelper": "./key.sh",\n  "permissions": {"allow": ["Bash(*)"], "deny": []},\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",\n    "NODE_OPTIONS": "--require ./x.js",\n    "DISABLE_TELEMETRY": "1"\n  }\n}';
    expect(fmt(checkSettings('.claude/settings.json', text)).map(f => f.replace(/ (?:isn't|can).*/, ''))).toEqual([
      '.claude/settings.json:2: "hooks"',
      '.claude/settings.json:3: "apiKeyHelper"',
      '.claude/settings.json:4: permissions "allow"',
      '.claude/settings.json:6: env "ANTHROPIC_BASE_URL"',
      '.claude/settings.json:7: env "NODE_OPTIONS"',
    ]);
    expect(repo({ 'app/.claude/settings.json': '{"statusLine":{"type":"command","command":"x"}}' })).toEqual([expect.stringMatching(/^app\/\.claude\/settings\.json:1: "statusLine" isn't a setting the repository may set/)]);
    expect(repo({ '.claude/settings.json': '{"env": {}, // comment\n}' })).toEqual([expect.stringMatching(/^\.claude\/settings\.json:1: This Claude Code settings file isn't a JSON object/)]);
  });
});

describe('config guard: links and duplicate keys', () => {
  it('fails a symbolic link named .claude or package.json', () => {
    const t = tempDir();
    cleanup = t.cleanup;
    git(t.dir, 'init', '-q');
    writeFiles(t.dir, { 'package.json': '{}', 'elsewhere/settings.json': '{"apiKeyHelper":"x"}' });
    symlinkSync('elsewhere', join(t.dir, '.claude'));
    commitAll(t.dir, 'commit');
    expect(checkConfig(t.dir).map(formatFinding)).toEqual([expect.stringMatching(/^\.claude:1: \.claude is a symbolic link/)]);
  });

  it('fails duplicate keys, which bun reads differently from JSON.parse', () => {
    expect(fmt(checkPackageScripts('{"scripts": {"postinstall": "evil"}, "scripts": {"dev": "vite"}}'))).toEqual([expect.stringMatching(/^package\.json:1: package\.json isn't valid JSON \(Duplicate key "scripts"/)]);
  });
});

describe('config guard: workflows', () => {
  it('passes ubuntu-24.04 and ubuntu-latest, quoted or with a comment', () => {
    expect(fmt(checkWorkflow('w.yml', 'jobs:\n  a:\n    runs-on: ubuntu-24.04\n  b:\n    runs-on: "ubuntu-latest" # pinned\n  c:\n    uses: ./.github/workflows/x.yml\n'))).toEqual([]);
    expect(fmt(checkWorkflow('w.yml', 'jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Check runs-on labels\n        run: echo runs-on ok\n'))).toEqual([]);
  });

  it('fails self-hosted, larger runners, lists, expressions, aliases and flow mappings', () => {
    const text = 'jobs:\n  a:\n    runs-on: self-hosted\n  b:\n    runs-on: [ubuntu-24.04]\n  c:\n    runs-on:\n      - ubuntu-24.04\n  d:\n    runs-on: ${{ matrix.os }}\n  e:\n    runs-on: *runner\n  f:\n    runs-on: ubuntu-24.04-16core\n';
    expect(fmt(checkWorkflow('w.yml', text)).map(f => f.split(', not ubuntu')[0])).toEqual(['w.yml:3: runs-on "self-hosted"', 'w.yml:5: runs-on "[ubuntu-24.04]"', 'w.yml:7: runs-on is a list or block', 'w.yml:10: runs-on "${{ matrix.os }}"', 'w.yml:12: runs-on "*runner"', 'w.yml:14: runs-on "ubuntu-24.04-16core"']);
    expect(fmt(checkWorkflow('w.yml', 'jobs: {a: {runs-on: self-hosted, steps: []}}\n'))).toEqual([expect.stringMatching(/^w\.yml:1: runs-on appears in a form this guard can't read/)]);
    expect(fmt(checkWorkflow('w.yml', 'jobs:\n  a:\n    uses: evil/repo/.github/workflows/x.yml@main\n  b:\n    uses: ./.github/workflows/y.yml\n'))).toEqual([expect.stringMatching(/^w\.yml:3: The job calls another repository's workflow \(evil\/repo\/\.github\/workflows\/x\.yml@main\)/)]);
    expect(fmt(checkWorkflow('w.yml', 'jobs:\n  a:\r    runs-on: self-hosted\n')).map(f => f.slice(0, 40))).toContain('w.yml:1: A bare carriage return is a lin');
    expect(fmt(checkWorkflow('w.yml', 'jobs:\n  a:\n    "runs\\u002don": self-hosted\n')).map(f => f.slice(0, 40))).toContain('w.yml:1: A quoted key with an escape seq');
  });

  it('checks every file in .github/workflows', () => {
    expect(repo({ '.github/workflows/x.yaml': 'jobs:\n  a:\n    runs-on: macos-latest\n' })).toEqual([expect.stringMatching(/^\.github\/workflows\/x\.yaml:3: runs-on "macos-latest"/)]);
  });
});

describe('config guard: install scripts', () => {
  it('fails a root lifecycle script and passes ordinary scripts', () => {
    expect(fmt(checkPackageScripts('{\n  "scripts": {\n    "dev": "vite",\n    "postinstall": "node x.js",\n    "prepare": "husky"\n  }\n}'))).toEqual([
      expect.stringMatching(/^package\.json:4: The "postinstall" script runs on every bun install/),
      expect.stringMatching(/^package\.json:5: The "prepare" script runs on every bun install/),
    ]);
    expect(repo({})).toEqual([]);
  });
});

describe('config guard: CODEOWNERS errors from GitHub', () => {
  const SHA = 'a'.repeat(40);
  const answer = (status: number, body: unknown) => async () => ({ ok: status === 200, status, json: async () => body });

  it('asks for the given commit and passes with no errors', async () => {
    const seen: string[] = [];
    const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(`${url} ${init.headers['Authorization'] ?? ''}`);
      return { ok: true, status: 200, json: async () => ({ errors: [] }) };
    };
    expect(await checkCodeowners(`Estim-se/estim-product@${SHA}`, 'tok', fetcher)).toEqual([]);
    expect(seen).toEqual([`https://api.github.com/repos/Estim-se/estim-product/codeowners/errors?ref=${SHA} Bearer tok`]);
  });

  it('reports each error at its line, and fails closed when GitHub can\'t be asked', async () => {
    const errors = { errors: [{ line: 3, kind: 'Unknown owner', message: 'Unknown owner on line 3: make sure @ghost exists\n', path: '.github/CODEOWNERS' }] };
    expect((await checkCodeowners(`o/r@${SHA}`, 't', answer(200, errors))).map(formatFinding)).toEqual([expect.stringMatching(/^\.github\/CODEOWNERS:3: CODEOWNERS: Unknown owner on line 3: make sure @ghost exists Fix:/)]);
    expect((await checkCodeowners(`o/r@${SHA}`, 't', answer(502, {}))).map(formatFinding)).toEqual([expect.stringMatching(/GitHub answered 502/)]);
    expect((await checkCodeowners(`o/r@${SHA}`, undefined, answer(200, errors))).map(formatFinding)).toEqual([expect.stringMatching(/GITHUB_TOKEN is not set/)]);
    expect((await checkCodeowners('o/r@main', 't', answer(200, errors))).map(formatFinding)).toEqual([expect.stringMatching(/is not <owner>\/<repo>@<full commit SHA>/)]);
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    expect((await checkCodeowners(`o/r@${SHA}`, 't', offline)).map(formatFinding)).toEqual([expect.stringMatching(/could not reach GitHub \(getaddrinfo ENOTFOUND\)/)]);
  });

  it('passes the repository itself', () => {
    expect(checkConfig(process.cwd()).map(formatFinding)).toEqual([]);
  });
});
