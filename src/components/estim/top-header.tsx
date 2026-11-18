import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { Link, useLocation } from '@tanstack/react-router';
import { useEstim } from './store-provider';

// The phone scene shares all thread state; the guided demo remains deferred.
export function TopHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const { state, actions } = useEstim();
  const path = useLocation().pathname;
  const mobile = path === '/mobil';
  return <header className="topbar"><div className="min-w-0"><div className="crumbs"><h1>{title}</h1></div><div className="small muted mt4">{subtitle}</div></div><div className="topright"><div className="viewseg">{mobile ? <Button asChild variant="prototype"><Link to={state.desktopPath} onClick={() => actions.update(s => { s.view = 'desk'; })}><Icon name="desk" />Dator</Link></Button> : <Button variant="prototype" className="on" aria-pressed="true"><Icon name="desk" />Dator</Button>}<Button asChild variant="prototype" className={mobile ? 'on' : ''}><Link to="/mobil" onClick={() => actions.openMobile(path)}><Icon name="mobile" />Mobil</Link></Button></div><Button variant="prototype" className="btn btn-sm btn-ink" disabled><Icon name="play" />Guidad demo</Button></div></header>;
}