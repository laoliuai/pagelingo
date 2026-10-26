import { useQuery } from '@tanstack/react-query';
import type { PublicUser } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { PageHeader } from '../../shared/layouts/page-header';
import { Badge } from '../../shared/ui/badge';
import { Button } from '../../shared/ui/button';
import { Feedback } from '../../shared/ui/toast';
import { Confirm } from '../../shared/ui/alert-dialog';
import { CreateUserDialog } from './create-user-dialog';
import { ResetPasswordDialog } from './reset-password-dialog';
export function UsersPage() {
  const { user } = useSession();
  const users = useQuery({
    queryKey: [user!.id, 'users'],
    queryFn: ({ signal }) => apiRequest<PublicUser[]>('/api/v1/admin/users', { signal }),
  });
  return (
    <>
      <PageHeader
        title="用户管理"
        description="由管理员手工开通账号，每位用户拥有独立资料库。"
        action={<CreateUserDialog onCreated={() => users.refetch()} />}
      />
      {users.isPending && <p role="status">加载用户…</p>}
      <Feedback message={users.error ? errorMessage(users.error) : ''} error />
      {users.data && (
        <div className="table-frame">
          <table className="user-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>账号状态</th>
                <th>创建日期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((account) => (
                <tr key={account.id}>
                  <td>
                    <div className="user-cell">
                      <span className="avatar">{account.username.slice(0, 1).toUpperCase()}</span>
                      <span>
                        {account.username}
                        {account.id === user!.id && <small className="muted">（当前）</small>}
                      </span>
                    </div>
                  </td>
                  <td>{account.role === 'admin' ? '管理员' : '普通用户'}</td>
                  <td>
                    <Badge active={account.active}>{account.active ? '正常' : '已停用'}</Badge>
                  </td>
                  <td className="muted mono">{account.createdAt.slice(0, 10)}</td>
                  <td>
                    {account.role === 'user' && (
                      <div className="row-actions">
                        <ResetPasswordDialog userId={account.id} username={account.username} />
                        <Confirm
                          title={`${account.active ? '停用' : '启用'} ${account.username}？`}
                          description={
                            account.active
                              ? '停用将立即撤销该用户的所有会话与授权。'
                              : '启用后，该用户可以重新登录。'
                          }
                          action={account.active ? '确认停用' : '确认启用'}
                          trigger={<Button>{account.active ? '停用' : '启用'}</Button>}
                          onConfirm={async () => {
                            await apiRequest(`/api/v1/admin/users/${account.id}`, {
                              method: 'PATCH',
                              body: { active: !account.active },
                            });
                            await users.refetch();
                          }}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">这里管理账号信息；每位用户单独配置自己的模型 API。</p>
    </>
  );
}
