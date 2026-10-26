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
export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown | FormData;
    signal?: AbortSignal;
    idempotencyKey?: string;
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
    signal,
    headers: {
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(!form && options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' && csrfToken
        ? { 'X-CSRF-Token': csrfToken }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: form ? (options.body as FormData) : JSON.stringify(options.body) }
      : {}),
  });
  signal.throwIfAborted();
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    signal.throwIfAborted();
    if (response.status === 401 && path !== '/api/v1/auth/login') onUnauthorized();
    throw new ApiError(response.status, error?.error?.code ?? 'REQUEST_FAILED');
  }
  const value = response.status === 204 ? undefined : await response.json();
  signal.throwIfAborted();
  return value as T;
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
