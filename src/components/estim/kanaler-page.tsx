import { channels } from '@/data/prototype-pages';
import { ChannelCard } from './channel-card';
import { TopHeader } from './top-header';
import { useWorkspace } from './workspace-provider';

export function KanalerPage() {
  const workspace=useWorkspace();
  if(workspace.mode==='real')return <><TopHeader title="Kanaler" subtitle="Inga kanaler är anslutna ännu."/><div className="mt24"><h2>Inkommande e-post</h2><p className="mt8">{workspace.data?.company?.inbound_address}</p><span className="chip chip-line mt12">Inte ansluten</span></div></>;
  return <><TopHeader title="Kanaler" subtitle="Kunden skriver där den vill. Allt hamnar i samma inkorg och svaret går ut i samma kanal." /><div className="grid2 fadein channels-grid">{channels.map(c => <ChannelCard key={c.name} channel={c} />)}</div></>;
}