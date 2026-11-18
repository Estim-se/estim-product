import { Button } from '@/components/ui/button';
import { Icon } from './icon';

// Mobile scene and guided demo remain deferred; match the existing Inbox controls.
export function TopHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return <header className="topbar"><div className="min-w-0"><div className="crumbs"><h1>{title}</h1></div><div className="small muted mt4">{subtitle}</div></div><div className="topright"><div className="viewseg"><Button variant="prototype" className="on" aria-pressed="true"><Icon name="desk" />Dator</Button><Button variant="prototype" disabled><Icon name="mobile" />Mobil</Button></div><Button variant="prototype" className="btn btn-sm btn-ink" disabled><Icon name="play" />Guidad demo</Button></div></header>;
}