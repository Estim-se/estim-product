import { describe,it,expect,vi,afterEach } from 'vitest';
import { createRealStore } from '@/lib/real-store';
import { electricianMoments } from '@/data/electrician-moments';
import { companySchema,quoteSchema } from '@/lib/real.schemas';

describe('R1 real-mode rules',()=>{
 afterEach(()=>vi.useRealTimers());
 it('contains no mock customers or drafts',()=>{const store=createRealStore();expect(store.getSnapshot().threads).toEqual([]);expect(store.getSnapshot().drafts).toEqual({});expect(store.getSnapshot().stats.ai).toBe(0);});
 it('does not generate scripted requests or customer approvals',()=>{vi.useFakeTimers();const store=createRealStore();store.actions.simNew();store.actions.approveCustomer();store.actions.submitCustomer();vi.advanceTimersByTime(10000);expect(store.getSnapshot().threads).toEqual([]);});
 it('starts onboarding with exactly ten editable electrician moments',()=>{expect(electricianMoments).toHaveLength(10);expect(electricianMoments[0]?.name).toBe('Byte av vägguttag');expect(electricianMoments[9]?.name).toBe('Anslutning av spis');});
 it('rejects negative company rates',()=>{expect(companySchema.safeParse({name:'Test',signature:'',hourly_rate_ex_vat:-1,travel_fee:450}).success).toBe(false);});
 it('rejects negative quote line prices',()=>{expect(quoteSchema.safeParse({nr:'1',owners:1,addOn:false,prisform:'fast',lines:[{t:'Arbete',typ:'arbete',q:1,u:'h',p:-1,rot:true}]}).success).toBe(false);});
});