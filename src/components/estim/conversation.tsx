import type { Thread } from '@/data/inbox';
import { Message } from './message';
import { Composer } from './composer';
import { StatusCard } from './status-card';
import { useEstim } from './store-provider';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { nearConversationBottom, SCROLL_JUMP_THRESHOLD, scrollToEdge } from '@/lib/inbox-layout';
import { ScrollJump } from './scroll-jump';

export function Conversation({ thread, contained = false, header }: { thread: Thread; contained?: boolean; header?: ReactNode }) {
  const { state } = useEstim();
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const opened = useRef('');
  const [unseen, setUnseen] = useState(false);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const draft = state.drafts[thread.id];
  const pending = Boolean(draft && ['svar', 'oppnad'].includes(thread.status));
  const content = JSON.stringify(thread.msgs);
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
  const messages = thread.msgs.map((message, i) => <Message key={i} message={message} thread={thread} />);
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
  </div>;
}