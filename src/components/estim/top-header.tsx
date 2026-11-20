import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { Link, useLocation } from '@tanstack/react-router';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';
import type { ReactNode } from 'react';

// The phone scene shares all thread state; the guided demo remains deferred.
export function TopHeader({ title, subtitle, besideTitle }: { title: string; subtitle?: string; besideTitle?: ReactNode }) {
  const { actions } = useEstim();
  const workspace = useWorkspace();
  const { mode } = workspace;
  const path = useLocation().pathname;
  const mobile = path === '/mobil';
  return <header className="topbar"><div className="min-w-0"><div className={besideTitle ? 'crumbs inbox-title-row' : 'crumbs'}><h1>{title}</h1>{besideTitle}</div>{subtitle && <div className="small muted mt4">{subtitle}</div>}</div><div className="topright"><div className={`viewseg mobile-mode-switch${mobile ? ' phone-scene-mode' : ''}`} role="group" aria-label="Välj läge"><Button variant="prototype" className={mode === 'real' ? 'on' : ''} aria-pressed={mode === 'real'} onClick={() => workspace.setMode('real')}>Live</Button><Button variant="prototype" className={mode === 'demo' ? 'on' : ''} aria-pressed={mode === 'demo'} onClick={() => workspace.setMode('demo')}>Demo</Button></div>{mode === 'demo' && <><div className={`viewseg desktop-view-switch${mobile ? ' phone-scene-hidden' : ''}`}><Button variant="prototype" className="on" aria-pressed="true"><Icon name="desk" />Dator</Button><Button asChild variant="prototype"><Link to="/mobil" onClick={() => actions.openMobile(path)}><Icon name="mobile" />Mobil</Link></Button></div><Button variant="prototype" className="btn btn-sm btn-ink guided-demo-control" disabled><Icon name="play" />Guidad demo</Button></>}</div></header>;
}