import { describe,it,expect,vi,afterEach } from 'vitest';
import { createRealStore } from '@/lib/real-store';
import { electricianMoments } from '@/data/electrician-moments';
import { companySchema,quoteSchema } from '@/lib/real.schemas';
import { initialThreads } from '@/data/inbox';
import type { RealMutation } from '@/lib/real.schemas';

describe('R1 real-mode rules',()=>{
 afterEach(()=>vi.useRealTimers());
 it('contains no mock customers or drafts',()=>{const store=createRealStore();expect(store.getSnapshot().threads).toEqual([]);expect(store.getSnapshot().drafts).toEqual({});expect(store.getSnapshot().stats.ai).toBe(0);});
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
});