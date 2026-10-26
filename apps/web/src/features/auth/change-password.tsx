import { useState, type FormEvent } from 'react';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Button } from '../../shared/ui/button';
import { Feedback } from '../../shared/ui/toast';
import { Confirm } from '../../shared/ui/alert-dialog';
export function ChangePassword() {
  const { clear, logout } = useSession();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      if (Array.from(newPassword).length < 12 || Array.from(newPassword).length > 128)
        throw new Error();
      await apiRequest('/api/v1/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      clear();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setCurrent('');
      setNew('');
      setPending(false);
    }
  }
  return (
    <section className="form-panel account-panel">
      <h2>账户安全</h2>
      <p>修改密码将注销所有设备，请重新登录。新密码需为 12–128 个字符。</p>
      <form onSubmit={submit}>
        <Field label="当前密码">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="新密码">
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
          />
        </Field>
        <Feedback message={error} error />
        <div className="form-actions">
          <Button disabled={pending} type="submit">
            {pending ? '修改中…' : '修改密码并重新登录'}
          </Button>
        </div>
      </form>
      <div className="security-action">
        <Confirm
          title="退出所有设备？"
          description="所有现有会话都会失效，需重新登录。"
          action="确认退出所有设备"
          trigger={<Button>退出所有设备</Button>}
          onConfirm={() => logout(true)}
          failureMessage="退出失败，仍保持登录。请重试。"
        />
      </div>
    </section>
  );
}
