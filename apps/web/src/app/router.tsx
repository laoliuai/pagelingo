import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useSession } from './session';
import { AppShell } from '../shared/layouts/app-shell';
import { PageHeader } from '../shared/layouts/page-header';
import { LoginPage } from '../features/auth/login-page';
import { UsersPage } from '../features/users/users-page';
import { ProviderPage } from '../features/settings/provider-page';
function Private() {
  const { user } = useSession();
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}
function Admin() {
  const { user } = useSession();
  return user?.role === 'admin' ? (
    <UsersPage />
  ) : (
    <PageHeader title="无权访问" description="仅管理员可以管理账号。" />
  );
}
function Library() {
  return (
    <>
      <PageHeader title="资料库" description="你的私有阅读空间。" />
      <div className="empty-state">
        <p>资料仅对当前账号可见。</p>
      </div>
    </>
  );
}
export function Router() {
  const { loading, epoch } = useSession();
  if (loading)
    return (
      <main className="loading" role="status">
        正在加载…
      </main>
    );
  return (
    <BrowserRouter>
      <Routes key={epoch}>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Private />}>
          <Route element={<AppShell />}>
            <Route path="/library" element={<Library />} />
            <Route path="/settings" element={<ProviderPage />} />
            <Route path="/admin/users" element={<Admin />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
