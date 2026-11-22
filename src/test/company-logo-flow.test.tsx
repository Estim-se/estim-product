import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyLogo } from '@/components/estim/company-logo';
const fixture=vi.hoisted(()=>({url:null as string|null,upload:vi.fn(),remove:vi.fn(),save:vi.fn()}));
vi.mock('@tanstack/react-start',()=>({useServerFn:(f:unknown)=>f}));
vi.mock('@/lib/company-logo.functions',()=>({getCompanyBranding:async()=>({companyName:'Eget företag',logoUrl:fixture.url}),saveCompanyLogo:async({data}:{data:{path:string|null}})=>{await fixture.save(data);fixture.url=data.path?'https://example.com/own-logo.png':null;return {ok:true};}}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{storage:{from:()=>({upload:fixture.upload,remove:fixture.remove})}}}));
beforeEach(()=>{fixture.url=null;fixture.upload.mockResolvedValue({error:null});fixture.remove.mockResolvedValue({error:null});fixture.save.mockResolvedValue({ok:true});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function start(){const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={qc}><CompanyLogo companyId="00000000-0000-4000-8000-000000000001"/></QueryClientProvider>);return qc;}
it('uploads, saves and reads back the company logo after a successful returned save',async()=>{
  start();await waitFor(()=>expect(screen.getByRole('button',{name:'Ladda upp logotyp'})).toBeEnabled());
  const file=new File(['png'],'logo.png',{type:'image/png'});
  fireEvent.change(screen.getByLabelText('Ladda upp företagslogotyp'),{target:{files:[file]}});
  await screen.findByText('Logotypen är sparad.');
  expect(fixture.upload).toHaveBeenCalledWith(expect.stringMatching(/^00000000-0000-4000-8000-000000000001\/.*\.png$/),file,{contentType:'image/png',upsert:false});
  expect(fixture.save).toHaveBeenCalledWith({path:fixture.upload.mock.calls[0]?.[0]});
  expect(screen.getByAltText('Företagslogotyp')).toHaveAttribute('src','https://example.com/own-logo.png');
});
it('cleans up an uploaded file when the server refuses to save the logo',async()=>{
  fixture.save.mockRejectedValueOnce(Error('denied'));start();await waitFor(()=>expect(screen.getByRole('button',{name:'Ladda upp logotyp'})).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Ladda upp företagslogotyp'),{target:{files:[new File(['png'],'logo.png',{type:'image/png'})]}});
  await screen.findByText('Logotypen kunde inte sparas. Försök igen.');
  expect(fixture.remove).toHaveBeenCalledWith([fixture.upload.mock.calls[0]?.[0]]);expect(fixture.url).toBeNull();
});
it('removes the stored branding and reads back the initials fallback state',async()=>{
  fixture.url='https://example.com/own-logo.png';start();await screen.findByAltText('Företagslogotyp');
  fireEvent.click(screen.getByRole('button',{name:'Ta bort logotyp'}));await screen.findByText('Logotypen är borttagen.');
  expect(fixture.save).toHaveBeenCalledWith({path:null});expect(screen.queryByAltText('Företagslogotyp')).toBeNull();
});