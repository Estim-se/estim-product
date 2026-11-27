import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollJump } from './scroll-jump';
import { waitingThreads } from '@/data/inbox';
import { AppShell } from './app-shell';
import { InboxList } from './inbox-list';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { ThreadHeader } from './thread-header';
import { Conversation } from './conversation';
import { ContextPanel, CustomerCard } from './context-panel';
import { TopHeader } from './top-header';
import { useWorkspace } from './workspace-provider';
import { NewRequest, type RequestPrefill } from './new-request';
import { Button } from '@/components/ui/button';
import { customerKeyOf, latestActivityOrder, SCROLL_JUMP_THRESHOLD, scrollToEdge } from '@/lib/inbox-layout';
import { CustomerHub } from './customer-hub';
import { pendingCallThreads, SAMTAL_ITEM, SamtalCallDetails, SamtalCallPane, SamtalCallTasks, useSamtalCalls } from './samtal-inbox';

export function InboxScreen() {
  const { state, actions } = useEstim();
  const { threads, sel: selected, filter } = state;
  const waiting = waitingThreads(threads).length;
  const current = threads.find(t => t.id === selected);
  const workspace = useWorkspace(), real = workspace.mode === 'real';
  // false = closed; otherwise open, optionally prefilled with the customer whose hub is open.
  const [newRequest, setNewRequest] = useState<false | { prefill?: RequestPrefill }>(false);
  const [mobileThread, setMobileThread] = useState(false);
  const [tab, setTab] = useState<'chat' | 'info'>('chat');
  const [viewingHubKey, setViewingHubKey] = useState<string | null>(null);

  const orderedThreads = useMemo(() => {
    if (!real) return threads;
    const activity = new Map(workspace.data?.threads.map(t => [t.id, Math.max(Date.parse(t.last_message_at), Date.parse(t.updated_at))]));
    workspace.data?.drafts.forEach(d => activity.set(d.thread_id, Math.max(activity.get(d.thread_id) ?? 0, Date.parse(d.updated_at))));
    return latestActivityOrder(threads, activity);
  }, [real, threads, workspace.data?.threads, workspace.data?.drafts]);
  // estim Samtal: calls awaiting confirmation are ordinary list items until they are confirmed or dismissed.
  const samtalCalls = useSamtalCalls();
  const callItems = real ? pendingCallThreads(samtalCalls) : [];
  const [callSel, setCallSel] = useState<string | null>(null);
  const pending = Boolean(current && state.drafts[current.id] && ['svar', 'oppnad'].includes(current.status));

  const currentCustomerKey = current ? customerKeyOf(current) : '';
  const currentCustomerThreads = useMemo(() => {
    if (!currentCustomerKey) return [];
    return orderedThreads.filter(t => customerKeyOf(t) === currentCustomerKey);
  }, [orderedThreads, currentCustomerKey]);
  const showingHub = Boolean(viewingHubKey) && currentCustomerThreads.length > 1;
  const infoScroll = useRef<HTMLDivElement>(null);
  const [infoScrolled, setInfoScrolled] = useState(false);
  // A different conversation (or the hub) starts its info column from the top.
  useEffect(() => {
    if (infoScroll.current) infoScroll.current.scrollTop = 0;
    setInfoScrolled(false);
  }, [current?.id, showingHub]);
  // "To top" sits centred at the top of the visible info area: below the card where the card is
  // sticky (desktop), at the very top where the card scrolls away (mobile).
  const [jumpTop, setJumpTop] = useState(12);
  useEffect(() => {
    const panel = infoScroll.current?.querySelector<HTMLElement>(':scope > .thread-panel');
    if (!panel || typeof ResizeObserver === 'undefined') { setJumpTop(12); return; }
    const measure = () => setJumpTop(getComputedStyle(panel).position === 'sticky' ? panel.offsetHeight + 8 : 12);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [current?.id, showingHub]);

  function select(id: string, customerKey?: string, isMulti?: boolean) {
    if (id.startsWith(SAMTAL_ITEM)) { setCallSel(id); setViewingHubKey(null); setMobileThread(true); setTab('chat'); return; }
    setCallSel(null);
    // Opening the hub only points at the customer; a conversation is marked read when it is opened.
    if (isMulti && customerKey) actions.update(s => { s.sel = id; });
    else actions.select(id);
    if (isMulti && customerKey) {
      setViewingHubKey(customerKey);
    } else {
      setViewingHubKey(null);
    }
    setMobileThread(true);
    setTab('chat');
  }

  return (
    <AppShell waiting={waiting} onReset={actions.reset}>
      <div className={mobileThread ? 'inbox-page-heading mobile-thread-open' : 'inbox-page-heading'}>
        <TopHeader title="Inkorg" besideTitle={<span className="inbox-waiting small"><Icon name="user" /><b>{waiting}</b> väntar på dig</span>} />
        {!real && (
          <div className="strip">
            <span><Icon name="spark" />AI har svarat <b>{state.stats.ai} kunder</b> idag</span>
            <span><Icon name="tid" />Första svar: <b>{state.stats.sek} s</b> i snitt</span>
          </div>
        )}
      </div>

      {current && (
        <header className={`mobile-thread-bar${mobileThread ? ' open' : ''}`}>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <Button
              variant="prototype"
              className="xbtn shrink-0"
              aria-label="Tillbaka till inkorgen"
              onClick={() => {
                setMobileThread(false);
                setViewingHubKey(null);
              }}
            >
              <Icon name="back" />
            </Button>
            <div className="mobile-inbox-name min-w-0">
              <span className="xs muted">Inkorg:</span>
              <b className="block truncate">{current.name}</b>
            </div>
          </div>
          <div className="row mobile-tabs" role="tablist" aria-label="Visa kundens ärende">
            <Button
              variant="prototype"
              className={`fchip ${tab === 'chat' ? 'on' : ''}`}
              role="tab"
              aria-selected={tab === 'chat'}
              aria-controls="inbox-chat"
              onClick={() => setTab('chat')}
            >
              Meddelanden{pending && <span className="dot dot-attention" aria-label="Svarsutkast väntar" />}
            </Button>
            <Button
              variant="prototype"
              className={`fchip ${tab === 'info' ? 'on' : ''}`}
              role="tab"
              aria-selected={tab === 'info'}
              aria-controls="inbox-info"
              onClick={() => setTab('info')}
            >
              Info
            </Button>
          </div>
        </header>
      )}


      <div className={`ib2 fadein real-inbox${mobileThread ? ' thread-open' : ''} tab-${tab}`}>
        <InboxList
          threads={[...callItems, ...orderedThreads]}
          selected={callSel ?? selected}
          filter={filter}
          real={real}
          onFilter={filter => actions.update(s => { s.filter = filter; })}
          onSelect={select}
          onSimulate={() => {
            if (real) setNewRequest({});
            else actions.simNew();
          }}
        />

        {callSel && (
          <>
            <div className="tv" id="inbox-chat"><SamtalCallPane id={callSel} onDone={id => { setCallSel(null); if (id) actions.select(id); }} /></div>
            <section id="inbox-info" className="inbox-info"><div className="info-scroll"><div className="ctx">
              {(() => { const t = callItems.find(c => c.id === callSel); return t ? <CustomerCard thread={t} /> : null; })()}
              <SamtalCallTasks id={callSel} /></div></div></section>
          </>
        )}
        {!callSel && current && (
          <>
            <div className="tv" id="inbox-chat">
              {showingHub ? (
                <CustomerHub
                  customerName={current.name}
                  customerInitials={current.ini}
                  customerPlace={current.place}
                  threads={currentCustomerThreads}
                  selectedThreadId={current.id}
                  real={real}
                  onSelectThread={(id) => {
                    actions.select(id);
                    setViewingHubKey(null);
                  }}
                  onNewConversation={() => {
                    if (!real) { actions.simNew(); return; }
                    const known = (v: string) => (v === '—' ? '' : v);
                    // A call (estim Samtal) is followed up by SMS, as its reply draft.
                    const channel = current.ch === 'wa' || current.ch === 'sms' || current.ch === 'form' ? current.ch : current.ch === 'samtal' ? 'sms' : 'email';
                    setNewRequest({ prefill: { name: current.name, email: known(current.email), phone: known(current.phone), address: known(current.addr), place: current.place, channel } });
                  }}
                />
              ) : (
                <>{real && <SamtalCallDetails threadId={current.id} />}<Conversation thread={current} contained /></>
              )}
            </div>

            {/* The hub shows several conversations, so only customer-level details belong here;
                thread status, actions and quote stay hidden until one conversation is opened. */}
            {/* The thread card scrolls with the info (sticky on desktop via CSS, not on mobile). */}
            <section id="inbox-info" className="inbox-info">
              <div
                ref={infoScroll}
                className="info-scroll"
                role="region"
                aria-label={showingHub ? 'Kunduppgifter' : 'Kunduppgifter och händelser'}
                tabIndex={0}
                onScroll={e => setInfoScrolled(e.currentTarget.scrollTop > SCROLL_JUMP_THRESHOLD)}
              >
                {showingHub ? (
                  <div className="ctx"><CustomerCard thread={current} /></div>
                ) : (
                  <>
                    <ThreadHeader
                      thread={current}
                      customerThreadsCount={currentCustomerThreads.length}
                      onOpenHub={currentCustomerThreads.length > 1 ? () => { setViewingHubKey(currentCustomerKey); setTab('chat'); } : undefined}
                      onCreateQuote={real && !current.q ? () => void workspace.realStore.createQuote(current.id) : undefined}
                    />
                    <ContextPanel thread={current} />
                    {real && <div className="ctx"><SamtalCallTasks id={current.id} /></div>}
                  </>
                )}
              </div>
              {infoScrolled && <ScrollJump direction="up" label="Till toppen" style={{ top: jumpTop }} onClick={() => scrollToEdge(infoScroll.current, 'top')} />}
            </section>
          </>
        )}
      </div>

      {real && newRequest && <NewRequest prefill={newRequest.prefill} onClose={() => setNewRequest(false)} />}
    </AppShell>
  );
}
