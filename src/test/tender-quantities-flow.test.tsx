import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { TendersPage } from '@/components/estim/tenders-page';

const fixture = vi.hoisted(() => ({ starts: [] as { id: string; resume: boolean }[], recalculations: [] as string[], riskReruns:[] as string[],hasInsights: false, job: null as null | Record<string, unknown> }));
vi.mock('@tanstack/react-start', () => ({ useServerFn: (f: unknown) => f }));
vi.mock('@/components/estim/workspace-context', () => ({ useWorkspace: () => ({ mode: 'real', data: { company: { id: 'test-company' } } }) }));
vi.mock('@/components/estim/top-header', () => ({ TopHeader: () => null }));
vi.mock('@/lib/company-logo.functions', () => ({ getCompanyBranding: async () => ({ companyName: 'Testföretag', logoUrl: null }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/tenders.functions', () => ({
  listTenders: async () => [{ id:'tender',name:'Testanbud',status:fixture.job?.['status']==='error'?'error':'ready',created_at:'2026-11-21',error:fixture.job?.['error'] ?? null }],
  listTenderDocuments: async () => [{ id:'file',tender_id:'tender',file_name:'Teknik.pdf',file_type:'pdf',size:10,path:'test' }],
  cancelTenderUpload: vi.fn(),completeTender:vi.fn(),createTender:vi.fn(),openTenderDocument:vi.fn(),
}));
vi.mock('@/lib/tender-job.functions', () => ({
  startTenderJob: async ({ data }: { data: { id: string; resume: boolean } }) => { fixture.starts.push(data); fixture.job = { status:'running', plan:['doc:file','key_data','risks:1','risks:2','risks:3','questions','quantities','calculation'], steps:{ 'doc:file':'done', key_data:'done', 'risks:1':'done' }, error:null, failed_step:null, updated_at:'' }; return { run:'run' }; },
  getTenderJob: async () => fixture.job,
  nudgeTenderJob: async () => ({ kicked:false }),
  rereadTenderJob: vi.fn(),
  recalculateTenderJob: async ({data}:{data:{id:string}})=>{fixture.recalculations.push(data.id);fixture.job={status:'running',plan:['quantities','calculation'],steps:{quantities:'running',calculation:'pending'},error:null,updated_at:''};return {run:'run'};},
  rerunTenderRisks:async({data}:{data:{id:string}})=>{fixture.riskReruns.push(data.id);fixture.job={status:'running',plan:['risks:1','risks:2','risks:3','questions'],steps:{'risks:1':'running'},error:null,updated_at:''};return {run:'run'};},
}));
vi.mock('@/lib/tender-insights.functions', () => ({ getTenderInsights: async () => fixture.hasInsights ? {status:'analysed',result:{risks:[],questions:[]}} : null }));
vi.mock('@/lib/tender-quantities.functions', () => ({ getTenderQuantities: async () => null }));
const watch = vi.hoisted(() => ({ enabled: false, linked: [] as unknown[] }));
vi.mock('@/lib/tender-watch.functions', () => ({
  getTenderWatch: async () => watch.enabled ? { enabled: true, ready: true, regions: ['SE110'], last_fetched_at: '2026-11-24T08:00:00Z', hits: [{ id: '00000000-0000-4000-8000-000000000071', publication_number: '795738-2026', kind: 'bygg_el', title: 'Winquists väg 24, ny förskola', buyer: 'SISAB', city: 'Stockholm', places: ['SE110'], cpv: ['45210000'], deadline: '2027-01-22', value: 70000000, currency: 'SEK', framework: false, published: '2026-11-10', documents_url: 'https://www.kommersannons.se/x', notice_url: 'https://ted.europa.eu/sv/notice/-/detail/795738-2026', status: 'ny', tender_id: null }] } : { enabled: false },
  refreshTenderWatch: async () => ({ fetched: false, added: 0 }), saveTenderWatchRegions: async () => ({ ok: true }),
  updateTenderWatchHit: async (v: unknown) => { watch.linked.push(v); return { ok: true }; },
}));
vi.mock('@/lib/tender-calculation.functions', () => ({ getTenderCalculationSettings: async () => null, getTenderCalculationMatches: async () => null, saveTenderCalculationSettings: vi.fn(), saveTenderCalculationMatches: vi.fn() }));
afterEach(() => { watch.enabled = false; watch.linked = []; cleanup(); fixture.starts=[]; fixture.recalculations=[];fixture.riskReruns=[];fixture.hasInsights=false;fixture.job=null; });
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry:false }, mutations: { retry:false } } });
  render(<QueryClientProvider client={qc}><TendersPage /></QueryClientProvider>);
}
it('starts a server-side job and shows its saved step progress', async () => {
  renderPage();
  fireEvent.click(await screen.findByText('Testanbud'));
  await waitFor(() => expect(screen.getByRole('button',{name:'Analysera'})).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button',{name:'Analysera'}));
  await waitFor(() => expect(fixture.starts).toEqual([{ id:'tender', resume:false }]));
  expect(await screen.findByText('Nyckeldata klar, risker pågår (del 2 av 3)…')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Analyserar…'})).toBeDisabled();
});
it('resumes a failed job from the failed step', async () => {
  fixture.job = { status:'error', plan:['doc:file','key_data','risks:1'], steps:{ 'doc:file':'done', key_data:'done', 'risks:1':'error' }, error:'Fel i risker.', failed_step:'risks:1', updated_at:'' };
  renderPage();
  fireEvent.click(await screen.findByText('Testanbud'));
  fireEvent.click(await screen.findByRole('button',{name:'Fortsätt analysen'}));
  await waitFor(() => expect(fixture.starts).toEqual([{ id:'tender', resume:true }]));
});
it('reruns quantities and calculation without starting the full analysis',async()=>{
 fixture.hasInsights=true;
 renderPage();fireEvent.click(await screen.findByText('Testanbud'));
 fireEvent.click(await screen.findByRole('button',{name:'Räkna om mängder och kalkyl'}));
 await waitFor(()=>expect(fixture.recalculations).toEqual(['tender']));
 expect(fixture.starts).toEqual([]);expect(fixture.job?.['plan']).toEqual(['quantities','calculation']);
});
it('reruns only risks and questions without touching the calculation plan',async()=>{
 fixture.hasInsights=true;renderPage();fireEvent.click(await screen.findByText('Testanbud'));
 fireEvent.click(await screen.findByRole('button',{name:'Kör om risker och frågor'}));
 await waitFor(()=>expect(fixture.riskReruns).toEqual(['tender']));expect(fixture.starts).toEqual([]);expect(fixture.recalculations).toEqual([]);expect(fixture.job?.['plan']).toEqual(['risks:1','risks:2','risks:3','questions']);
});
it('shows Hittade anbud only when the tender watch is enabled, and Starta analys opens Nytt anbud with the name filled in', async () => {
  renderPage();
  await screen.findByText('Testanbud');
  expect(screen.queryByRole('tab', { name: 'Hittade anbud' })).toBeNull();
  cleanup(); watch.enabled = true;
  renderPage();
  fireEvent.click(await screen.findByRole('tab', { name: 'Hittade anbud' }));
  expect(await screen.findByText('Winquists väg 24, ny förskola')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Underlaget' }).getAttribute('href')).toBe('https://www.kommersannons.se/x');
  fireEvent.click(screen.getByRole('button', { name: 'Starta analys' }));
  expect((await screen.findByLabelText('Namn') as HTMLInputElement).value).toBe('Winquists väg 24, ny förskola');
  expect(screen.getByText(/Hittat anbud: SISAB, anbudstid 2027-01-22/)).toBeTruthy();
});
