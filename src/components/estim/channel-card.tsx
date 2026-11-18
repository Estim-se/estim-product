import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import type { channels } from '@/data/prototype-pages';
import { Icon } from './icon';
import { useEstim } from './store-provider';

export function ChannelCard({ channel: c }: { channel: (typeof channels)[number] }) {
  const { actions } = useEstim(), navigate = useNavigate();
  return <div className="card chcard"><div className="top"><span className="chi"><Icon name={c.icon} /></span><div className="grow"><b>{c.name}</b><div className="xs muted">{c.sub}</div></div>{c.connected ? <span className="chip chip-sage"><span className="dot" />Ansluten</span> : <span className="chip chip-line">Kommer snart</span>}</div><p>{c.text}</p>{c.test && <div><Button variant="prototype" className="btn btn-ghost btn-sm" onClick={() => { actions.simNew(); void navigate({ to: '/' }); }}><Icon name="send" />Skicka testförfrågan</Button></div>}</div>;
}