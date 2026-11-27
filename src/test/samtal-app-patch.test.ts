// Required regression checks of the implemented Priority 1 V2 application behavior.
// A disposable source copy preserves import isolation; historical patches are not reapplied.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const A = '0000000a-0000-4000-8000-000000000000', B = '0000000b-0000-4000-8000-000000000000';
const CALL = 'c0000000-0000-4000-8000-000000000001', REQ = 'r0000000-0000-4000-8000-000000000001'.replace('r', 'e');
const ACTOR = 'a0000000-0000-4000-8000-00000000000a';

type Op = [string, ...unknown[]];
type Rpc = (args: Record<string, unknown>) => { data?: unknown; error?: unknown };
function fake(rows: (table: string, ops: Op[]) => { data?: unknown; error?: unknown; count?: number }, rpc: Record<string, unknown | Rpc> = {}) {
  const log = { queries: [] as { table: string; ops: Op[] }[], rpc: [] as { name: string; args: Record<string, unknown> }[], signed: [] as string[] };
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      log.rpc.push({ name, args });
      const r = rpc[name];
      if (typeof r === 'function') return { data: null, error: null, ...(r as Rpc)(args) };
      return name in rpc ? { data: r, error: null } : { data: null, error: { code: 'x' } };
    },
    storage: { from: () => ({ createSignedUrl: async (p: string) => { log.signed.push(p); return { data: { signedUrl: `https://signed/${p}` }, error: null }; } }) },
    from: (table: string) => {
      const ops: Op[] = []; log.queries.push({ table, ops });
      const result = () => ({ data: null, error: null, ...rows(table, ops) });
      const chain: Record<string, unknown> = new Proxy({}, { get: (_t, key: string) => {
        if (key === 'then') return (ok: (v: unknown) => void, fail: (e: unknown) => void) => Promise.resolve(result()).then(ok, fail);
        if (key === 'maybeSingle') return async () => { ops.push(['maybeSingle']); return result(); };
        return (...args: unknown[]) => { ops.push([key, ...args]); return chain; };
      } });
      return chain;
    },
  };
  return { client: client as never, log };
}
const owner = { my_company: A, samtal_is_owner: true }, employee = { my_company: A, samtal_is_owner: false };
const visible = (company = A, audio: string | null = `${A}/${CALL}.mp3`) => fake(() => ({ data: { id: CALL, company_id: company, audio_path: audio } }), owner);

let dir = '';
type Active = typeof import('@/lib/samtal/page.server');
let page: Pick<Active, 'loadSamtalPage'> & {
  samtalAudioLink: (u: never, a: never, callId: string, actor: string) => Promise<{ url: string; expires_in: number }>;
  startSamtalCall: (u: never, a: never, callId: string, actor: string) => Promise<{ started: boolean }>;
  reviewSamtalCall: (u: never, a: never, actor: string, i: { call_id: string; request_id: string; decision: 'business' | 'private' }) => Promise<{ decision: string; deletion_pending: boolean }> };
let labels: typeof import('@/lib/samtal/labels');

