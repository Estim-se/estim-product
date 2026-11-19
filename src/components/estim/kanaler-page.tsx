import { channels } from '@/data/prototype-pages';
import { ChannelCard } from './channel-card';
import { TopHeader } from './top-header';
import { useWorkspace } from './workspace-provider';
import { RealChannels } from './real-channels';

export function KanalerPage() {
  const workspace=useWorkspace();
  if(workspace.mode==='real')return <RealChannels />;
  return <><TopHeader title="Kanaler" subtitle="Kunden skriver där den vill. Allt hamnar i samma inkorg och svaret går ut i samma kanal." /><div className="grid2 fadein channels-grid">{channels.map(c => <ChannelCard key={c.name} channel={c} />)}</div></>;
}