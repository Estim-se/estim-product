import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { TendersPage } from '@/components/estim/tenders-page';

const fixture = vi.hoisted(() => ({ starts: [] as { id: string; resume: boolean }[], job: null as null | Record<string, unknown> }));
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
}));
vi.mock('@/lib/tender-insights.functions', () => ({ getTenderInsights: async () => null }));
vi.mock('@/lib/tender-quantities.functions', () => ({ getTenderQuantities: async () => null }));
vi.mock('@/lib/tender-calculation.functions', () => ({ getTenderCalculationSettings: async () => null, getTenderCalculationMatches: async () => null, saveTenderCalculationSettings: vi.fn(), saveTenderCalculationMatches: vi.fn() }));
afterEach(() => { cleanup(); fixture.starts=[]; fixture.job=null; });
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
