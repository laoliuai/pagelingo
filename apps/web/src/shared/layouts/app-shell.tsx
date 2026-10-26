import { NavLink, Outlet } from 'react-router-dom';
import { BookOpen, Settings2, Users, Moon, LogOut } from 'lucide-react';
import { useSession } from '../../app/session';
import { Button } from '../ui/button';
import { Feedback } from '../ui/toast';
import { useState } from 'react';
export function ThemeButton() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'light');
  return (
    <Button
      aria-label="切换明暗主题"
      className="icon-button"
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        setTheme(next);
        try {
          localStorage.setItem('pgl-theme', next);
        } catch {}
      }}
    >
      <Moon size={18} />
    </Button>
  );
}
export function AppShell() {
  const { user, logout } = useSession();
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>PageLingo
        </div>
        <div className="space-label">个人学习空间</div>
        <nav aria-label="主要导航">
          <NavLink to="/library">
            <BookOpen size={18} />
            资料库
          </NavLink>
          <NavLink to="/settings">
            <Settings2 size={18} />
            模型与账户
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/admin/users">
              <Users size={18} />
              用户管理
            </NavLink>
          )}
        </nav>
        <div className="profile">
          <span className="avatar">{user?.username.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{user?.username}</strong>
            <small>{user?.role === 'admin' ? '管理员' : '普通用户'}</small>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            PageLingo <span className="muted"> / 私有空间</span>
          </span>
          <div className="topbar-actions">
            <ThemeButton />
            <Button
              disabled={logoutPending}
              onClick={() => {
                setLogoutError('');
                setLogoutPending(true);
                void logout()
                  .catch(() => setLogoutError('退出失败，仍保持登录。请重试。'))
                  .finally(() => setLogoutPending(false));
              }}
              aria-label="退出登录"
            >
              <LogOut size={16} />
              <span>{logoutPending ? '退出中…' : '退出登录'}</span>
            </Button>
          </div>
        </header>
        <main className="content">
          <Feedback message={logoutError} error />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
