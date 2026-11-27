import { describe,it,expect } from 'vitest';
import { approvedIntegrationTarget,requireLocalIsolation,SHARED_APPLICATION_REF } from './helpers/test-target';
describe('A10 permanent test safety proposal',()=>{
 it('inherited credentials cannot opt ordinary tests into any remote project',()=>{expect(approvedIntegrationTarget({mode:'local',isolated:'1',optIn:undefined,approvedRef:SHARED_APPLICATION_REF,url:`https://${SHARED_APPLICATION_REF}.supabase.co`})).toBe(false);});
 it('explicit opt-in still rejects the shared application database',()=>expect(()=>approvedIntegrationTarget({mode:'remote',isolated:'target-only',optIn:'I_APPROVE_DISPOSABLE_TEST_PROJECT',approvedRef:SHARED_APPLICATION_REF,url:`https://${SHARED_APPLICATION_REF}.supabase.co`})).toThrow('disposable_test_project_required'));
 it('remote execution requires explicit opt-in',()=>expect(()=>approvedIntegrationTarget({mode:'remote',isolated:'target-only',optIn:undefined,approvedRef:'disposableonly',url:'https://disposableonly.supabase.co'})).toThrow('remote_test_opt_in_required'));
 it('a disposable declaration cannot point at a different host',()=>expect(()=>approvedIntegrationTarget({mode:'remote',isolated:'target-only',optIn:'I_APPROVE_DISPOSABLE_TEST_PROJECT',approvedRef:'disposableonly',url:`https://${SHARED_APPLICATION_REF}.supabase.co`})).toThrow('unapproved_test_target'));
 it('remote opt-in alone cannot bypass network policy',()=>expect(()=>approvedIntegrationTarget({mode:'remote',isolated:'1',optIn:'I_APPROVE_DISPOSABLE_TEST_PROJECT',approvedRef:'disposableonly',url:'https://disposableonly.supabase.co'})).toThrow('remote_test_network_policy_required'));
 it('local test setup fails without the namespace launcher attestation',()=>expect(()=>requireLocalIsolation({ESTIM_TEST_MODE:'local'})).toThrow('use_isolated_test_launcher'));
 it('the actual local test process has no app credentials',()=>{expect(process.env['ESTIM_TEST_MODE']).toBe('local');expect(process.env['ESTIM_TEST_NET_ISOLATED']).toBe('1');expect(process.env['SUPABASE_SERVICE_ROLE_KEY']).toBeUndefined();expect(process.env['SUPABASE_URL']).toBeUndefined();});
});
