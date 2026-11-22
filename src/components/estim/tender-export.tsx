import { useRef, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, FileSpreadsheet, FileText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getTenderCalculationMatches, getTenderCalculationSettings } from '@/lib/tender-calculation.functions';
import { deliverTenderFile, tenderExportName, type TenderExportInput } from '@/lib/tender-export';
import { tenderInsightsSchema } from '@/lib/tender-insights';
import { tenderQuantitiesSchema } from '@/lib/tender-quantities';
import { useWorkspace } from './workspace-context';
import type { TenderPdfBranding } from '@/lib/tender-export-pdf';

export function TenderExportDownloads({ name, prepare, branding }: { name: string; prepare: () => Promise<TenderExportInput>; branding?: TenderPdfBranding }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [files, setFiles] = useState<{ xlsx: Blob; pdf: Blob } | null>(null);
  const run = useRef(0);
  async function generate() {
    const current = ++run.current;
    setOpen(true); setBusy(true); setError(''); setFiles(null);
    try {
      const input = await prepare();
      const [{ generateTenderXlsx }, { generateTenderPdf }] = await Promise.all([import('@/lib/tender-export-xlsx'), import('@/lib/tender-export-pdf')]);
      const [xlsx, pdf] = await Promise.all([generateTenderXlsx(input), generateTenderPdf(input, branding)]);
      if (current === run.current) setFiles({ xlsx, pdf });
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
        {files && <><Button variant="prototype" className="btn btn-ghost" onClick={() => deliverTenderFile(files.xlsx, tenderExportName(name,'xlsx'))}><FileSpreadsheet size={18}/>Ladda ner Excel</Button><Button variant="prototype" className="btn btn-ghost" onClick={() => deliverTenderFile(files.pdf, tenderExportName(name,'pdf'))}><FileText size={18}/>Ladda ner PDF</Button></>}
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
export function TenderExport({ id, name, insights, quantities, documents }: { id: string; name: string; insights: unknown; quantities: unknown; documents: TenderExportInput['documents'] }) {
  const workspace = useWorkspace();
  const company = workspace.data?.company;
  const companyRecord = company as Record<string, unknown> | null | undefined;
  const logoUrl = companyRecord?.['logo_url'];
  const settings = useServerFn(getTenderCalculationSettings), matches = useServerFn(getTenderCalculationMatches);
  return <TenderExportDownloads name={name} branding={{ companyName: company?.name ?? 'Företag', ...(typeof logoUrl === 'string' ? { logoUrl } : {}) }} prepare={async () => {
    const [s,m] = await Promise.all([settings(),matches({data:{id}})]);
    return { name, settings:s, matches:m ?? {bindings:[],demolition:null}, insights:insights ? tenderInsightsSchema.parse(insights) : null, documents, quantities:quantities ? tenderQuantitiesSchema.parse(quantities) : {rules:{operands:[],items:[],assumptions:[]},items:[],assumptions:[]} };
  }}/>;
}