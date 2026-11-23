import type { Thread } from '@/data/inbox';
import { channelIcon, threadStatus } from '@/data/inbox';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { realSentStatus } from '@/lib/real-presentation';
import { calc, kr } from '@/lib/quote';

export function CustomerHub({
  customerName,
  customerInitials,
  customerPlace,
  threads,
  selectedThreadId,
  onSelectThread,
  onNewConversation,
  real = false,
}: {
  customerName: string;
  customerInitials: string;
  customerPlace?: string;
  threads: Thread[];
  selectedThreadId: string;
  onSelectThread: (id: string) => void;
  onNewConversation?: () => void;
  real?: boolean;
}) {
  return (
    <div className="customer-hub">
      <div className="card tight thead customer-hub-head">
        <div className="avatar">{customerInitials}</div>
        <div className="grow">
          <div className="row wrap customer-hub-title">
            <b>{customerName}</b>
            <span className="chip chip-line">{threads.length} konversationer</span>
          </div>
          <div className="small muted mt4">
            {customerPlace ? `${customerPlace} · ` : ''}Välj ett ärende nedan för att öppna chatten
          </div>
        </div>
        {onNewConversation && (
          <Button variant="prototype" className="btn btn-ghost btn-sm new-request-button" onClick={onNewConversation}>
            <Icon name="plus" />Ny förfrågan
          </Button>
        )}
      </div>

      <div className="customer-hub-list mt16" role="region" aria-label={`Konversationer för ${customerName}`}>
        {threads.map(t => {
          const status = real && t.status === 'skickad' ? realSentStatus(t) : threadStatus(t);
          const last = [...t.msgs].reverse().find(m => m.text);
          const who = last?.from === 'kund' ? '' : last?.from === 'ai' ? 'AI: ' : 'Du: ';
          const isSelected = t.id === selectedThreadId;
          const quoteAmount = t.q ? calc(t.q) : null;
          const isWaiting = t.status === 'svar' || (t.status === 'oppnad' && !t.autopilot);
          const isWon = t.status === 'vunnen';

          return (
            <Button
              key={t.id}
              variant="prototype"
              className={`customer-hub-card ${isSelected ? 'on' : ''} ${isWaiting ? 'waiting' : ''} ${isWon ? 'won' : ''}`}
              aria-label={t.job || 'Förfrågan'}
              onClick={() => onSelectThread(t.id)}
            >
              <div className="hub-card-icon">
                <Icon name={isWon ? 'check' : channelIcon(t.ch)} />
                {isWaiting && <span className="hub-waiting-badge" title="Väntar på dig" />}
              </div>
              <div className="grow">
                <div className="row between thread-top">
                  <div className="row gap6 items-center">
                    <b className="customer-hub-job">{t.job || 'Ny förfrågan'}</b>
                    {isWaiting && <span className="hub-waiting-dot" title="Väntar på dig" />}
                  </div>
                  <span className="xs muted">{t.time}</span>
                </div>
                <div className="snip">
                  {who + (last?.text ?? 'Inga meddelanden').replace(/\n/g, ' ')}
                </div>
                <div className="row between mt8 thread-bottom">
                  <span className="thread-pills">
                    <span className={`chip ${status[1]}`}>{status[0]}</span>
                    {t.q && <span className="chip chip-line">Offert #{t.q.nr}{quoteAmount ? ` · ${kr(quoteAmount.betala)}` : ''}</span>}
                    {t.autopilot && <span className="ai-tag"><Icon name="spark" />Auto</span>}
                  </span>
                  <span className="hub-arrow" aria-hidden="true">
                    <Icon name="arrow" />
                  </span>
                </div>
              </div>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
