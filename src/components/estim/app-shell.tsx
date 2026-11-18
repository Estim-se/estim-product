import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import demo from '@/data/demo.json';
import { Icon } from './icon';
import { Logo } from './logo';

// Later-stage destinations stay visible but cannot open unfinished screens.
export function AppShell({ children, waiting, onReset }: {
  children: ReactNode; waiting: number; onReset: () => void;
}) {
  return <div className="app">
    <aside className="side" aria-label="Huvudnavigation">
      <div className="side-logo"><Logo /></div>
      <div className="ws"><div className="ws-badge">{demo.company.initials}</div><div><b>{demo.company.name}</b><span>{demo.company.users}</span></div></div>
      <div className="eyebrow">Kommunikation</div>
      <Button asChild variant="prototype" className="nav active"><Link to="/" title="Inkorg"><Icon name="inbox" /><span>Inkorg</span>{waiting > 0 && <span className="count">{waiting}</span>}</Link></Button>
      <Button variant="prototype" className="nav" disabled title="Offerter"><Icon name="offert" /><span>Offerter</span></Button>
      <div className="eyebrow">Ställ in</div>
      <Button variant="prototype" className="nav" disabled title="Kanaler"><Icon name="plug" /><span>Kanaler</span></Button>
      <Button variant="prototype" className="nav" disabled title="AI och inställningar"><Icon name="settings" /><span>AI och inställningar</span></Button>
      <div className="side-bottom">
        <Button variant="prototype" className="nav" disabled title="Appen i mobilen"><Icon name="mobile" /><span>Appen i mobilen</span></Button>
        <Button variant="prototype" className="reset" onClick={onReset}>Återställ demo</Button>
      </div>
    </aside>
    <main className="main"><div className="panel">{children}</div></main>
  </div>;
}