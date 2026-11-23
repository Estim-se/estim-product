import { useState } from 'react';
import type { Thread } from '@/data/inbox';
import { threadStatus } from '@/data/inbox';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';
import { useEstim } from './store-provider';
import { useWorkspace } from './workspace-provider';
import { realSentStatus } from '@/lib/real-presentation';
import { ConfirmDialog } from './confirm-dialog';

// Thread identity and actions live at the top of the info column so they stay reachable
// while the conversation scrolls, without taking vertical space from the messages.
export function ThreadHeader({
  thread: t,
  customerThreadsCount = 1,
  onOpenHub,
  onCreateQuote,
}: {
  thread: Thread;
  customerThreadsCount?: number;
  onOpenHub?: (() => void) | undefined;
  onCreateQuote?: (() => void) | undefined;
}) {
  const { actions } = useEstim();
  const real = useWorkspace().mode === 'real';
  const status = real && t.status === 'skickad' ? realSentStatus(t) : threadStatus(t);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isWon = t.status === 'vunnen';
  const hasMultiple = customerThreadsCount > 1 && Boolean(onOpenHub);

  return (
    <>
      <div className="thread-panel">
        <div className="thread-panel-id">
          <div className="avatar">{t.ini}</div>
          <div className="grow">
            <div className="thread-panel-name"><b>{t.name}</b><span className={`chip ${status[1]}`}>{status[0]}</span></div>
            <div className="small muted">{t.job}{t.place ? ` · ${t.place}` : ''}</div>
          </div>
        </div>
        {/* One full-width action per row, same size, in a fixed order. */}
        <div className="thread-panel-actions">
          {hasMultiple && (
            <Button
              variant="prototype"
              className="btn btn-ghost btn-sm"
              onClick={onOpenHub}
              aria-label={`Visa alla ${customerThreadsCount} konversationer för ${t.name}`}
            >
              <Icon name="back" /><Icon name="chatt" />Alla ({customerThreadsCount})
            </Button>
          )}
          <Button
            variant="prototype"
            className="btn btn-ghost btn-sm"
            onClick={() => actions.toast(real ? 'Telefoni är inte ansluten.' : `Ringer ${t.phone !== '—' ? t.phone : '(inget nummer)'} (demo)`)}
          >
            <Icon name="phone" />Ring
          </Button>
          <Button
            variant="prototype"
            className="apt"
            role="switch"
            disabled={real && t.ch !== 'wa'}
            aria-checked={t.autopilot}
            onClick={() => actions.toggleAuto(t.id)}
          >
            <span className={`toggle ${t.autopilot ? 'on' : ''}`} />AI svarar själv
          </Button>
          <Button
            variant="prototype"
            className={`btn btn-sm ${isWon ? 'btn-lime' : 'btn-ghost'}`}
            onClick={() => setConfirmOpen(true)}
            title={isWon ? 'Klicka för att återställa till skickad' : 'Markera detta jobb som vunnet'}
          >
            <Icon name="check" />{isWon ? 'Vunnet jobb' : 'Markera vunnen'}
          </Button>
          {onCreateQuote && (
            <Button variant="prototype" className="btn btn-primary btn-sm" onClick={onCreateQuote}>
              <Icon name="offert" />Skapa offert
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={isWon ? 'Återställ jobbet?' : 'Markera jobbet som vunnet?'}
        description={isWon
          ? 'Jobbet flyttas tillbaka till inkorgen bland aktiva ärenden.'
          : 'Jobbet flyttas till Vunna. Nya meddelanden från kunden startar en separat konversation.'}
        confirmLabel={isWon ? 'Återställ' : 'Markera vunnen'}
        onConfirm={() => actions.markWon(t.id)}
      />
    </>
  );
}
