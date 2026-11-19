import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { parseMutation } from './real.schemas';

// Every read and write revalidates the caller; ordinary queries run under RLS.
export const loadWorkspace = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const db = context.supabase;
  const { readAccess } = await import('./access.server');
  const access = await readAccess(db,context.userId);
  const membership = await db.from('company_members').select('*').eq('user_id',context.userId).maybeSingle();
  const profile = await db.from('profiles').select('display_name').eq('id',context.userId).maybeSingle();
  if (membership.error || profile.error) throw new Error('Kunde inte läsa ditt konto.');
  if (!membership.data) return { platform:access.platform,role:null,company: null, profile: profile.data, threads: [], customers: [], messages: [], quotes: [], drafts: [], moments: [], audit: [], channels: [] };
  const cid = membership.data.company_id;
  const [company, threads, customers, messages, quotes, drafts, moments, audit] = await Promise.all([
    db.from('companies').select('*').eq('id',cid).single(),
    db.from('threads').select('*').eq('company_id',cid).order('last_message_at',{ascending:false}),
    db.from('customers').select('*').eq('company_id',cid),
    db.from('messages').select('*').eq('company_id',cid).order('sent_at'),
    db.from('quotes').select('*').eq('company_id',cid).order('version',{ascending:false}),
    db.from('drafts').select('*').eq('company_id',cid),
    db.from('moments').select('*').eq('company_id',cid).order('created_at'),
    db.from('audit_log').select('*').eq('company_id',cid).order('created_at',{ascending:false}),
  ]);
  if ([company,threads,customers,messages,quotes,drafts,moments,audit].some(result=>result.error)) throw new Error('Kunde inte läsa företagets uppgifter.');
  if(!company.data?.active)throw new Error('Företaget är avaktiverat.');
  const channels = await db.from('channels').select('*').eq('company_id', cid);
  if (channels.error) throw new Error('Kunde inte läsa kanalerna.');
  return { platform:access.platform,role:membership.data.role,company: company.data, profile: profile.data, threads: threads.data ?? [], customers: customers.data ?? [], messages: messages.data ?? [], quotes: quotes.data ?? [], drafts: drafts.data ?? [], moments: moments.data ?? [], audit: audit.data ?? [], channels: channels.data ?? [] };
});
export type WorkspaceData = Awaited<ReturnType<typeof loadWorkspace>>;

export const mutateWorkspace = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator(parseMutation).handler(async ({data,context}) => {
  const db = context.supabase;
  const session=await db.rpc('estim_session_valid');
  if(session.error||!session.data)throw new Error('Logga in igen.');
  const membership = await db.from('company_members').select('company_id').eq('user_id',context.userId).maybeSingle();
  if (membership.error) throw new Error('Kunde inte kontrollera företaget.');
  const cid = membership.data?.company_id;
  if (data.kind === 'profile') {
    const result = await db.from('profiles').update({display_name:data.display_name}).eq('id',context.userId);
    if(result.error) throw new Error('Kunde inte spara ditt namn.');
    return { id: context.userId };
  }
  if (data.kind === 'onboard') {
    throw new Error('Företag skapas av en plattformsadministratör.');
  }
  if (!cid) throw new Error('Skapa ett företag först.');
  const active=await db.from('companies').select('active').eq('id',cid).maybeSingle();
  if(!active.data?.active)throw new Error('Företaget är avaktiverat.');
  let result;
  switch(data.kind) {
    case 'request': {
      const r = data.request;
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const saved = await supabaseAdmin.rpc('estim_receive', { cid, actor: context.userId, payload: { channel: r.channel, customer_name: r.name, customer_phone: r.phone, customer_email: r.email, text: r.text, job: r.job, address: r.address, place: r.place } });
      if (saved.error) throw new Error('Kunde inte skapa förfrågan.');
      const received = saved.data as { id: string; job_id: string };
      const { dispatchAiJob } = await import('./channel.server');
      try { await dispatchAiJob(received.job_id); }
      catch { await supabaseAdmin.from('ai_jobs').update({ state: 'failed' }).eq('id', received.job_id).eq('company_id', cid);
        await db.from('drafts').update({ text: '', warnings: ['AI kunde inte svara just nu'], needs_review: true }).eq('thread_id', received.id).eq('company_id', cid);
        await db.from('threads').update({ status: 'svar' }).eq('id', received.id).eq('company_id', cid); }
      return { id: received.id };
    }
    case 'quote': result=await db.rpc('estim_quote',{tid:data.id,payload:data.quote}); break;
    case 'approve': result=await db.rpc('estim_approve',{tid:data.id}); break;
    case 'draft': result=await db.from('drafts').update({text:data.draft.text,variant:data.draft.v,channel:data.draft.ch,attachments:data.draft.att,edited:data.draft.edited}).eq('thread_id',data.id).eq('company_id',cid); break;
    case 'thread': result=await db.from('threads').update({...(data.read !== undefined ? {read:data.read} : {}),...(data.autopilot !== undefined ? {autopilot:data.autopilot} : {}),...(data.status ? {status:data.status} : {})}).eq('id',data.id).eq('company_id',cid); break;
    case 'company': result=await db.from('companies').update({name:data.company.name,signature:data.company.signature,hourly_rate_ex_vat:data.company.hourly_rate_ex_vat,travel_fee:data.company.travel_fee,...(data.company.settings?{settings:data.company.settings}:{}),reply_to_email:data.company.reply_to_email || null}).eq('id',cid); break;
    case 'moment': {
      const {id,...moment}=data.moment;
      result=id ? await db.from('moments').update(moment).eq('id',id).eq('company_id',cid) : await db.from('moments').insert({...moment,company_id:cid}); break;
    }
  }
  if(result.error) throw new Error('Ändringen kunde inte sparas. Försök igen.');
  return {id: typeof result.data === 'string' ? result.data : null};
});