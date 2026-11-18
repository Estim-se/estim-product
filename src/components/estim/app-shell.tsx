import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import demo from '@/data/demo.json';
import { Icon } from './icon';
import { Logo } from './logo';
import { useEstim } from './store-provider';

// Route-aware links preserve native navigation and the shared prototype state.
export function AppShell({ children, waiting, onReset }: {
  children: ReactNode; waiting: number; onReset: () => void;
}) {
  const { actions } = useEstim();
  const path = useLocation().pathname;
  return <div className="app">
    <aside className="side" aria-label="Huvudnavigation">
      <div className="side-logo"><Logo /></div>
      <div className="ws"><div className="ws-badge">{demo.company.initials}</div><div><b>{demo.company.name}</b><span>{demo.company.users}</span></div></div>
      <div className="eyebrow">Kommunikation</div>
      <Button asChild variant="prototype" className="nav"><Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'active' }} title="Inkorg"><Icon name="inbox" /><span>Inkorg</span>{waiting > 0 && <span className="count">{waiting}</span>}</Link></Button>
      <Button asChild variant="prototype" className="nav"><Link to="/offerter" activeProps={{ className: 'active' }} title="Offerter"><Icon name="offert" /><span>Offerter</span></Link></Button>
      <div className="eyebrow">Ställ in</div>
      <Button asChild variant="prototype" className="nav"><Link to="/kanaler" activeProps={{ className: 'active' }} title="Kanaler"><Icon name="plug" /><span>Kanaler</span></Link></Button>
      <Button asChild variant="prototype" className="nav"><Link to="/installningar" activeProps={{ className: 'active' }} title="AI och inställningar"><Icon name="settings" /><span>AI och inställningar</span></Link></Button>
      <div className="side-bottom">
        <Button asChild variant="prototype" className="nav"><Link to="/mobil" activeProps={{ className: 'active' }} title="Appen i mobilen" onClick={() => actions.openMobile(path)}><Icon name="mobile" /><span>Appen i mobilen</span></Link></Button>
        <Button variant="prototype" className="reset" onClick={onReset}>Återställ demo</Button>
      </div>
    </aside>
    <main className="main"><div className="panel">{children}</div></main>
  </div>;
}