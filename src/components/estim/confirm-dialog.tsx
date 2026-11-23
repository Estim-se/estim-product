import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from '@/components/ui/button';
import { Icon } from './icon';

// App-styled confirmation (ov/md classes) for actions that change stored records.
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  title: string; description: string; confirmLabel: string; onConfirm: () => void;
}) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="ov confirm-overlay" />
      <AlertDialog.Content className="md confirm-modal">
        <div className="md-h"><AlertDialog.Title className="overlay-heading">{title}</AlertDialog.Title></div>
        <div className="md-b"><AlertDialog.Description className="small muted">{description}</AlertDialog.Description></div>
        <div className="md-f confirm-actions">
          <AlertDialog.Cancel asChild><Button variant="prototype" className="btn btn-ghost btn-sm">Avbryt</Button></AlertDialog.Cancel>
          <AlertDialog.Action asChild><Button variant="prototype" className="btn btn-primary btn-sm" onClick={onConfirm}><Icon name="check" />{confirmLabel}</Button></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
