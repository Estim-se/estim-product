import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { parseMutation } from './real.schemas';
import { saveCompanyAutoReply } from './company-auto-reply';
import { pendingRpc } from './pending-rpc';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

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
  const documents = await db.from('company_document_deliveries').select('id,name,message_id,thread_id').eq('company_id', cid).eq('state', 'sent');
  if (documents.error) throw new Error('Dokumenthistoriken kunde inte läsas.');
  const library = await db.from('company_documents').select('id,name').eq('company_id', cid);
  if (library.error) throw new Error('Dokumentbiblioteket kunde inte läsas.');
  return { platform:access.platform,role:membership.data.role,company: company.data, profile: profile.data, threads: threads.data ?? [], customers: customers.data ?? [], messages: messages.data ?? [], quotes: quotes.data ?? [], drafts: drafts.data ?? [], moments: moments.data ?? [], audit: audit.data ?? [], channels: channels.data ?? [], documentLibrary: library.data ?? [], documentDeliveries: documents.data ?? [], whatsAppSendingConnected: Boolean(process.env['N8N_WA_SEND_URL']?.trim()) };
});
export type WorkspaceData = Awaited<ReturnType<typeof loadWorkspace>>;

// Starts a queued AI job; if dispatch fails the thread falls back to a manual reply instead of hanging.
async function startAiJob(db: SupabaseClient<Database>, cid: string, threadId: string, jobId: string) {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { dispatchAiJob } = await import('./channel.server');
  try { await dispatchAiJob(jobId); }
  catch { await supabaseAdmin.from('ai_jobs').update({ state: 'failed' }).eq('id', jobId).eq('company_id', cid);
    await db.from('drafts').update({ text: '', warnings: ['AI kunde inte svara just nu'], needs_review: true }).eq('thread_id', threadId).eq('company_id', cid);
    await db.from('threads').update({ status: 'svar' }).eq('id', threadId).eq('company_id', cid); }
}

export const mutateWorkspace =createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).inputValidator(parseMutation).handler(async ({data,context}) => {
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
    case 'whatsapp-auto': return saveCompanyAutoReply(db,cid,data.enabled);
    case 'request': {
      const r = data.request;
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      // A manual request is always a new case: new_thread keeps it out of the customer's open thread
      // (estim_receive honours it only for user-created requests, i.e. when actor is set).
      const saved = await supabaseAdmin.rpc('estim_receive', { cid, actor: context.userId, payload: { channel: r.channel, customer_name: r.name, customer_phone: r.phone, customer_email: r.email, text: r.text, job: r.job, address: r.address, place: r.place, new_thread: true } });
      if (saved.error) throw new Error('Kunde inte skapa förfrågan.');
      const received = saved.data as { id: string; job_id: string };
      await startAiJob(db, cid, received.id, received.job_id);
      return { id: received.id };
    }
    case 'split': {
      // Moves a customer message and everything after it into a new thread for the same customer,
      // then lets the AI interpret the new case. The old thread keeps its quote and earlier messages.
      const split = await pendingRpc(db, 'estim_split_thread', { tid: data.id, mid: data.message });
      if (split.error || !split.data) throw new Error(/busy/i.test(split.error?.message ?? '') ? 'Vänta tills AI:n är klar.' : 'Meddelandet kunde inte flyttas.');
      await startAiJob(db, cid, split.data.id, split.data.job_id);
      return { id: split.data.id };
    }
    case 'merge': {
      if (data.keep === data.drop) throw new Error('Välj två olika kunder.');
      const merged = await pendingRpc(db, 'estim_merge_customers', { keep_id: data.keep, drop_id: data.drop });
      if (merged.error || !merged.data) throw new Error('Kunderna kunde inte slås ihop.');
      return { id: merged.data };
    }
    case 'quote': result=await db.rpc('estim_quote',{tid:data.id,payload:data.quote}); break;
    case 'approve': result=await db.rpc('estim_approve',{tid:data.id}); break;
    case 'draft': result=await db.from('drafts').update({text:data.draft.text,variant:data.draft.v,channel:data.draft.ch,attachments:data.draft.att,edited:data.draft.edited}).eq('thread_id',data.id).eq('company_id',cid); break;
    case 'thread': result=await db.from('threads').update({...(data.read !== undefined ? {read:data.read} : {}),...(data.autopilot !== undefined ? {autopilot:data.autopilot,whatsapp_auto_override:data.autopilot} : {}),...(data.status ? {status:data.status} : {})}).eq('id',data.id).eq('company_id',cid); break;
    case 'won': {
      // Manual win marking until customer approval is connected. estim_set_won locks the thread,
      // checks the current status, derives the restored status from stored messages and writes
      // the audit event atomically; it raises instead of silently changing nothing.
      const won = await pendingRpc(db, 'estim_set_won', { tid: data.id, won: data.won });
      if (won.error || !won.data) throw new Error(/busy/i.test(won.error?.message ?? '') ? 'Vänta tills AI:n är klar.' : data.won ? 'Jobbet kunde inte markeras som vunnet.' : 'Jobbet kunde inte återställas.');
      return { id: data.id };
    }
    case 'company': result=await db.from('companies').update({name:data.company.name,signature:data.company.signature,hourly_rate_ex_vat:data.company.hourly_rate_ex_vat,travel_fee:data.company.travel_fee,...(data.company.settings?{settings:data.company.settings}:{}),reply_to_email:data.company.reply_to_email || null}).eq('id',cid); break;
    case 'moment': {
      const {id,...moment}=data.moment;
      result=id ? await db.from('moments').update(moment).eq('id',id).eq('company_id',cid) : await db.from('moments').insert({...moment,company_id:cid}); break;
    }
  }
  if(result.error) throw new Error('Ändringen kunde inte sparas. Försök igen.');
  return {id: typeof result.data === 'string' ? result.data : null};
});