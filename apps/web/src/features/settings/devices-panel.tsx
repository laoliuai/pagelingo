import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeviceList, PairingCode } from '@pagelingo/document-contracts';
import { useSession } from '../../app/session';
import { apiRequest, errorMessage } from '../../shared/api-client';
import { Button } from '../../shared/ui/button';
import { Badge } from '../../shared/ui/badge';
import { Field } from '../../shared/ui/field';
import { Input } from '../../shared/ui/input';
import { Feedback } from '../../shared/ui/toast';
import { Confirm } from '../../shared/ui/alert-dialog';
import './devices-panel.css';

export function DevicesPanel() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const queryKey = [user!.id, 'devices'];
  const devices = useQuery({ queryKey, queryFn: ({ signal }) => apiRequest<DeviceList>('/api/v1/devices', { signal }) });
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(() => setPairing(null), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [pairing]);
  async function createCode() {
    setPending(true);
    setError('');
    setPairing(null);
    try {
      setPairing(await apiRequest<PairingCode>('/api/v1/devices/pairing-codes', { method: 'POST', body: {} }));
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }
  return (
    <section className="form-panel devices-panel" aria-labelledby="devices-heading">
      <div className="panel-heading">
        <h2 id="devices-heading">采集设备</h2>
      </div>
      <p>配对浏览器插件后，可将网页保存到当前账号。设备只获得采集与保存偏好权限。</p>
      <Button onClick={() => void createCode()} disabled={pending}>
        {pending ? '生成中…' : '生成一次性配对码'}
      </Button>
      {pairing && (
        <div className="device-pairing" role="status">
          <Field label="一次性配对码">
            <Input readOnly autoComplete="off" value={pairing.code} onFocus={event => event.target.select()} />
          </Field>
          <p>5 分钟内有效，仅可使用一次。请在自己的插件中输入，勿分享给他人。</p>
          <p>有效期至 {new Date(pairing.expiresAt).toLocaleTimeString()}</p>
        </div>
      )}
      <Feedback message={error || (devices.error ? errorMessage(devices.error) : '')} error />
      {devices.isPending && <p role="status">加载采集设备…</p>}
      {devices.data?.items.length === 0 && <p>尚未配对采集设备</p>}
      <ul className="device-list" aria-label="已配对设备">
        {devices.data?.items.map(device => {
          const active = !device.revokedAt && Date.parse(device.expiresAt) > Date.now();
          return (
            <li key={device.id}>
              <div className="device-details">
                <strong>{device.name}</strong>
                <Badge active={active}>{device.revokedAt ? '已撤销' : active ? '已配对' : '已过期'}</Badge>
                <p>配对于 {new Date(device.createdAt).toLocaleDateString()} · 有效期至 {new Date(device.expiresAt).toLocaleDateString()}</p>
              </div>
              {active && (
                <Confirm
                  trigger={<Button aria-label={`撤销 ${device.name}`}>撤销</Button>}
                  title="撤销采集设备？"
                  description="撤销后，此设备无法继续保存网页。重新使用需要再次配对。"
                  action="确认撤销设备"
                  onConfirm={async () => {
                    await apiRequest(`/api/v1/devices/${device.id}/revoke`, { method: 'POST', body: {} });
                    await queryClient.invalidateQueries({ queryKey });
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
