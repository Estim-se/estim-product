import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { TendersPage } from '@/components/estim/tenders-page';

const fixture = vi.hoisted(() => ({ stages: [] as string[], fail: false }));
vi.mock('@tanstack/react-start', () => ({ useServerFn: (f: unknown) => f }));
vi.mock('@/components/estim/workspace-context', () => ({ useWorkspace: () => ({ mode: 'real', data: { company: { id: 'test-company' } } }) }));
vi.mock('@/components/estim/top-header', () => ({ TopHeader: () => null }));
vi.mock('@/lib/company-logo.functions', () => ({ getCompanyBranding: async () => ({ companyName: 'Testföretag', logoUrl: null }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/tenders.functions', () => ({
  listTenders: async () => [{ id:'tender',name:'Testanbud',status:'ready',created_at:'2026-11-21' }],
  listTenderDocuments: async () => [{ id:'file',tender_id:'tender',file_name:'Teknik.pdf',file_type:'pdf',size:10,path:'test' }],
  beginTenderAnalysis: async () => { fixture.stages.push('start'); return { run:'run' }; },
  analyzeTenderDocument: async () => { fixture.stages.push('classification'); return { stop:false }; },
  abortTenderAnalysis: async () => { fixture.stages.push('abort'); },
  cancelTenderUpload: vi.fn(),completeTender:vi.fn(),createTender:vi.fn(),openTenderDocument:vi.fn(),
}));
vi.mock('@/lib/tender-insights.functions', () => ({ getTenderInsights: async () => null, analyzeTenderInsights: async () => { fixture.stages.push('insights'); } }));
vi.mock('@/lib/tender-quantities.functions', () => ({ getTenderQuantities: async () => null, analyzeTenderQuantities: async ({data}:{data:{id:string;run:string}}) => { expect(data).toEqual({id:'tender',run:'run'}); fixture.stages.push('quantities'); if(fixture.fail)throw Error('Mängdanalysen misslyckades.'); return {ok:true}; } }));
vi.mock('@/lib/tender-calculation.functions', () => ({ getTenderCalculationSettings: async () => null, getTenderCalculationMatches: async () => null, saveTenderCalculationSettings: vi.fn(), saveTenderCalculationMatches: vi.fn(), matchTenderCalculation: async () => { fixture.stages.push('matching'); return { bindings: [], demolition: null }; } }));
afterEach(() => { cleanup(); fixture.stages=[]; fixture.fail=false; });
async function openAndAnalyze() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry:false }, mutations: { retry:false } } });
  render(<QueryClientProvider client={qc}><TendersPage /></QueryClientProvider>);
  fireEvent.click(await screen.findByText('Testanbud'));
  await waitFor(() => expect(screen.getByRole('button',{name:'Analysera'})).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button',{name:'Analysera'}));
}
it('runs quantities only after classification and insights, using the same tender run', async () => {
  await openAndAnalyze(); await waitFor(() => expect(fixture.stages).toEqual(['start','classification','insights','insights','insights','quantities','matching']));
  await waitFor(() => expect(screen.getByRole('button',{name:'Analysera'})).not.toBeDisabled());
});
it('records a quantity-stage failure through the existing run abort path', async () => {
  fixture.fail=true; await openAndAnalyze();
  await waitFor(() => expect(fixture.stages).toEqual(['start','classification','insights','insights','insights','quantities','abort']));
});