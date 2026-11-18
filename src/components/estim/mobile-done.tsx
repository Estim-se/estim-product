import { Button } from '@/components/ui/button';
import demo from '@/data/demo.json';
import type { Thread } from '@/data/inbox';
import { Icon } from './icon';
import { useEstim } from './store-provider';

export function MobileDone({ thread }: { thread: Thread }) {
  const { state, actions } = useEstim();
  const next = state.threads.find(t => t.status === 'svar');
  return <div className="mapp mobile-done"><div className="okmark"><Icon name="check" /></div><h3 className="mt16">Skickat till {thread.name.split(' ')[0]}</h3><p className="small muted mt8">Via {demo.channels[thread.ch as keyof typeof demo.channels]?.[0]} från Volt Visions nummer. AI:n hör av sig om kunden svarar.</p>
    {next && <Button variant="prototype" className="mbtn" onClick={() => actions.mobileGo('thread', next.id)}>Nästa: {next.name}</Button>}<Button variant="prototype" className="mbtn sec" onClick={() => actions.mobileGo('list')}>Till inkorgen</Button></div>;
}