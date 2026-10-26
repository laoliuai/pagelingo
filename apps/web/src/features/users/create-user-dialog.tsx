import { useState, type FormEvent } from 'react';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Modal } from '../../shared/ui/dialog';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Feedback } from '../../shared/ui/toast';
export function CreateUserDialog({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  function changeOpen(value: boolean) {
    if (pending) return;
    setOpen(value);
    setPassword('');
    setUsername('');
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError('');
    try {
      await apiRequest('/api/v1/admin/users', { method: 'POST', body: { username, password } });
      await onCreated();
      setOpen(false);
      setUsername('');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPassword('');
      setPending(false);
    }
  }
  return (
    <Modal
      title="创建用户"
      description="开通独立账号。用户名为 3–32 位小写字母、数字、下划线或短横线，并以字母开头。密码为 12–128 个字符。"
      open={open}
      onOpenChange={changeOpen}
      trigger={<Button primary>创建用户</Button>}
    >
      <form onSubmit={submit}>
        <Field label="用户名">
          <Input
            autoComplete="off"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="初始密码">
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Feedback message={error} error />
        <div className="form-actions">
          <Button type="button" disabled={pending} onClick={() => changeOpen(false)}>
            取消
          </Button>
          <Button primary type="submit" disabled={pending}>
            {pending ? '创建中…' : '创建账号'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
