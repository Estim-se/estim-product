import { describe,it,expect,vi,afterEach } from 'vitest';
import { createRealStore } from '@/lib/real-store';
import { electricianMoments } from '@/data/electrician-moments';
import { companySchema,quoteSchema } from '@/lib/real.schemas';
import { initialThreads } from '@/data/inbox';
import type { RealMutation } from '@/lib/real.schemas';

describe('R1 real-mode rules',()=>{
 afterEach(()=>vi.useRealTimers());
 it('contains no mock customers or drafts',()=>{const store=createRealStore();expect(store.getSnapshot().threads).toEqual([]);expect(store.getSnapshot().drafts).toEqual({});expect(store.getSnapshot().stats.ai).toBe(0);});
 it('persists WhatsApp opt-in per thread and does not enable other channels',async()=>{
  const store=createRealStore(),write=vi.fn(async(_input:RealMutation)=>null);store.connect(write,async()=>{});
  const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');
  store.actions.update(s=>{s.threads=[{...t,ch:'wa',autopilot:false}];});
  store.actions.toggleAuto(t.id);await store.flush();await vi.waitFor(()=>expect(store.getSnapshot().threads[0]?.autopilot).toBe(true));
  expect(write).toHaveBeenLastCalledWith({kind:'thread',id:t.id,autopilot:true});
  store.actions.toggleAuto(t.id);await store.flush();await vi.waitFor(()=>expect(store.getSnapshot().threads[0]?.autopilot).toBe(false));
  expect(write).toHaveBeenLastCalledWith({kind:'thread',id:t.id,autopilot:false});
  store.actions.update(s=>{const thread=s.threads[0];if(thread)thread.ch='email';});store.actions.toggleAuto(t.id);await store.flush();expect(write).toHaveBeenCalledTimes(2);
 });
 it('preserves status and draft on failed WhatsApp delivery and stays on the thread',async()=>{
  const store=createRealStore();const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');
  store.actions.update(s=>{s.threads=[{...t,status:'oppnad'}];s.drafts[t.id]={text:'Hej',v:'std',ch:'wa',att:[],edited:true};s.m={scr:'thread',id:t.id,editing:false};});
  const delivery=vi.fn(async()=>({sent:false,error:'WhatsApp-svaret kunde inte skickas. Försök igen.'}));store.connectDelivery(delivery);store.connect(async()=>null,async()=>{});
  store.actions.mobileApprove(t.id);await vi.waitFor(()=>expect(store.getSnapshot().drafts[t.id]?.busy).toBe(false));
  expect(delivery).toHaveBeenCalledWith(t.id);expect(store.getSnapshot().threads[0]?.status).toBe('oppnad');expect(store.getSnapshot().threads[0]?.deliveryError).toBeTruthy();expect(store.getSnapshot().drafts[t.id]?.text).toBe('Hej');expect(store.getSnapshot().m.scr).toBe('thread');
 });
 it('does not generate scripted requests or customer approvals',()=>{vi.useFakeTimers();const store=createRealStore();store.actions.simNew();store.actions.approveCustomer();store.actions.submitCustomer();vi.advanceTimersByTime(10000);expect(store.getSnapshot().threads).toEqual([]);});
 it('starts onboarding with exactly ten editable electrician moments',()=>{expect(electricianMoments).toHaveLength(10);expect(electricianMoments[0]?.name).toBe('Byte av vägguttag');expect(electricianMoments[9]?.name).toBe('Anslutning av spis');});
 it('rejects negative company rates',()=>{expect(companySchema.safeParse({name:'Test',signature:'',hourly_rate_ex_vat:-1,travel_fee:450}).success).toBe(false);});
 it('rejects negative quote line prices',()=>{expect(quoteSchema.safeParse({nr:'1',owners:1,addOn:false,prisform:'fast',lines:[{t:'Arbete',typ:'arbete',q:1,u:'h',p:-1,rot:true}]}).success).toBe(false);});
 it('makes one quote write only on Save, not on field edits',async()=>{
  const store=createRealStore(),write=vi.fn(async(_input:RealMutation)=>null),read=vi.fn(async()=>{});
  const t=initialThreads()[0];if(!t?.q)throw new Error('Missing fixture');store.actions.update(s=>{s.threads=[t];});store.connect(write,read);store.actions.openDrawer(t.id);
  store.actions.upd(0,'p','750');store.actions.upd(0,'q','3');store.actions.setOwners(2);store.actions.togRot(0);store.actions.setPriceForm('ungefar');await store.flush();expect(write).toHaveBeenCalledTimes(0);
  await store.saveQuote();expect(write).toHaveBeenCalledTimes(1);const input=write.mock.calls[0]?.[0];expect(input).toMatchObject({kind:'quote',quote:{owners:2,prisform:'ungefar'}});if(input?.kind!=='quote')throw new Error('Missing quote write');expect(input.quote.lines[0]).toMatchObject({p:750,q:3,rot:false});
  await store.saveQuote();expect(write).toHaveBeenCalledTimes(1);
 });
 it('marks wins through the server and shows the status only from the reloaded data',async()=>{
  const store=createRealStore(),write=vi.fn(async(_input:RealMutation)=>null),reload=vi.fn(async()=>{});store.connect(write,reload);
  const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');
  store.actions.update(s=>{s.threads=[{...t,status:'skickad'}];});
  store.actions.markWon(t.id);await store.flush();
  expect(write).toHaveBeenLastCalledWith({kind:'won',id:t.id,won:true});expect(reload).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().threads[0]?.status).toBe('skickad');
  store.actions.update(s=>{const thread=s.threads[0];if(thread)thread.status='vunnen';});
  store.actions.markWon(t.id);await store.flush();
  expect(write).toHaveBeenLastCalledWith({kind:'won',id:t.id,won:false});
 });
 it('never shows a win when the write fails or the AI is still working',async()=>{
  const store=createRealStore(),write=vi.fn(async(_input:RealMutation)=>{throw new Error('denied');});store.connect(write,async()=>{});
  const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');
  store.actions.update(s=>{s.threads=[{...t,status:'skickad'}];});
  store.actions.markWon(t.id);await expect(store.flush()).rejects.toThrow();
  expect(store.getSnapshot().threads[0]?.status).toBe('skickad');expect(store.getSnapshot().toast).toBe('Ändringen kunde inte sparas. Försök igen.');
  store.actions.update(s=>{const thread=s.threads[0];if(thread)thread.status='analys';});write.mockClear();
  store.actions.markWon(t.id);expect(write).not.toHaveBeenCalled();expect(store.getSnapshot().toast).toBe('Vänta tills AI:n är klar.');
 });
 it('moves a customer message to a new case and opens the new thread after the reload',async()=>{
  const newId='33333333-4444-5555-6666-777777777777';
  const store=createRealStore(),write=vi.fn(async(_input:RealMutation)=>({id:newId})),reload=vi.fn(async()=>{store.actions.update(s=>{const t=s.threads[0];if(t)s.threads=[t,{...t,id:newId}];});});store.connect(write,reload);
  const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');
  store.actions.update(s=>{s.threads=[{...t,status:'svar'}];});
  store.actions.splitThread(t.id,'44444444-5555-6666-7777-888888888888');await store.flush();
  expect(write).toHaveBeenCalledWith({kind:'split',id:t.id,message:'44444444-5555-6666-7777-888888888888'});
  expect(reload).toHaveBeenCalledTimes(1);await vi.waitFor(()=>expect(store.getSnapshot().sel).toBe(newId));await store.flush();
  store.actions.update(s=>{const thread=s.threads[0];if(thread)thread.status='analys';});write.mockClear();
  store.actions.splitThread(t.id,'44444444-5555-6666-7777-888888888888');expect(write).not.toHaveBeenCalled();
 });
 it('merges customers through the server and shows only known server messages',async()=>{
  const store=createRealStore(),write=vi.fn(async(_input:RealMutation)=>{throw new Error('Kunderna kunde inte slås ihop.');});store.connect(write,async()=>{});
  store.actions.mergeCustomers('a','b');await expect(store.flush()).rejects.toThrow();
  expect(write).toHaveBeenLastCalledWith({kind:'merge',keep:'a',drop:'b'});
  await vi.waitFor(()=>expect(store.getSnapshot().toast).toBe('Kunderna kunde inte slås ihop.'));
 });
 it('debounces and coalesces draft edits, keeps threads referentially stable, and protects dirty drafts during hydrate',async()=>{
  vi.useFakeTimers();
  const store=createRealStore(),write=vi.fn(async(_input:RealMutation)=>null);store.connect(write,async()=>{});
  const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');
  store.actions.update(s=>{s.threads=[t];s.drafts[t.id]={text:'Start',v:'std',ch:'email',att:[],edited:false};});
  const threadsBefore=store.getSnapshot().threads;
  store.actions.editDraft(t.id,'H');store.actions.editDraft(t.id,'He');store.actions.editDraft(t.id,'Hej');store.actions.editDraft(t.id,'Hej kund');
  expect(store.getSnapshot().threads).toBe(threadsBefore);
  expect(write).toHaveBeenCalledTimes(0);
  // Background poll while draft is dirty must not overwrite typed text.
  store.hydrate({platform:false,role:'ägare',company:null,profile:null,threads:[],customers:[],messages:[],quotes:[],drafts:[{thread_id:t.id,company_id:'c1',text:'Gammal servertext',variant:'std',channel:'email',attachments:[],edited:false,warnings:[],needs_review:false,document_ids:null,created_at:'2026-11-27T08:00:00Z',updated_at:'2026-11-27T08:00:00Z'}],moments:[],audit:[],channels:[]} as never);
  expect(store.getSnapshot().drafts[t.id]?.text).toBe('Hej kund');
  vi.advanceTimersByTime(500);
  vi.useRealTimers();
  await store.flush();
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenLastCalledWith(expect.objectContaining({kind:'draft',id:t.id,draft:expect.objectContaining({text:'Hej kund',edited:true})}));
 });
 it('skips redundant read writes on already-read threads and rolls back failed optimistic toggleAuto',async()=>{
  const store=createRealStore(),write=vi.fn(async(_input:RealMutation)=>null);store.connect(write,async()=>{});
  const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');
  store.actions.update(s=>{s.threads=[{...t,ch:'wa',read:true,autopilot:false}];});
  store.actions.select(t.id);await store.flush();
  expect(write).toHaveBeenCalledTimes(0);
  write.mockRejectedValueOnce(new Error('network'));
  store.actions.toggleAuto(t.id);
  // Flips optimistically at 0 ms before server settles.
  expect(store.getSnapshot().threads[0]?.autopilot).toBe(true);
  await expect(store.flush()).rejects.toThrow();
  await vi.waitFor(()=>expect(store.getSnapshot().threads[0]?.autopilot).toBe(false));
 });
 it('keeps an optimistic toggle over a poll read before the write landed, then follows the server',async()=>{
  const store=createRealStore();let release:()=>void=()=>{};
  const write=vi.fn((_input:RealMutation)=>new Promise<null>(r=>{release=()=>r(null);}));store.connect(write,async()=>{});
  const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');
  const row={id:t.id,company_id:'c1',customer_id:'k1',channel:'wa',status:'svar',read:true,autopilot:false,whatsapp_auto_override:false,job:'Jobb',place:'',why:'',asks:[],facts:[],pending_sender:false,last_customer_wa_at:null,last_message_at:'2026-11-27T08:00:00Z',created_at:'2026-11-27T08:00:00Z',updated_at:'2026-11-27T08:00:00Z'};
  const snapshot=(override:boolean)=>({platform:false,role:'ägare',company:{id:'c1',name:'Test AB',whatsapp_auto_reply:false,active:true},profile:null,threads:[{...row,whatsapp_auto_override:override}],customers:[],messages:[],quotes:[],drafts:[],moments:[],audit:[],channels:[]}) as never;
  store.hydrate(snapshot(false));
  expect(store.getSnapshot().threads[0]?.autopilot).toBe(false);
  store.actions.toggleAuto(t.id);
  expect(store.getSnapshot().threads[0]?.autopilot).toBe(true);
  // A poll that was read before the write landed still has the old value.
  store.hydrate(snapshot(false));
  expect(store.getSnapshot().threads[0]?.autopilot).toBe(true);
  await vi.waitFor(()=>expect(write).toHaveBeenCalledTimes(1));
  release();await store.flush();
  store.hydrate(snapshot(true));
  expect(store.getSnapshot().threads[0]?.autopilot).toBe(true);
  // Once the server agreed, a later change from elsewhere is shown.
  store.hydrate(snapshot(false));
  expect(store.getSnapshot().threads[0]?.autopilot).toBe(false);
 });
});