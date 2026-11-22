import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerFn } from '@tanstack/react-start';
import { Upload, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { companyLogoError, companyLogoPath } from '@/lib/company-logo';
import { getCompanyBranding, saveCompanyLogo } from '@/lib/company-logo.functions';

export function CompanyLogo({ companyId }: { companyId: string }) {
  const get = useServerFn(getCompanyBranding), save = useServerFn(saveCompanyLogo), queries = useQueryClient();
  const queryKey = ['company-branding', companyId];
  const logo = useQuery({ queryKey, queryFn: () => get() });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function change(file: File | null) {
    const error = file ? companyLogoError(file) : null;
    if (error) { setMessage(error); return; }
    setBusy(true); setMessage('');
    let path: string | null = null, committed = false;
    try {
      if (file) {
        path = companyLogoPath(companyId, file.type, crypto.randomUUID());
        const upload = await supabase.storage.from('company-logos').upload(path, file, { contentType: file.type, upsert: false });
        if (upload.error) throw new Error('Uppladdningen misslyckades.');
      }
      await save({ data: { path } }); committed = true;
      await queries.invalidateQueries({ queryKey });
      setMessage(file ? 'Logotypen är sparad.' : 'Logotypen är borttagen.');
    } catch { if (path && !committed) await supabase.storage.from('company-logos').remove([path]); setMessage('Logotypen kunde inte sparas. Försök igen.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return <div className="field">
    <span>Företagslogotyp (valfri)</span>
    {logo.data?.logoUrl && <img src={logo.data.logoUrl} alt="Företagslogotyp" className="h-20 w-32 object-contain object-left" />}
    <input ref={input} aria-label="Ladda upp företagslogotyp" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (file) void change(file); }} />
    <div className="row wrap gap-2"><Button type="button" variant="prototype" className="btn btn-ghost btn-sm" disabled={busy || logo.isPending || logo.isError} onClick={() => input.current?.click()}><Upload size={16}/>{busy ? 'Sparar…' : logo.data?.logoUrl ? 'Byt logotyp' : 'Ladda upp logotyp'}</Button>{logo.data?.logoUrl && <Button type="button" variant="prototype" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void change(null)}><Trash2 size={16}/>Ta bort logotyp</Button>}</div>
    <span className="small text-muted-foreground">PNG, JPG eller WEBP · max 5 MB</span>
    {(message || logo.isError) && <span role="status">{message || 'Logotypen kunde inte hämtas. Försök igen.'}</span>}
  </div>;
}