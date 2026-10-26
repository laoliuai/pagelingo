import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { Feedback } from './toast';
import { errorMessage } from '../api-client';
export function Confirm({
  trigger,
  title,
  description,
  action,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  action: string;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!pending) {
          setOpen(value);
          setError('');
        }
      }}
    >
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="dialog">
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
          <Feedback message={error} error />
          <div className="form-actions">
            <AlertDialog.Cancel asChild>
              <Button disabled={pending}>取消</Button>
            </AlertDialog.Cancel>
            <Button
              primary
              disabled={pending}
              onClick={() => {
                setPending(true);
                void onConfirm()
                  .then(() => setOpen(false))
                  .catch((error) => setError(errorMessage(error)))
                  .finally(() => setPending(false));
              }}
            >
              {pending ? '处理中…' : action}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
