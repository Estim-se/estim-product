import type { Thread } from '@/data/inbox';
import { Message } from './message';
import { Composer } from './composer';
import { StatusCard } from './status-card';
import { useEstim } from './store-provider';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { nearConversationBottom, SCROLL_JUMP_THRESHOLD, scrollToEdge } from '@/lib/inbox-layout';
import { ScrollJump } from './scroll-jump';
import { ConfirmDialog } from './confirm-dialog';

export function Conversation({ thread, contained = false, header }: { thread: Thread; contained?: boolean; header?: ReactNode }) {
  const { state, actions } = useEstim();
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const opened = useRef('');
  const [unseen, setUnseen] = useState(false);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const draft = state.drafts[thread.id];
  const pending = Boolean(draft && ['svar', 'oppnad'].includes(thread.status));
  const lastMsg = thread.msgs[thread.msgs.length - 1];
  const content = `${thread.msgs.length}:${lastMsg?.id ?? ''}:${lastMsg?.text.length ?? 0}:${lastMsg?.documents?.length ?? 0}`;
  const draftContent = draft?.edited ? 'edited' : draft?.text;
  function goBottom() {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
    nearBottom.current = true;
    setUnseen(false);
    setFarFromBottom(false);
  }
  useEffect(() => {
    if (!contained) return;
    if (opened.current !== thread.id || nearBottom.current) goBottom();
    else setUnseen(true);
    opened.current = thread.id;
  }, [contained, thread.id, content, draftContent]);
  useEffect(() => {
    const el = scroll.current;
    if (!contained || !el) return;
    const observer = new ResizeObserver(() => { if (nearBottom.current) goBottom(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [contained]);
  // A later customer message can start a new case; real messages use their stored id, demo ones their index.
  const [splitKey, setSplitKey] = useState<string | null>(null);
  const canSplit = (i: number) => contained && i > 0 && thread.msgs[i]?.from === 'kund' && thread.status !== 'analys';
  const messages = thread.msgs.map((message, i) => <Message key={i} message={message} thread={thread} onSplit={canSplit(i) ? () => setSplitKey(message.id ?? `i:${i}`) : undefined} />);
  const reply = pending ? <Composer thread={thread} /> : <StatusCard thread={thread} />;
  if (!contained) return <div className="conv">{messages}{reply}</div>;
  return <div className="contained-conversation">
    <div ref={scroll} className="conv message-scroll" role="region" aria-label="Meddelanden" tabIndex={0} onScroll={() => {
      const el = scroll.current;
      if (!el) return;
      nearBottom.current = nearConversationBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
      if (nearBottom.current) setUnseen(false);
      setFarFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_JUMP_THRESHOLD);
    }}>{header}{messages}<div className="reply-dock">{pending && <div className="pending-label small b">Svarsutkast väntar</div>}{reply}</div></div>
    {unseen && <Button variant="prototype" className="btn btn-ghost btn-sm new-message" aria-label="Nytt meddelande, gå till senaste meddelandet" onClick={goBottom}>Nytt meddelande ↓</Button>}
    {!unseen && farFromBottom && <ScrollJump direction="down" label="Till slutet av konversationen" onClick={() => scrollToEdge(scroll.current, 'bottom')} />}
    <ConfirmDialog
      open={splitKey !== null}
      onOpenChange={open => { if (!open) setSplitKey(null); }}
      title="Flytta till nytt ärende?"
      description="Meddelandet och allt som kommit efter det flyttas till ett nytt ärende för samma kund. AI:n läser det nya ärendet, och offerten stannar kvar i det här."
      confirmLabel="Flytta"
      onConfirm={() => { if (splitKey) actions.splitThread(thread.id, splitKey); setSplitKey(null); }}
    />
  </div>;
}