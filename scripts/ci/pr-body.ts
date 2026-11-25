// Pull request issue-link check (workflow pr-body.yml, job issue-link). The PR description must link an issue of this
// repository: "Closes", "Fixes", "Resolves" or "Part of" (any case) followed by #N or this repository's full issue URL.
// HTML comments do not count, nor does the template's bare "Closes #". #N must be an issue, not a pull request.
// Exempt only when the head repository is this repository and the head branch is lovable (a fork may name a branch
// lovable too). This file imports nothing local: the workflow runs the base branch's copy of it.
//
// Usage (all input through the environment): PR_BODY, PR_HEAD_REPO, PR_HEAD_REF, GITHUB_REPOSITORY, GH_TOKEN
//   bun scripts/ci/pr-body.ts
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export type IssueKind = 'issue' | 'pull_request' | 'missing';
export type Lookup = (repo: string, number: number) => IssueKind;
export type Input = { body: string; headRepo: string; headRef: string; repo: string };

/** Issue numbers the body links with a closing or "part of" keyword, outside HTML comments. */
export function linkedIssues(body: string, repo: string): number[] {
  const text = body.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const url = `https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/issues/`;
  const pattern = new RegExp(`(?<![\\w-])(?:closes|fixes|resolves|part\\s+of)\\s*:?\\s+(?:#(\\d+)|${url}(\\d+))(?![\\w/#-])`, 'gi');
  const numbers = [...text.matchAll(pattern)].map(m => Number(m[1] ?? m[2]));
  return [...new Set(numbers.filter(n => Number.isSafeInteger(n) && n > 0))];
}

export function checkPrBody(input: Input, lookup: Lookup): { ok: boolean; message: string } {
  if (input.headRepo === input.repo && input.headRef === 'lovable') return { ok: true, message: 'issue-link: the lovable branch of this repository is exempt.' };
  const how = `Add a line such as "Closes #123" or "Part of #123" (or https://github.com/${input.repo}/issues/123) to the PR description, outside HTML comments.`;
  const candidates = linkedIssues(input.body, input.repo);
  if (candidates.length === 0) return { ok: false, message: `PR description:1: no issue is linked. Fix: ${how}` };
  const problems: string[] = [];
  for (const n of candidates) {
    const kind = lookup(input.repo, n);
    if (kind === 'issue') return { ok: true, message: `issue-link: the PR links issue #${n}.` };
    problems.push(kind === 'pull_request' ? `#${n} is a pull request, not an issue` : `#${n} does not exist in ${input.repo}`);
  }
  return { ok: false, message: `PR description:1: ${problems.join('; ')}. Fix: link an existing issue of this repository. ${how}` };
}

/** Asks the GitHub API (gh with GH_TOKEN) whether #N is an issue, a pull request or missing. */
export const ghLookup: Lookup = (repo, number) => {
  const result = spawnSync('gh', ['api', `repos/${repo}/issues/${number}`], { encoding: 'utf8' });
  if (result.status !== 0) {
    if (/HTTP 404|HTTP 410/.test(result.stderr)) return 'missing';
    throw new Error(`gh api failed for #${number}: ${result.stderr.trim()}`);
  }
  const data = JSON.parse(result.stdout) as { pull_request?: unknown };
  return data.pull_request ? 'pull_request' : 'issue';
};

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  const env = process.env;
  const repo = env['GITHUB_REPOSITORY'] ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.log('::error::GITHUB_REPOSITORY is not set.');
    process.exit(1);
  }
  const result = checkPrBody({ body: env['PR_BODY'] ?? '', headRepo: env['PR_HEAD_REPO'] ?? '', headRef: env['PR_HEAD_REF'] ?? '', repo }, ghLookup);
  console.log(result.ok ? result.message : `::error title=issue-link::${result.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  if (!result.ok) console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
