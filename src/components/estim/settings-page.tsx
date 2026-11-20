import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { PriceImport } from './price-import';
import { DOCS, settings } from '@/data/prototype-pages';
import { Icon } from './icon';
import { SettingToggle } from './setting-toggle';
import { TopHeader } from './top-header';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';
import { CompanyForm } from './company-form';
import { AuditHistory } from './audit-history';
import { ManagementPage } from './management-page';
import { DocumentLibrary } from './document-library';

export function SettingsPage() {
  const { actions } = useEstim();
  const workspace=useWorkspace();
  const [section, setSection] = useState<'AI' | 'Priser' | 'Företag' | 'Dokument' | 'Händelser'>('AI');
  const [saveTarget, setSaveTarget] = useState<HTMLDivElement | null>(null);
  const tabs = <div className="row wrap settings-tabs" role="tablist" aria-label="Inställningar">{(['AI', 'Priser', 'Företag', ...(workspace.mode==='real'?['Dokument' as const]:[]), 'Händelser'] as const).map(tab => <Button key={tab} variant="prototype" className={`fchip ${section === tab ? 'on' : ''}`} role="tab" id={`settings-tab-${tab}`} aria-selected={section === tab} aria-controls={`settings-panel-${tab}`} disabled={tab === 'Händelser' && workspace.mode !== 'real'} onClick={() => setSection(tab)}>{tab}</Button>)}</div>;
  if(workspace.mode==='real')return <><TopHeader title={`Inställningar · ${workspace.data?.company?.name ?? ''}`} subtitle="Företagsuppgifter, priser och arbetsmoment."/>{tabs}<div className="col settings-column settings-content fadein"><CompanyForm activeSection={section} onSectionChange={setSection} saveTarget={saveTarget} key={`${workspace.data?.company?.id}:${workspace.data?.moments.map(m=>m.updated_at).join()}`}/><div hidden={section !== 'Priser'}><PriceImport/></div><div hidden={section !== 'Företag'}>{workspace.data?.role==='ägare'&&workspace.data.company&&<ManagementPage companyId={workspace.data.company.id}/>}</div><div hidden={section !== 'Dokument'}><DocumentLibrary/></div><div hidden={section !== 'Händelser'} role="tabpanel" id="settings-panel-Händelser" aria-labelledby="settings-tab-Händelser"><AuditHistory/></div><div ref={setSaveTarget}/></div></>;
  return <><TopHeader title="Inställningar" subtitle="Bestäm vad AI:n får göra själv och hur den låter." />{tabs}<div className="grid2 fadein settings-grid"><div hidden={section === 'Priser'} className="col settings-column">
    <div hidden={section !== 'AI'} className="card"><h3>Det här får AI:n göra själv</h3><div className="sub">Allt annat blir ett utkast som du godkänner.</div><div className="mt8">{settings.map((s, i) => <SettingToggle key={s.label} index={i} />)}</div></div>
    <div hidden={section !== 'Företag'} className="card"><h3>Ton och avsändare</h3><div className="kv"><div><span>Tilltal</span><span>Du, kort och personligt</span></div><div><span>Signatur</span><span>Volt Vision</span></div><div><span>Svarar från</span><span>info@voltvision.se · 08-123 45 67</span></div></div><div className="flag ok"><Icon name="spark" /><span>AI:n har lärt sig er ton från 120 tidigare mejl och SMS.</span></div></div>
  </div><div className="col settings-column">
    <div hidden={section !== 'AI'} className="card"><h3>Dokument AI:n får bifoga</h3><div className="sub">Föreningar och kunder frågar ofta efter samma papper.</div><div className="col mt12 settings-docs">{DOCS.map(d => <div key={d} className="row between settings-doc"><span className="row small"><Icon name="doc" />{d}</span><span className="xs muted">Uppdaterad okt</span></div>)}</div><Button variant="prototype" className="btn btn-ghost btn-sm mt12" onClick={() => actions.toast('Ladda upp dokument (demo)')}><Icon name="plus" />Lägg till dokument</Button></div>
    <div hidden={section !== 'Priser'} className="card"><h3>Priser AI:n räknar med</h3><div className="kv"><div><span>Timpris</span><span>650 kr exkl. moms</span></div><div><span>Framkörning</span><span>450 kr</span></div><div><span>Underlag</span><span>38 gamla offerter och fakturor</span></div></div><Button variant="prototype" className="btn btn-ghost btn-sm mt12" onClick={() => actions.toast('Ladda upp fler offerter (demo)')}><Icon name="plus" />Ladda upp fler offerter</Button></div>
    <div hidden={section !== 'Företag'} className="card"><h3>När kunden säger ja</h3><div className="kv"><div><span>Brief till</span><span>Ansvarig elektriker (SMS)</span></div><div><span>PDF till</span><span>order@voltvision.se</span></div></div><div className="xs muted mt8">Mejla till ert affärssystem, er bokföring eller bara er egen inkorg.</div></div>
  </div></div></>;
}