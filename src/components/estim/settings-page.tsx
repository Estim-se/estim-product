import { Button } from '@/components/ui/button';
import { DOCS, settings } from '@/data/prototype-pages';
import { Icon } from './icon';
import { SettingToggle } from './setting-toggle';
import { TopHeader } from './top-header';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';
import { CompanyForm } from './company-form';
import { AuditHistory } from './audit-history';

export function SettingsPage() {
  const { actions } = useEstim();
  const workspace=useWorkspace();
  if(workspace.mode==='real')return <><TopHeader title="AI och inställningar" subtitle="Företagsuppgifter, priser och arbetsmoment."/><CompanyForm key={workspace.data?.company?.id}/><AuditHistory/></>;
  return <><TopHeader title="AI och inställningar" subtitle="Bestäm vad AI:n får göra själv och hur den låter." /><div className="grid2 fadein settings-grid"><div className="col settings-column">
    <div className="card"><h3>Det här får AI:n göra själv</h3><div className="sub">Allt annat blir ett utkast som du godkänner.</div><div className="mt8">{settings.map((s, i) => <SettingToggle key={s.label} index={i} />)}</div></div>
    <div className="card"><h3>Ton och avsändare</h3><div className="kv"><div><span>Tilltal</span><span>Du, kort och personligt</span></div><div><span>Signatur</span><span>Volt Vision</span></div><div><span>Svarar från</span><span>info@voltvision.se · 08-123 45 67</span></div></div><div className="flag ok"><Icon name="spark" /><span>AI:n har lärt sig er ton från 120 tidigare mejl och SMS.</span></div></div>
  </div><div className="col settings-column">
    <div className="card"><h3>Dokument AI:n får bifoga</h3><div className="sub">Föreningar och kunder frågar ofta efter samma papper.</div><div className="col mt12 settings-docs">{DOCS.map(d => <div key={d} className="row between settings-doc"><span className="row small"><Icon name="doc" />{d}</span><span className="xs muted">Uppdaterad okt</span></div>)}</div><Button variant="prototype" className="btn btn-ghost btn-sm mt12" onClick={() => actions.toast('Ladda upp dokument (demo)')}><Icon name="plus" />Lägg till dokument</Button></div>
    <div className="card"><h3>Priser AI:n räknar med</h3><div className="kv"><div><span>Timpris</span><span>650 kr exkl. moms</span></div><div><span>Framkörning</span><span>450 kr</span></div><div><span>Underlag</span><span>38 gamla offerter och fakturor</span></div></div><Button variant="prototype" className="btn btn-ghost btn-sm mt12" onClick={() => actions.toast('Ladda upp fler offerter (demo)')}><Icon name="plus" />Ladda upp fler offerter</Button></div>
    <div className="card"><h3>När kunden säger ja</h3><div className="kv"><div><span>Brief till</span><span>Ansvarig elektriker (SMS)</span></div><div><span>PDF till</span><span>order@voltvision.se</span></div></div><div className="xs muted mt8">Mejla till ert affärssystem, er bokföring eller bara er egen inkorg.</div></div>
  </div></div></>;
}