beforeAll(async () => {
  dir = mkdtempSync(path.join(ROOT, '.samtal-patch-preview-'));
  cpSync(path.join(ROOT, 'src/lib/samtal'), path.join(dir, 'src/lib/samtal'), { recursive: true });
  cpSync(path.join(ROOT, 'src/lib/input-limits.ts'), path.join(dir, 'src/lib/input-limits.ts'));
  cpSync(path.join(ROOT, 'src/components/estim/samtal-page.tsx'), path.join(dir, 'src/components/estim/samtal-page.tsx'));
  page = await import(/* @vite-ignore */ path.join(dir, 'src/lib/samtal/page.server.ts'));
  labels = await import(/* @vite-ignore */ path.join(dir, 'src/lib/samtal/labels.ts'));
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('the current-source fixture', () => {
  it('exercises the implemented guards without altering the active modules', () => {
    const active = readFileSync(path.join(ROOT, 'src/lib/samtal/page.server.ts'), 'utf8');
    expect(active).toContain('samtal_restart_guarded');
    expect(readFileSync(path.join(dir, 'src/lib/samtal/page.server.ts'), 'utf8')).toBe(active);
  });
  it('adds no handwritten type casts to bypass the missing V2 schema', () => {
    const added = readFileSync(path.join(ROOT, 'docs/samtal/priority-1-app-patch.diff'), 'utf8').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    expect(added.filter(l => /as (never|any|unknown)\b|@ts-(ignore|expect-error)/.test(l))).toEqual([]);
  });
});

describe('pending reviews on the page', () => {
  it('come from persisted review rows, bounded to the company and to calls the user already sees, and hide the title', async () => {
    const call = { id: CALL, user_id: 'u1', caller_phone: null, started_at: null, duration_seconds: 30, status: 'bearbetas', classification: 'osaker', error_code: 'uncertain_needs_review', thread_id: null, audio_path: `${A}/${CALL}.mp3`,
      extraction: { interpretation: { fields: { job_type: { value: 'laddbox' }, description: { value: 'Hemligt' } } } } };
    const user = fake((t, ops) => t === 'samtal_calls' && ops.some(o => o[0] === 'limit') ? { data: [call] } : t === 'samtal_calls' ? { count: 0 } : { data: [] }, owner);
    const admin = fake(t => t === 'company_members' ? { data: [] } : t === 'samtal_reviews' ? { data: [{ call_id: CALL }] } : { data: [] });
    const p = await page.loadSamtalPage(user.client, admin.client, ACTOR, { stt: true, ai: true });
    expect(p.calls[0]).toMatchObject({ id: CALL, needs_review: true, title: null });
    expect(JSON.stringify(p)).not.toContain('Hemligt');
    const q = admin.log.queries.find(x => x.table === 'samtal_reviews')!;
    expect(q.ops).toEqual(expect.arrayContaining([['eq', 'company_id', A], ['eq', 'decision', 'pending'], ['in', 'call_id', [CALL]]]));
  });
  it('a private call never offers its audio', async () => {
    const call = { id: CALL, user_id: 'u1', status: 'privat', classification: 'privat', audio_path: `${A}/${CALL}.mp3`, extraction: null };
    const user = fake((t, ops) => t === 'samtal_calls' && ops.some(o => o[0] === 'limit') ? { data: [call] } : { data: [] }, owner);
    const admin = fake(() => ({ data: [] }));
    expect((await page.loadSamtalPage(user.client, admin.client, ACTOR, { stt: true, ai: true })).calls[0]).toMatchObject({ has_audio: false, needs_review: false });
  });
});

describe('confirming a review', () => {
  const confirm = (user: ReturnType<typeof fake>, admin: ReturnType<typeof fake>, decision: 'business' | 'private' = 'business', actor = ACTOR, request_id = REQ) =>
    page.reviewSamtalCall(user.client, admin.client, actor, { call_id: CALL, request_id, decision });

  it('passes the verified actor and the session company, never browser values', async () => {
    const admin = fake(() => ({}), { samtal_confirm_review: true });
    expect(await confirm(visible(), admin)).toEqual({ decision: 'business', deletion_pending: false });
    expect(admin.log.rpc).toEqual([{ name: 'samtal_confirm_review', args: { p_call: CALL, p_company: A, p_actor: ACTOR, p_request: REQ, p_decision: 'business' } }]);
  });
  it('another company\'s call or an invisible call is rejected before any privileged call', async () => {
    const admin = fake(() => ({}), { samtal_confirm_review: true });
    await expect(confirm(visible(B), admin)).rejects.toThrow('Samtalet finns inte.');
    await expect(confirm(fake(() => ({ data: null }), employee), admin)).rejects.toThrow('Samtalet finns inte.');
    expect(admin.log.rpc).toEqual([]);
  });
  it('an unauthorized employee (database says false) gets no success', async () => {
    await expect(confirm(visible(), fake(() => ({}), { samtal_confirm_review: false }), 'business', 'other-user')).rejects.toThrow('saknar du behörighet');
  });
  it('concurrent reviews: the first decision wins, a different request is reported, not overwritten', async () => {
    let decided: string | null = null;
    const admin = fake(() => ({}), { samtal_confirm_review: (a: Record<string, unknown>) => {
      if (decided === null) { decided = `${a['p_request']}:${a['p_decision']}`; return { data: true }; }
      return { data: decided === `${a['p_request']}:${a['p_decision']}` };
    } });
    const other = 'e0000000-0000-4000-8000-000000000002';
    const results = await Promise.allSettled([confirm(visible(), admin, 'business'), confirm(visible(), admin, 'private', ACTOR, other)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
  });
  it('an ambiguous timeout is retried with the same request id and answered as done', async () => {
    let calls = 0;
    const admin = fake(() => ({}), { samtal_confirm_review: () => (++calls === 1 ? { error: { code: '57014' } } : { data: true }) });
    await expect(confirm(visible(), admin)).rejects.toThrow('Försök igen');
    await expect(confirm(visible(), admin)).resolves.toMatchObject({ decision: 'business' });
    expect(new Set(admin.log.rpc.map(r => r.args['p_request']))).toEqual(new Set([REQ]));
  });
  it('a private decision reports deletion as pending, never as done', async () => {
    expect(await confirm(visible(), fake(() => ({}), { samtal_confirm_review: true }), 'private')).toEqual({ decision: 'private', deletion_pending: true });
    expect(labels.CALL_STATUS['privat']).not.toMatch(/raderad/i);
    expect(labels.errorLabel('uncertain_needs_review')).toContain('bekräfta');
  });
});

describe('guarded audio', () => {
  const path_ = `${A}/${CALL}.mp3`;
  it('signs only after the guard returns the same path, and rechecks before returning the link', async () => {
    const admin = fake(() => ({}), { samtal_audio_access_guarded: path_ });
    expect(await page.samtalAudioLink(visible().client, admin.client, CALL, ACTOR)).toEqual({ url: `https://signed/${path_}`, expires_in: 60 });
    expect(admin.log.rpc.map(r => r.args)).toEqual([{ p_call: CALL, p_company: A, p_actor: ACTOR }, { p_call: CALL, p_company: A, p_actor: ACTOR }]);
  });
  it('a deleted, private, expired or unauthorized call (guard null) is never signed', async () => {
    const admin = fake(() => ({}), { samtal_audio_access_guarded: null });
    await expect(page.samtalAudioLink(visible().client, admin.client, CALL, ACTOR)).rejects.toThrow('Inspelningen finns inte.');
    expect(admin.log.signed).toEqual([]);
  });
  it('a call deleted between signing and returning gets no link', async () => {
    let n = 0;
    const admin = fake(() => ({}), { samtal_audio_access_guarded: () => ({ data: ++n === 1 ? path_ : null }) });
    await expect(page.samtalAudioLink(visible().client, admin.client, CALL, ACTOR)).rejects.toThrow('Inspelningen finns inte.');
  });
  it('another company\'s folder is refused before the guard', async () => {
    const admin = fake(() => ({}), { samtal_audio_access_guarded: `${B}/x.mp3` });
    await expect(page.samtalAudioLink(visible(A, `${B}/x.mp3`).client, admin.client, CALL, ACTOR)).rejects.toThrow('Inspelningen finns inte.');
    expect(admin.log.rpc).toEqual([]);
  });
});

describe('guarded restart', () => {
  it('only owners, only through the guarded function, with no direct job or call writes', async () => {
    const admin = fake(() => ({}), { samtal_restart_guarded: true });
    await expect(page.startSamtalCall(fake(() => ({ data: { id: CALL, company_id: A } }), employee).client, admin.client, CALL, ACTOR)).rejects.toThrow('Bara ägaren');
    expect(await page.startSamtalCall(visible().client, admin.client, CALL, ACTOR)).toEqual({ started: true });
    expect(admin.log.queries).toEqual([]);
    expect(admin.log.rpc).toEqual([{ name: 'samtal_restart_guarded', args: { p_call: CALL, p_company: A, p_actor: ACTOR } }]);
  });
  it('a deleted, expired, private or unreviewed uncertain call (guard false) is not started', async () => {
    expect(await page.startSamtalCall(visible().client, fake(() => ({}), { samtal_restart_guarded: false }).client, CALL, ACTOR)).toEqual({ started: false });
  });
  it('another company\'s call is refused before the guard', async () => {
    const admin = fake(() => ({}), { samtal_restart_guarded: true });
    await expect(page.startSamtalCall(visible(B).client, admin.client, CALL, ACTOR)).rejects.toThrow('Samtalet finns inte.');
    expect(admin.log.rpc).toEqual([]);
  });
});
