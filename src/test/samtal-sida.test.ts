// estim Samtal step 6: the server side of the Samtal page. The user's own client (RLS) decides visibility; the service
// client is used only after that client has proven access, and only within the user's company. Fake clients record
// every query.
import { describe, expect, it } from 'vitest';
import { addSamtalNumber, changeSamtalNumber, decideSamtalTask, loadSamtalPage, saveSamtalSettings, samtalAudioLink, startSamtalCall } from '@/lib/samtal/page.server';
import { errorLabel } from '@/lib/samtal/labels';

const A = '0000000a-0000-4000-8000-000000000000', B = '0000000b-0000-4000-8000-000000000000', CALL = 'c0000000-0000-4000-8000-000000000001';
type Op = [string, ...unknown[]];
type Handler = (table: string, ops: Op[]) => { data?: unknown; error?: unknown; count?: number };

// A chainable fake of the Supabase client: every builder call is recorded; awaiting or maybeSingle() asks the handler.
function fake(handler: Handler, rpc: Record<string, unknown> = {}) {
  const log = { queries: [] as { table: string; ops: Op[] }[], rpc: [] as { name: string; args: unknown }[], signed: [] as { path: string; seconds: number }[] };
  const client = {
    rpc: async (name: string, args: unknown) => { log.rpc.push({ name, args }); return name in rpc ? { data: rpc[name], error: null } : { data: null, error: { code: 'x' } }; },
    storage: { from: () => ({ createSignedUrl: async (path: string, seconds: number) => { log.signed.push({ path, seconds }); return { data: { signedUrl: `https://signed/${path}` }, error: null }; } }) },
    from: (table: string) => {
      const ops: Op[] = []; log.queries.push({ table, ops });
      const result = () => ({ data: null, error: null, ...handler(table, ops) });
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
const has = (ops: Op[], ...op: unknown[]) => ops.some(o => JSON.stringify(o) === JSON.stringify(op));
const owner = { my_company: A, samtal_is_owner: true }, employee = { my_company: A, samtal_is_owner: false };

describe('loading the page', () => {
  it('reads through the user\'s client; the service client reads only the own company\'s member names; the page never gets transcripts', async () => {
    const user = fake((table, ops) => table === 'samtal_calls' && has(ops, 'limit', 100)
      ? { data: [{ id: CALL, kind: 'telefon', user_id: 'u1', caller_phone: '+46701234567', started_at: '2026-11-25T08:00:00Z', duration_seconds: 60, status: 'klar', classification: 'jobb', error_code: null, thread_id: 't1', audio_path: `${A}/${CALL}.mp3`,
        extraction: { interpretation: { fields: { job_type: { value: 'laddbox' }, description: { value: 'Ny laddbox' } } } }, transcript: { segments: [{ text: 'hemligt' }] } }] }
      : table === 'samtal_calls' ? { count: 2 } : { data: [] }, owner);
    const admin = fake(table => table === 'company_members' ? { data: [{ user_id: 'u1', role: 'användare' }] } : table === 'profiles' ? { data: [{ id: 'u1', display_name: 'Ali' }] } : { data: [] });
    const page = await loadSamtalPage(user.client, admin.client, 'u0', { stt: false, ai: true });
    expect(page.calls).toEqual([{ id: CALL, kind: 'telefon', user_id: 'u1', caller_phone: '+46701234567', started_at: '2026-11-25T08:00:00Z', duration_seconds: 60, status: 'klar', progress: 'klar', classification: 'jobb', error_code: null, thread_id: 't1', title: 'Laddbox: Ny laddbox', has_audio: true, needs_review: false }]);
    expect(JSON.stringify(page)).not.toContain('hemligt');
    expect(page.members).toEqual([{ user_id: 'u1', role: 'användare', name: 'Ali' }]);
    expect(admin.log.queries.map(q => q.table)).toEqual(['company_members', 'profiles', 'samtal_reviews', 'samtal_jobs', 'samtal_a9_matches']);
    expect(has(admin.log.queries[0]!.ops, 'eq', 'company_id', A)).toBe(true);
    expect(has(admin.log.queries[1]!.ops, 'in', 'id', ['u1'])).toBe(true);
    // Pending reviews are read for the own company and only for calls the user's client already returned.
    const reviews = admin.log.queries[2]!.ops;
    expect(has(reviews, 'eq', 'company_id', A) && has(reviews, 'eq', 'decision', 'pending') && has(reviews, 'in', 'call_id', [CALL])).toBe(true);
    for (const query of admin.log.queries.slice(3)) {
      expect(has(query.ops, 'eq', 'company_id', A)).toBe(true);
      expect(has(query.ops, 'in', 'call_id', [CALL])).toBe(true);
    }
    expect(page).toMatchObject({ owner: true, waiting: 2, keys: { stt: false, ai: true } });
  });
  it('a user without an active company gets nothing', async () => {
    const user = fake(() => ({}), { samtal_is_owner: false });
    await expect(loadSamtalPage(user.client, fake(() => ({})).client, 'u0', { stt: false, ai: false })).rejects.toThrow('Du hör inte till något aktivt företag.');
  });
});

describe('settings and numbers: owners only, through RLS', () => {
  it('an employee cannot save settings or manage numbers; nothing is written', async () => {
    const user = fake(() => ({ data: { id: 'x' } }), employee);
    await expect(saveSamtalSettings(user.client, { auto_process: true, retention_days: 30 })).rejects.toThrow('Bara ägaren');
    await expect(addSamtalNumber(user.client, { phone: '0701234567', user_id: 'u1' })).rejects.toThrow('Bara ägaren');
    await expect(changeSamtalNumber(user.client, { id: 'n1', remove: true })).rejects.toThrow('Bara ägaren');
    expect(user.log.queries).toEqual([]);
  });
  it('settings: an update of the own company, or an insert when there is none; a write without a returned row fails', async () => {
    const existing = fake(() => ({ data: { auto_process: true, retention_days: 14 } }), owner);
    expect(await saveSamtalSettings(existing.client, { auto_process: true, retention_days: 14 })).toEqual({ auto_process: true, retention_days: 14 });
    expect(has(existing.log.queries[0]!.ops, 'eq', 'company_id', A)).toBe(true);
    const fresh = fake((_t, ops) => has(ops, 'update', { auto_process: false, retention_days: 30 }) ? { data: null } : { data: { auto_process: false, retention_days: 30 } }, owner);
    await saveSamtalSettings(fresh.client, { auto_process: false, retention_days: 30 });
    expect(has(fresh.log.queries[1]!.ops, 'insert', { company_id: A, auto_process: false, retention_days: 30 })).toBe(true);
    const denied = fake(() => ({ data: null }), owner);
    await expect(saveSamtalSettings(denied.client, { auto_process: true, retention_days: 30 })).rejects.toThrow('kunde inte sparas');
  });
  it('a number is normalised and added to the own company; a number in use is refused without saying where', async () => {
    const ok = fake(() => ({ data: { id: 'n1' } }), owner);
    expect(await addSamtalNumber(ok.client, { phone: '070-123 45 67', user_id: 'u1' })).toEqual({ id: 'n1', phone: '+46701234567' });
    expect(has(ok.log.queries[0]!.ops, 'insert', { company_id: A, user_id: 'u1', phone_e164: '+46701234567' })).toBe(true);
    await expect(addSamtalNumber(fake(() => ({ error: { code: '23505' } }), owner).client, { phone: '0701234567', user_id: 'u1' })).rejects.toThrow('Numret är redan kopplat och kan inte kopplas igen.');
    await expect(addSamtalNumber(fake(() => ({ error: { code: '23503' } }), owner).client, { phone: '0701234567', user_id: 'u9' })).rejects.toThrow('hör inte till företaget');
    await expect(addSamtalNumber(ok.client, { phone: 'inte ett nummer', user_id: 'u1' })).rejects.toThrow('giltigt telefonnummer');
  });
  it('removing a number that RLS hides (another company\'s) fails', async () => {
    await expect(changeSamtalNumber(fake(() => ({ data: [] }), owner).client, { id: 'n-b', remove: true })).rejects.toThrow('kunde inte tas bort');
  });
});

describe('audio, tasks and restarting: the user\'s client must see the call first', () => {
  const PATH = `${A}/${CALL}.mp3`;
  it('no signed link for a call the user\'s client cannot see (another company, or a colleague\'s call for an employee)', async () => {
    const admin = fake(() => ({}), { samtal_audio_access_guarded: PATH });
    await expect(samtalAudioLink(fake(() => ({ data: null }), employee).client, admin.client, CALL, 'u0')).rejects.toThrow('Inspelningen finns inte.');
    await expect(samtalAudioLink(fake(() => ({ data: { company_id: B, audio_path: `${B}/x.mp3` } }), owner).client, admin.client, CALL, 'u0')).rejects.toThrow('Inspelningen finns inte.');
    expect(admin.log.signed).toEqual([]);
    expect(admin.log.rpc).toEqual([]);
  });
  it('no signed link for a path outside the call\'s company folder', async () => {
    const admin = fake(() => ({}), { samtal_audio_access_guarded: `${B}/x.mp3` });
    await expect(samtalAudioLink(fake(() => ({ data: { company_id: A, audio_path: `${B}/x.mp3` } }), owner).client, admin.client, CALL, 'u0')).rejects.toThrow('Inspelningen finns inte.');
    expect(admin.log.signed).toEqual([]);
  });
  it('a deleted, private or expired call (guard returns no path) is never signed', async () => {
    const admin = fake(() => ({}), { samtal_audio_access_guarded: null });
    await expect(samtalAudioLink(fake(() => ({ data: { company_id: A, audio_path: PATH } }), owner).client, admin.client, CALL, 'u0')).rejects.toThrow('Inspelningen finns inte.');
    expect(admin.log.signed).toEqual([]);
  });
  it('a visible call gets a link valid for 60 seconds, checked by the guard before and after signing with the verified actor', async () => {
    const admin = fake(() => ({}), { samtal_audio_access_guarded: PATH });
    expect(await samtalAudioLink(fake(() => ({ data: { company_id: A, audio_path: PATH } }), employee).client, admin.client, CALL, 'u0')).toEqual({ url: `https://signed/${PATH}`, expires_in: 60 });
    expect(admin.log.signed).toEqual([{ path: PATH, seconds: 60 }]);
    expect(admin.log.rpc).toEqual([1, 2].map(() => ({ name: 'samtal_audio_access_guarded', args: { p_call: CALL, p_company: A, p_actor: 'u0' } })));
  });
  it('tasks are decided by the database function with the user\'s own rights', async () => {
    const user = fake(() => ({}), { samtal_decide_task: { state: 'bekraftad' } });
    expect(await decideSamtalTask(user.client, { id: 't1', decision: 'bekraftad' })).toEqual({ state: 'bekraftad' });
    expect(user.log.rpc).toEqual([{ name: 'samtal_decide_task', args: { p_task: 't1', p_decision: 'bekraftad' } }]);
    await expect(decideSamtalTask(fake(() => ({})).client, { id: 't-b', decision: 'avvisad' })).rejects.toThrow('kunde inte ändras');
  });
  it('only an owner restarts a call, only one their client sees in their company, and only through the guarded function', async () => {
    const admin = fake(() => ({}), { samtal_restart_guarded: true });
    await expect(startSamtalCall(fake(() => ({ data: { id: CALL, company_id: A } }), employee).client, admin.client, CALL, 'u0')).rejects.toThrow('Bara ägaren');
    await expect(startSamtalCall(fake(() => ({ data: null }), owner).client, admin.client, CALL, 'u0')).rejects.toThrow('Samtalet finns inte.');
    await expect(startSamtalCall(fake(() => ({ data: { id: CALL, company_id: B } }), owner).client, admin.client, CALL, 'u0')).rejects.toThrow('Samtalet finns inte.');
    expect(admin.log.rpc).toEqual([]);
    expect(await startSamtalCall(fake(() => ({ data: { id: CALL, company_id: A } }), owner).client, admin.client, CALL, 'u0')).toEqual({ started: true });
    expect(admin.log.rpc).toEqual([{ name: 'samtal_restart_guarded', args: { p_call: CALL, p_company: A, p_actor: 'u0' } }]);
    // No direct job or call writes: the guard decides whether the job is waiting, failed, private or unreviewed.
    expect(admin.log.queries).toEqual([]);
    const refused = fake(() => ({}), { samtal_restart_guarded: false });
    expect(await startSamtalCall(fake(() => ({ data: { id: CALL, company_id: A } }), owner).client, refused.client, CALL, 'u0')).toEqual({ started: false });
  });
});

describe('labels', () => {
  it('error codes in Swedish, never the raw code', () => {
    expect(errorLabel('stt_not_configured')).toContain('BERGET_API_KEY');
    expect(errorLabel('ai_http_429')).toBe('AI:n svarade med fel 429.');
    expect(errorLabel('något_okänt')).toBe('Bearbetningen misslyckades.');
  });
});
