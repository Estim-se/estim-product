import { useRef, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getTenderCalculationMatches, getTenderCalculationSettings } from '@/lib/tender-calculation.functions';
import { deliverTenderFile, type TenderExportInput } from '@/lib/tender-export';
import { generateTenderZip, tenderBundleNames } from '@/lib/tender-export-zip';
import { getCompanyBranding } from '@/lib/company-logo.functions';
import { tenderInsightsSchema } from '@/lib/tender-insights';
import { tenderQuantitiesSchema } from '@/lib/tender-quantities';
import type { TenderPdfBranding } from '@/lib/tender-export-pdf';

export function TenderExportDownloads({ name, prepare, branding, loadBranding }: { name: string; prepare: () => Promise<TenderExportInput>; branding?: TenderPdfBranding; loadBranding?: () => Promise<TenderPdfBranding> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [files, setFiles] = useState<Blob | null>(null);
  const run = useRef(0);
  async function generate() {
    const current = ++run.current;
    setOpen(true); setBusy(true); setError(''); setFiles(null);
    try {
      const [input, currentBranding] = await Promise.all([prepare(), loadBranding ? loadBranding() : Promise.resolve(branding)]);
      const [{ generateTenderXlsx }, { generateTenderPdf }] = await Promise.all([import('@/lib/tender-export-xlsx'), import('@/lib/tender-export-pdf')]);
      const [xlsx, pdf] = await Promise.all([generateTenderXlsx(input, currentBranding), generateTenderPdf(input, currentBranding)]);
      const zip = await generateTenderZip(input, { xlsx, pdf });
      if (current === run.current) setFiles(zip);
    } catch { if (current === run.current) setError('Exporten kunde inte skapas. Försök igen.'); }
    finally { if (current === run.current) setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={value => { setOpen(value); if (!value) { run.current++; setFiles(null); setBusy(false); } }}>
    <Button variant="prototype" className="btn btn-ghost" onClick={() => void generate()}><Download size={16} />Exportera</Button>
    <Dialog.Portal><Dialog.Overlay className="ov tender-overlay" /><Dialog.Content className="md tender-modal" aria-describedby={undefined}>
      <div className="md-h"><Dialog.Title>Exportera anbud</Dialog.Title><Dialog.Close asChild><Button variant="prototype" className="xbtn" aria-label="Stäng" title="Stäng"><X size={18}/></Button></Dialog.Close></div>
      <div className="md-b col gap-4">
        {busy && <p role="status">Skapar export…</p>}
        {error && <><p role="alert">{error}</p><Button variant="prototype" className="btn btn-ghost" onClick={() => void generate()}>Försök igen</Button></>}
        {files && <Button variant="prototype" className="btn btn-ghost" onClick={() => deliverTenderFile(files, tenderBundleNames(name).zip)}><Download size={18}/>Ladda ner ZIP</Button>}
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
export function TenderExport({ id, name, insights, quantities, documents }: { id: string; name: string; insights: unknown; quantities: unknown; documents: TenderExportInput['documents'] }) {
  const branding = useServerFn(getCompanyBranding);
  const settings = useServerFn(getTenderCalculationSettings), matches = useServerFn(getTenderCalculationMatches);
  return <TenderExportDownloads name={name} loadBranding={async () => { const b = await branding(); return { companyName: b.companyName, ...(b.logoUrl ? { logoUrl: b.logoUrl } : {}) }; }} prepare={async () => {
    const [s,m] = await Promise.all([settings(),matches({data:{id}})]);
    return { name, settings:s, matches:m ?? {bindings:[],demolition:null}, insights:insights ? tenderInsightsSchema.parse(insights) : null, documents, quantities:quantities ? tenderQuantitiesSchema.parse(quantities) : {rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[]} };
  }}/>;
}