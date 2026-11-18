import type { Thread } from '@/data/inbox';
import { Message } from './message';
import { Composer } from './composer';
import { StatusCard } from './status-card';
import { useEstim } from './store-provider';

export function Conversation({ thread }: { thread: Thread }) {
  const { state } = useEstim();
  return <div className="conv">{thread.msgs.map((message, i) => <Message key={i} message={message} thread={thread} />)}{state.drafts[thread.id] && ['svar', 'oppnad'].includes(thread.status) ? <Composer thread={thread} /> : <StatusCard thread={thread} />}</div>;
}