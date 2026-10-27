let csrfToken: string | null = null;
let generation = new AbortController();
let onUnauthorized: () => void = () => {};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function configureApi(unauthorized: () => void) {
  onUnauthorized = unauthorized;
}
export function resetApiSession(token: string | null) {
  generation.abort();
  generation = new AbortController();
  csrfToken = token;
}
async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown | FormData;
    signal?: AbortSignal;
    idempotencyKey?: string;
    zip?: File;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  if (
    !/^\/api\/v1(?:\/|$)/.test(path) ||
    path.includes('\\') ||
    path.includes('#') ||
    new URL(path, location.origin).origin !== location.origin ||
    new URL(path, location.origin).pathname !== path.split('?')[0]
  )
    throw new Error('Invalid API path');
  const scope = generation;
  const signal = options.signal
    ? AbortSignal.any([scope.signal, options.signal])
    : scope.signal;
  const method = options.method ?? 'GET';
  const form = options.body instanceof FormData;
  const response = await fetch(path, {
    method,
    credentials: 'include',
    cache: 'no-store',
    keepalive: options.keepalive,
    signal,
    headers: {
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.zip ? { 'Content-Type': 'application/zip' } : !form && options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' && csrfToken
        ? { 'X-CSRF-Token': csrfToken }
        : {}),
    },
    ...(options.zip ? { body: options.zip } : options.body !== undefined
      ? { body: form ? (options.body as FormData) : JSON.stringify(options.body) }
      : {}),
  });
  signal.throwIfAborted();
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    signal.throwIfAborted();
    const invalidCurrentPassword = method === 'POST' &&
      path === '/api/v1/auth/password' && error?.error?.code === 'INVALID_CREDENTIALS';
    if (response.status === 401 && path !== '/api/v1/auth/login' && !invalidCurrentPassword)
      onUnauthorized();
    throw new ApiError(response.status, error?.error?.code ?? 'REQUEST_FAILED');
  }
  const value = response.status === 204 ? undefined : await response.json();
  signal.throwIfAborted();
  return value as T;
}
/** JSON/multipart requests share the same identity fence as binary uploads. */
export function apiRequest<T>(path: string, options: {
  method?: string; body?: unknown | FormData; signal?: AbortSignal; idempotencyKey?: string; keepalive?: boolean;
} = {}): Promise<T> {
  return request<T>(path, options);
}
/** The browser streams File bytes; callers cannot choose origin, headers or content type. */
export function uploadBundleContent<T>(importId: string, file: File, signal?: AbortSignal): Promise<T> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(importId))
    throw new Error('Invalid import ID');
  return request<T>(`/api/v1/bundle-imports/${importId}/content`, { method: 'PUT', zip: file, signal });
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '用户名或密码不正确，请重新登录。';
    if (error.status === 409) return '数据已更新或用户名已存在，请刷新后重试。';
    if (error.status === 429) return '请求过于频繁，请稍后重试。';
    if (error.code === 'PROVIDER_INCOMPLETE') return '请先填写模型地址、名称与 API Key。';
    if (error.status === 403) return '没有执行此操作的权限。';
    if (error.status === 400) return '请检查输入格式。密码需为 12–128 个字符。';
  }
  return '操作失败，请稍后重试。';
}

/** Captured by long-lived writers so teardown can never adopt a newer identity. */
export function apiSessionSignal(): AbortSignal { return generation.signal; }
