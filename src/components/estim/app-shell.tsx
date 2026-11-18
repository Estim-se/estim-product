import type { ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import demo from '@/data/demo.json';
import { Icon } from './icon';
import { Logo } from './logo';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';
import { WorkspaceAccess } from './workspace-access';

// Route-aware links preserve native navigation and the shared prototype state.
export function AppShell({ children, waiting, onReset }: {
  children: ReactNode; waiting: number; onReset: () => void;
}) {
  const { actions } = useEstim();
  const path = useLocation().pathname;
  const workspace = useWorkspace();
  const real = workspace.mode === 'real';
  const company = real ? workspace.data?.company?.name ?? 'Ditt företag' : demo.company.name;
  return <div className="app">
    <aside className="side" aria-label="Huvudnavigation">
      <div className="side-logo"><Logo /></div>
      <div className="ws"><div className="ws-badge">{real ? company.split(' ').map(n=>n[0]).slice(0,2).join('') : demo.company.initials}</div><div><b>{company}</b><span>{real ? workspace.data?.profile?.display_name ?? '' : demo.company.users}</span></div></div>
      <div className="mode-switch" aria-label="Välj läge"><Button variant="prototype" className={real?'':'on'} aria-pressed={!real} title="Demoläge" onClick={()=>workspace.setMode('demo')}><Icon name="play"/><span>Demoläge</span></Button><Button variant="prototype" className={real?'on':''} aria-pressed={real} title="Verkligt läge" onClick={()=>workspace.setMode('real')}><Icon name="inbox"/><span>Verkligt läge</span></Button></div>
      <div className="eyebrow">Kommunikation</div>
      <Button asChild variant="prototype" className="nav"><Link to="/" activeOptions={{ exact: true }} activeProps={{ className: 'active' }} title="Inkorg"><Icon name="inbox" /><span>Inkorg</span>{waiting > 0 && <span className="count">{waiting}</span>}</Link></Button>
      <Button asChild variant="prototype" className="nav"><Link to="/offerter" activeProps={{ className: 'active' }} title="Offerter"><Icon name="offert" /><span>Offerter</span></Link></Button>
      <div className="eyebrow">Ställ in</div>
      <Button asChild variant="prototype" className="nav"><Link to="/kanaler" activeProps={{ className: 'active' }} title="Kanaler"><Icon name="plug" /><span>Kanaler</span></Link></Button>
      <Button asChild variant="prototype" className="nav"><Link to="/installningar" activeProps={{ className: 'active' }} title="AI och inställningar"><Icon name="settings" /><span>AI och inställningar</span></Link></Button>
      <div className="side-bottom">
        <Button asChild variant="prototype" className="nav"><Link to="/mobil" activeProps={{ className: 'active' }} title="Appen i mobilen" onClick={() => actions.openMobile(path)}><Icon name="mobile" /><span>Appen i mobilen</span></Link></Button>
        {!real&&<Button variant="prototype" className="reset" onClick={onReset}>Återställ demo</Button>}
        {workspace.signedIn?<Button variant="prototype" className="nav" title="Logga ut" onClick={()=>void workspace.signOut()}><Icon name="back"/><span>Logga ut</span></Button>:<Button asChild variant="prototype" className="nav"><Link to="/auth" title="Logga in"><Icon name="user"/><span>Logga in</span></Link></Button>}
      </div>
    </aside>
    <main className="main"><div className="panel"><WorkspaceAccess>{children}</WorkspaceAccess></div></main>
  </div>;
}