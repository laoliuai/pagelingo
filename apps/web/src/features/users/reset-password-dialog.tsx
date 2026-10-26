import { useState, type FormEvent } from 'react';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Modal } from '../../shared/ui/dialog';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Feedback } from '../../shared/ui/toast';
export function ResetPasswordDialog({ userId, username }: { userId: string; username: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  function change(value: boolean) {
    if (!pending) {
      setOpen(value);
      setPassword('');
      setMessage('');
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setMessage('');
    try {
      await apiRequest<void>(`/api/v1/admin/users/${userId}/reset-password`, {
        method: 'POST',
        body: { newPassword: password },
      });
      setOpen(false);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPassword('');
      setPending(false);
    }
  }
  return (
    <Modal
      title={`重置 ${username} 的密码`}
      description="重置会撤销该用户所有会话。确认后请安全地告知用户新密码。"
      trigger={<Button>重置密码</Button>}
      open={open}
      onOpenChange={change}
    >
      <form onSubmit={submit}>
        <Field label="新密码">
          <Input
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Feedback message={message} error />
        <div className="form-actions">
          <Button type="button" disabled={pending} onClick={() => change(false)}>
            取消
          </Button>
          <Button primary type="submit" disabled={pending}>
            {pending ? '重置中…' : '确认重置密码'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
