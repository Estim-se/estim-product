import { describe, expect, it } from 'vitest';
import { checkPrBody, linkedIssues, type IssueKind } from './pr-body';

const REPO = 'Estim-se/estim-product';
const kinds: Record<number, IssueKind> = { 38: 'issue', 59: 'pull_request' };
const lookup = (_repo: string, n: number): IssueKind => kinds[n] ?? 'missing';
const check = (body: string, headRepo = REPO, headRef = 'feature/x') => checkPrBody({ body, headRepo, headRef, repo: REPO }, lookup);

describe('issue-link: which links count', () => {
  it('accepts closes, fixes, resolves and part of, in any case, with #N or the full issue URL', () => {
    expect(linkedIssues('Closes #1', REPO)).toEqual([1]);
    expect(linkedIssues('FIXES #2\nresolves: #3', REPO)).toEqual([2, 3]);
    expect(linkedIssues('This is Part  of #4.', REPO)).toEqual([4]);
    expect(linkedIssues(`part of https://github.com/${REPO}/issues/5`, REPO)).toEqual([5]);
  });
  it('ignores HTML comments, the bare template line, other repositories and other words', () => {
    expect(linkedIssues('<!-- Closes #1 -->\nCloses #\n<!-- unterminated Closes #2', REPO)).toEqual([]);
    expect(linkedIssues('Closes https://github.com/other/repo/issues/3', REPO)).toEqual([]);
    expect(linkedIssues('Encloses #4, see #5, closes #6abc, closes other/repo#7', REPO)).toEqual([]);
    expect(linkedIssues(`closes https://github.com/${REPO}/pull/8`, REPO)).toEqual([]);
  });
});

describe('issue-link: the check', () => {
  it('passes when the body links an existing issue', () => {
    expect(check('Part of #38.')).toEqual({ ok: true, message: 'issue-link: the PR links issue #38.' });
    expect(check('Closes #999\nPart of #38').ok).toBe(true);
  });
  it('fails without a link, naming where and how to fix it', () => {
    const result = check('<!-- Closes #38 -->\nCloses #');
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`PR description:1: no issue is linked. Fix: Add a line such as "Closes #123" or "Part of #123" (or https://github.com/${REPO}/issues/123) to the PR description, outside HTML comments.`);
  });
  it('fails a link to a pull request or a missing issue', () => {
    expect(check('Closes #59').message).toMatch(/^PR description:1: #59 is a pull request, not an issue\. Fix:/);
    expect(check('Closes #999').message).toMatch(/^PR description:1: #999 does not exist in Estim-se\/estim-product\. Fix:/);
  });
  it('exempts only the lovable branch of this repository, not a fork branch named lovable', () => {
    expect(check('', REPO, 'lovable').ok).toBe(true);
    expect(check('', 'someone/estim-product', 'lovable').ok).toBe(false);
    expect(check('', REPO, 'lovable-fix').ok).toBe(false);
  });
});
