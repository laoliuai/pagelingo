import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '../../app/session';
import { errorMessage } from '../../shared/api-client';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Button } from '../../shared/ui/button';
import { Feedback } from '../../shared/ui/toast';
import { ThemeButton } from '../../shared/layouts/app-shell';
export function LoginPage() {
  const { user, login } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  if (user) return <Navigate to="/library" replace />;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await login(username, password);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPassword('');
      setPending(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-theme">
        <ThemeButton />
      </div>
      <section className="login-card">
        <div className="brand">
          <span className="brand-mark">P</span>PageLingo
        </div>
        <div className="eyebrow">个人学习空间</div>
        <h1>欢迎回来</h1>
        <p className="muted">登录后，继续你的阅读与学习。</p>
        <form onSubmit={submit}>
          <Field label="用户名">
            <Input
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={pending}
            />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
            />
          </Field>
          <Feedback message={error} error />
          <Button primary type="submit" disabled={pending}>
            {pending ? '登录中…' : '登录'}
          </Button>
        </form>
        <p className="login-note">账号由管理员开通。资料与模型配置仅属于你。</p>
      </section>
    </main>
  );
}
