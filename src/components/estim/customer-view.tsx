import { Button } from '@/components/ui/button';
import { CustomerPhoneScreens } from './customer-phone-screens';
import { Icon } from './icon';
import { useEstim } from './store-provider';

const steps = ['Ser priset och väljer tillval', 'Godkänner med BankID', 'Lämnar uppgifter för ROT säkert', 'Klart. AI:n skriver överlämningen'];
export function CustomerView() {
  const { state, actions } = useEstim(), modal = state.modal;
  const t = state.threads.find(t => t.id === modal?.id);
  if (modal?.type !== 'cust' || !t?.q) return null;
  const index = ['view', 'bankid', 'info', 'klar'].indexOf(state.cust.step);
  return <div className="ov" onClick={e => { if (e.target === e.currentTarget) actions.closeCustomer(); }}><section className="md customer-modal" role="dialog" aria-modal="true" aria-labelledby="customer-heading">
    <div className="md-h"><div><div className="eyebrow">Kundens vy</div><h2 id="customer-heading" className="overlay-heading">Det här ser {t.name.split(' ')[0]} när länken öppnas</h2></div><Button variant="prototype" className="xbtn" aria-label="Stäng kundens vy" onClick={actions.closeCustomer}><Icon name="x" /></Button></div>
    <div className="phone-wrap"><div className="side-explain"><p className="small muted">Samma sida oavsett om länken kom via e-post, SMS eller WhatsApp. Ingen app och ingen inloggning.</p><ol>{steps.map((step, i) => <li key={step} className={i === index ? 'on' : ''} aria-current={i === index ? 'step' : undefined}>{step}</li>)}</ol><div className="flag ok mt16"><Icon name="trygg" /><span>Personnummer i vanliga mejl är en GDPR-risk. Här lämnas de via BankID.</span></div></div>
      <div className="phone"><div className="screen" key={state.cust.step}><CustomerPhoneScreens thread={t} preview={Boolean(modal.preview)} /></div></div>
    </div>
  </section></div>;
}