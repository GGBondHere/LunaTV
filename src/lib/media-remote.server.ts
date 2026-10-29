import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';

import {
  type CloudCapacity,
  type MediaConnection,
  type MediaConnectionCheck,
  type MediaRemoteService,
  mediaApiURL,
  mediaRelativePath,
} from './media';
import { type DavObject, parseDavObjects } from './media-dav-xml';

export class RemoteMediaError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
  }
}
export function remotePath(c: MediaConnection, path: string) {
  const normalized = mediaRelativePath(path);
  if (
    c.root !== '/' &&
    normalized !== c.root &&
    !normalized.startsWith(c.root + '/')
  )
    throw new RemoteMediaError('REMOTE_PATH', '对象超出配置的存储目录', 400);
  return normalized;
}
function objectURL(c: MediaConnection, path: string) {
  return (
    c.url + remotePath(c, path).split('/').map(encodeURIComponent).join('/')
  );
}
function remoteFailure(status: number): never {
  const messages: Record<number, string> = {
    401: 'WebDAV 登录失效，请检查账号和密码',
    403: '远端拒绝访问，请检查权限或服务限额',
    404: '远端文件或目录不存在',
    413: '远端代理拒绝完整文件 PUT，请调整上传大小限制',
    429: '远端请求过于频繁，请稍后重试',
    507: '远端空间不足，暂存文件已保留',
  };
  throw new RemoteMediaError(
    'REMOTE_' + status,
    messages[status] || `远端服务暂时不可用（${status}）`,
    status === 404 ? 404 : 502
  );
}
async function pause(ms: number, signal?: AbortSignal) {
  if (signal?.aborted)
    throw new RemoteMediaError('INTERRUPTED', '操作已中止', 409);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new RemoteMediaError('INTERRUPTED', '操作已中止', 409));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function deadline(ms: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(abort, ms);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
// Credentials are only attached to their configured origin. Writes never follow redirects.
export async function dav(
  c: MediaConnection,
  path: string,
  method: string,
  options: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    file?: string;
    body?: Uint8Array;
    timeoutMs?: number;
    retry?: boolean;
  } = {}
): Promise<Response> {
  const original = new URL(objectURL(c, path));
  let url = original;
  const read = ['GET', 'HEAD', 'PROPFIND'].includes(method);
  for (let redirect = 0; redirect < 4; redirect++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeoutMs =
      options.timeoutMs ?? (options.file ? 30 * 60 * 1000 : 60000);
    let timer = setTimeout(abort, timeoutMs);
    const body = options.file ? createReadStream(options.file) : options.body;
    try {
      const headers: Record<string, string> = {
        'Accept-Encoding': 'identity',
        ...options.headers,
      };
      if (url.origin === original.origin)
        headers.Authorization =
          'Basic ' +
          Buffer.from(c.username + ':' + c.password).toString('base64');
      const response = await fetch(url, {
        method,
        headers,
        body: body as unknown as BodyInit,
        duplex: 'half',
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      } as RequestInit);
      if (
        read &&
        options.retry !== false &&
        [429, 500, 502, 503, 504].includes(response.status) &&
        redirect < 2
      ) {
        const delay = Math.min(
          3000,
          Math.max(
            1000,
            (Number(response.headers.get('retry-after')) || 0) * 1000
          )
        );
        await response.body?.cancel();
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        await pause(delay, options.signal);
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        const location = response.headers.get('location');
        if (!read || !location)
          throw new RemoteMediaError(
            'REMOTE_REDIRECT',
            '远端写入地址发生重定向，请填写最终 WebDAV 地址'
          );
        url = new URL(location, url);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          (original.protocol === 'https:' && url.protocol !== 'https:')
        )
          throw new RemoteMediaError(
            'REMOTE_REDIRECT',
            '远端重定向地址不受支持'
          );
        continue;
      }
      // Body cancellation and client disconnect remain wired after headers arrive.
      if (!response.body) {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        return response;
      }
      const reader = response.body.getReader();
      let closed = false;
      const finish = () => {
        if (!closed) {
          closed = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        }
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(out) {
            try {
              clearTimeout(timer);
              timer = setTimeout(abort, options.timeoutMs ?? 60000);
              const result = await reader.read();
              if (result.done) {
                finish();
                out.close();
              } else out.enqueue(result.value);
            } catch {
              finish();
              out.error(
                new RemoteMediaError(
                  'REMOTE_INTERRUPTED',
                  '远端连接中断，请重试'
                )
              );
            }
          },
          async cancel() {
            finish();
            controller.abort();
            await reader.cancel().catch(() => undefined);
          },
        }),
        { status: response.status, headers: response.headers }
      );
    } catch (e) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (
        read &&
        options.retry !== false &&
        redirect < 2 &&
        !options.signal?.aborted &&
        !(e instanceof RemoteMediaError)
      ) {
        await pause(1000, options.signal);
        continue;
      }
      if (e instanceof RemoteMediaError) throw e;
      throw new RemoteMediaError(
        'REMOTE_CONNECTION',
        options.signal?.aborted
          ? '操作已中止'
          : '无法连接远端或连接超时，请检查地址、证书和代理设置'
      );
    } finally {
      if (options.file && body && 'destroy' in body) body.destroy();
    }
  }
  throw new RemoteMediaError('REMOTE_REDIRECT', '远端重定向次数过多');
}
export async function boundedBytes(
  response: Response,
  max: number
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (bytes > max)
        throw new RemoteMediaError('REMOTE_LIMIT', '远端响应超过读取限制');
      chunks.push(Buffer.from(r.value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export async function davStat(
  c: MediaConnection,
  path: string,
  signal?: AbortSignal
) {
  const response = await dav(c, path, 'HEAD', { signal });
  await response.body?.cancel();
  if (response.status === 404) return null;
  if (!response.ok) remoteFailure(response.status);
  const size = Number(response.headers.get('content-length'));
  if (
    !response.headers.has('content-length') ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new RemoteMediaError('REMOTE_LENGTH', '远端未提供有效文件大小');
  return {
    size,
    etag: response.headers.get('etag') || '',
    modified: response.headers.get('last-modified') || '',
  };
}
export async function davDelete(
  c: MediaConnection,
  path: string,
  signal?: AbortSignal,
  etag?: string
) {
  const r = await dav(c, path, 'DELETE', {
    signal,
    headers: etag && !etag.startsWith('W/') ? { 'If-Match': etag } : {},
  });
  await r.body?.cancel();
  if (r.status === 412)
    throw new RemoteMediaError(
      'REMOTE_CHANGED',
      '源文件已变化，未删除，请重新扫描',
      409
    );
  if (!r.ok && r.status !== 404) remoteFailure(r.status);
  if (await davStat(c, path, signal))
    throw new RemoteMediaError(
      'REMOTE_DELETE_PENDING',
      '远端尚未确认文件删除，请稍后重试'
    );
}
export async function davPut(
  c: MediaConnection,
  path: string,
  file: string,
  size: number,
  signal: AbortSignal
) {
  const r = await dav(c, path, 'PUT', {
    file,
    signal,
    headers: { 'Content-Length': String(size), 'Content-Type': 'video/mp4' },
  });
  await r.body?.cancel();
  if (!r.ok) remoteFailure(r.status);
}
export async function ensureDavDirectory(
  c: MediaConnection,
  path: string,
  signal?: AbortSignal
) {
  const r = await dav(c, path, 'MKCOL', { signal });
  await r.body?.cancel();
  if (!r.ok && r.status !== 405) remoteFailure(r.status);
}
const tokenSymbol = Symbol.for('lunatv.media.openlist.tokens');
const globals = globalThis as typeof globalThis & {
  [tokenSymbol]?: Map<string, { token: string; time: number }>;
};
const tokens = globals[tokenSymbol] || (globals[tokenSymbol] = new Map());
type DetectedService = Pick<MediaRemoteService, 'kind' | 'message'> & {
  hideStorageDetails?: boolean;
};
const discoverySymbol = Symbol.for('lunatv.media.remote.discovery');
const discoveryGlobals = globalThis as typeof globalThis & {
  [discoverySymbol]?: {
    services: Map<string, { expires: number; job: Promise<DetectedService> }>;
    permissions: Map<
      string,
      { expires: number; job: Promise<MediaRemoteService> }
    >;
    logins: Map<string, Promise<string>>;
    rejected: Map<string, { until: number; error: RemoteMediaError }>;
  };
};
const discovery =
  discoveryGlobals[discoverySymbol] ||
  (discoveryGlobals[discoverySymbol] = {
    services: new Map(),
    permissions: new Map(),
    logins: new Map(),
    rejected: new Map(),
  });
function credentialKey(c: MediaConnection) {
  return createHash('sha256')
    .update(JSON.stringify([mediaApiURL(c.url), c.username, c.password]))
    .digest('hex');
}
function rememberLoginFailure(key: string, error: RemoteMediaError) {
  discovery.rejected.delete(key);
  discovery.rejected.set(key, { until: Infinity, error });
  while (discovery.rejected.size > 100)
    discovery.rejected.delete(discovery.rejected.keys().next().value as string);
}

// Probe without credentials before trying any service-specific authentication.
async function detectService(
  c: MediaConnection,
  refresh = false,
  signal?: AbortSignal
): Promise<DetectedService> {
  const cached = discovery.services.get(mediaApiURL(c.url));
  if (!signal && !refresh && cached && cached.expires > Date.now())
    return cached.job;
  const job = (async (): Promise<DetectedService> => {
    const stop = deadline(3000, signal);
    try {
      const r = await fetch(mediaApiURL(c.url) + '/api/public/settings', {
        cache: 'no-store',
        redirect: 'error',
        signal: stop.signal,
      });
      if (
        !r.ok ||
        !/application\/(?:[\w.+-]*\+)?json/i.test(
          r.headers.get('content-type') || ''
        )
      ) {
        await r.body?.cancel();
        return { kind: 'webdav', message: '通用 WebDAV 服务' };
      }
      const body = JSON.parse(
        (await boundedBytes(r, 256 * 1024)).toString('utf8')
      );
      if (
        body.code === 200 &&
        typeof body.data?.version === 'string' &&
        typeof body.data?.site_title === 'string'
      )
        return {
          kind: 'openlist',
          message: '已识别 OpenList 兼容服务',
          ...(body.data.hide_storage_details === true ||
          body.data.hide_storage_details === 'true'
            ? { hideStorageDetails: true }
            : {}),
        };
      return { kind: 'webdav', message: '通用 WebDAV 服务' };
    } catch {
      return { kind: 'unknown', message: '暂未识别服务，仍按 WebDAV 连接' };
    } finally {
      stop.dispose();
    }
  })();
  if (!signal)
    discovery.services.set(mediaApiURL(c.url), {
      expires: Date.now() + 60000,
      job,
    });
  if (discovery.services.size > 100)
    discovery.services.delete(discovery.services.keys().next().value as string);
  return job;
}
export async function resolveRemoteConnection(
  c: MediaConnection,
  signal?: AbortSignal
) {
  // Accept an OpenList site address as well as its /dav endpoint, retaining proxy prefixes.
  if (
    c.url === mediaApiURL(c.url) &&
    (await detectService(c, false, signal)).kind === 'openlist'
  )
    return { ...c, url: c.url + '/dav' };
  return c;
}
async function apiRaw(
  c: MediaConnection,
  path: string,
  body: object,
  token: string,
  signal?: AbortSignal,
  timeoutMs = 30000,
  diagnostics?: string[],
  method: 'GET' | 'POST' = 'POST'
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const r = await fetch(mediaApiURL(c.url) + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: token } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const requestedPath = (body as { path?: unknown }).path;
    const requestLabel = `${method} ${path}${
      typeof requestedPath === 'string' ? ` path=${requestedPath}` : ''
    }：HTTP ${r.status}，业务码 `;
    const diagnosticIndex =
      diagnostics && diagnostics.length < 80
        ? diagnostics.push(requestLabel + '未读取') - 1
        : undefined;
    const raw = (await boundedBytes(r, 8 * 1024 * 1024)).toString('utf8');
    let response: { code: number; data: unknown } | undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.code))
        response = parsed;
    } catch {
      /* Only status codes are exposed, never upstream bodies or credentials. */
    }
    if (diagnostics && diagnosticIndex !== undefined)
      diagnostics[diagnosticIndex] =
        requestLabel + (response?.code ?? '未返回');
    if (!r.ok) remoteFailure(r.status);
    if (!response)
      throw new RemoteMediaError(
        'OPENLIST_RESPONSE',
        '存储服务返回无效数据，请检查连接地址'
      );
    return response;
  } catch (e) {
    if (e instanceof RemoteMediaError) throw e;
    throw new RemoteMediaError('OPENLIST_CONNECTION', '存储服务连接失败或超时');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
async function openList<T>(
  c: MediaConnection,
  path: string,
  body: object,
  signal?: AbortSignal,
  diagnostics?: string[]
): Promise<T> {
  if (!['/api/fs/get', '/api/fs/list', '/api/me'].includes(path))
    throw new RemoteMediaError('REMOTE_API', '不支持的容量接口');
  const key = credentialKey(c),
    rejected = discovery.rejected.get(key);
  if (rejected && rejected.until > Date.now()) throw rejected.error;
  let token = tokens.get(key)?.token || '';
  if (!token || Date.now() - (tokens.get(key)?.time || 0) > 12 * 3600000) {
    let login = signal ? undefined : discovery.logins.get(key);
    if (!login) {
      login = (async () => {
        const response = await apiRaw(
          c,
          '/api/auth/login',
          { username: c.username, password: c.password },
          '',
          signal,
          4000,
          diagnostics
        );
        const value = (response.data as { token?: string })?.token || '';
        if (response.code !== 200 || !value) {
          const error = new RemoteMediaError(
            'OPENLIST_AUTH',
            '容量查询无法登录，将继续使用 WebDAV 和本站额度'
          );
          rememberLoginFailure(key, error);
          throw error;
        }
        tokens.set(key, { token: value, time: Date.now() });
        while (tokens.size > 100)
          tokens.delete(tokens.keys().next().value as string);
        return value;
      })()
        .catch((error) => {
          if (
            error instanceof RemoteMediaError &&
            /^(REMOTE_(401|403|429))$/.test(error.code)
          )
            rememberLoginFailure(key, error);
          throw error;
        })
        .finally(() => {
          if (!signal) discovery.logins.delete(key);
        });
      if (!signal) discovery.logins.set(key, login);
    }
    token = await login;
  } else if (
    diagnostics &&
    diagnostics.length < 80 &&
    !diagnostics.includes('登录：复用已有会话，未重新发送密码')
  ) {
    diagnostics.push('登录：复用已有会话，未重新发送密码');
  }
  const response = await apiRaw(
    c,
    path,
    body,
    token,
    signal,
    4000,
    diagnostics,
    path === '/api/me' ? 'GET' : 'POST'
  );
  if (response.code === 401) tokens.delete(key);
  if (response.code !== 200) remoteFailure(response.code);
  return response.data as T;
}

export type RemoteObject = DavObject;
async function davObjects(
  c: MediaConnection,
  path: string,
  depth: '0' | '1',
  signal?: AbortSignal
) {
  remotePath(c, path);
  const body = Buffer.from(
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>'
  );
  const response = await dav(c, path, 'PROPFIND', {
    signal,
    body,
    headers: {
      Depth: depth,
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': String(body.length),
    },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 207) {
    await response.body?.cancel();
    remoteFailure(response.status);
  }
  const xml = (
    await boundedBytes(response, depth === '1' ? 16 * 1024 * 1024 : 512 * 1024)
  ).toString('utf8');
  try {
    return parseDavObjects(xml, c.url, path, depth);
  } catch (error) {
    throw new RemoteMediaError('DAV_RESPONSE', (error as Error).message);
  }
}
export async function remoteObject(
  c: MediaConnection,
  path: string,
  signal?: AbortSignal
) {
  const objects = await davObjects(c, path, '0', signal);
  return objects?.get(path) || null;
}
export async function listDavDirectory(
  c: MediaConnection,
  path: string,
  signal?: AbortSignal
) {
  const objects = await davObjects(c, path, '1', signal);
  if (!objects?.get(path)?.is_dir)
    throw new RemoteMediaError('DAV_DIRECTORY', '扫描目录不存在或不可读取');
  return Array.from(objects.values()).filter((object) => object.path !== path);
}
export async function inspectRemoteService(
  c: MediaConnection,
  refresh = false,
  signal?: AbortSignal
): Promise<MediaRemoteService> {
  const key = credentialKey(c) + ':' + c.scan.root,
    cached = discovery.permissions.get(key);
  if (!signal && !refresh && cached && cached.expires > Date.now())
    return cached.job;
  if (refresh) discovery.rejected.delete(credentialKey(c));
  const job = (async (): Promise<MediaRemoteService> => {
    const service = await detectService(c, refresh, signal);
    const stop = deadline(5000, signal);
    try {
      const directory = await remoteObject(c, c.scan.root, stop.signal);
      return {
        ...service,
        canScan: !!directory?.is_dir,
        message: directory?.is_dir
          ? 'WebDAV 目录可访问，支持按路径扫描'
          : '扫描目录不存在，请检查目录设置',
      };
    } catch (error) {
      return {
        ...service,
        canScan: false,
        message:
          error instanceof RemoteMediaError
            ? error.message
            : '扫描目录暂不可访问',
      };
    } finally {
      stop.dispose();
    }
  })();
  if (!signal)
    discovery.permissions.set(key, { expires: Date.now() + 60000, job });
  if (discovery.permissions.size > 100)
    discovery.permissions.delete(
      discovery.permissions.keys().next().value as string
    );
  return job;
}
export function objectFingerprint(
  object: Pick<RemoteObject, 'size' | 'etag' | 'modified'>
) {
  const time = Date.parse(object.modified);
  return createHash('sha256')
    .update(
      JSON.stringify([
        object.size,
        object.etag,
        Number.isFinite(time) ? time : object.modified,
      ])
    )
    .digest('hex');
}

type Quota = { total: number; used: number; free: number };
function quotaValues(value: unknown, depth = 0): Quota | null {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  const obj = value as Record<string, unknown>;
  const total = Number(obj.total_space ?? obj.totalSpace ?? obj.TotalSpace);
  const used = Number(obj.used_space ?? obj.usedSpace ?? obj.UsedSpace);
  if (
    Number.isSafeInteger(total) &&
    total > 0 &&
    Number.isSafeInteger(used) &&
    used >= 0
  ) {
    const reportedFree = obj.free_space ?? obj.freeSpace ?? obj.FreeSpace;
    const free =
      reportedFree == null ? Math.max(0, total - used) : Number(reportedFree);
    if (
      Number.isSafeInteger(free) &&
      free <= total &&
      (free >= 0 || used > total)
    )
      return { total, used, free: Math.max(0, free) };
  }
  for (const child of Object.values(obj)) {
    const found = quotaValues(child, depth + 1);
    if (found) return found;
  }
  return null;
}
const quotaCacheSymbol = Symbol.for('lunatv.media.remote.quota-cache');
type QuotaCacheEntry = { value: CloudCapacity; basePath?: string };
const quotaGlobals = globalThis as typeof globalThis & {
  [quotaCacheSymbol]?: Map<string, QuotaCacheEntry>;
};
const quotaCache =
  quotaGlobals[quotaCacheSymbol] ||
  (quotaGlobals[quotaCacheSymbol] = new Map());
type CapacityObject = {
  name?: unknown;
  is_dir?: boolean;
  mount_details?: unknown;
};

async function openListCapacityRound(
  c: MediaConnection,
  signal: AbortSignal,
  diagnostics: string[]
): Promise<
  (Quota & Pick<CloudCapacity, 'scope' | 'mountCount' | 'error'>) | null
> {
  const list = async (path: string) => {
    const response = await openList<{
      content?: CapacityObject[];
      total?: number;
    }>(
      c,
      '/api/fs/list',
      { path, password: '', page: 1, per_page: 0, refresh: false },
      signal,
      diagnostics
    );
    if (
      !response ||
      !Array.isArray(response.content) ||
      response.content.length > 20000
    )
      throw new RemoteMediaError(
        'OPENLIST_RESPONSE',
        '目录列表无效或超过 20000 条限制'
      );
    const mounts = new Map<string, Quota>();
    let present = 0;
    for (const item of response.content) {
      if (!item || item.is_dir !== true) continue;
      if (item.mount_details != null) present++;
      const quota = quotaValues(item.mount_details);
      if (!quota) continue;
      if (
        typeof item.name !== 'string' ||
        !item.name ||
        /[\\/]/.test(item.name) ||
        ['.', '..'].includes(item.name)
      )
        throw new RemoteMediaError('OPENLIST_RESPONSE', '挂载列表包含无效名称');
      mounts.set(mediaRelativePath(path + '/' + item.name), quota);
    }
    if (diagnostics.length < 80)
      diagnostics.push(
        `列表 ${path}：${present} 项包含 mount_details，${mounts.size} 项容量有效`
      );
    return {
      mounts,
      incomplete:
        typeof response.total === 'number' &&
        response.total > response.content.length,
    };
  };
  const match = (mounts: Map<string, Quota>) => {
    const found = Array.from(mounts)
      .filter(([path]) => c.root === path || c.root.startsWith(path + '/'))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!found) return null;
    diagnostics.push(`容量匹配：${c.root} → ${found[0]}`);
    return { ...found[1], scope: 'mount' as const, mountCount: 1 };
  };
  // All paths here remain relative to the authenticated user's BasePath.
  const root = await list('/');
  if (c.root !== '/') {
    const selected = match(root.mounts);
    if (selected) return selected;
  }
  if (c.root === '/' && root.mounts.size) {
    const sum = { total: 0, used: 0, free: 0 };
    for (const quota of Array.from(root.mounts.values())) {
      sum.total += quota.total;
      sum.used += quota.used;
      sum.free += quota.free;
    }
    if (![sum.total, sum.used, sum.free].every(Number.isSafeInteger))
      throw new RemoteMediaError(
        'CAPACITY_INVALID',
        '挂载容量合计超出可精确表示范围'
      );
    if (root.incomplete)
      throw new RemoteMediaError(
        'CAPACITY_INCOMPLETE',
        '服务端未返回完整挂载列表，无法准确汇总容量'
      );
    return {
      ...sum,
      scope: 'aggregate',
      mountCount: root.mounts.size,
      error: `仅合计当前目录下已报告的存储容量${
        root.mounts.size > 1 ? '；同一存储重复关联时可能重复计数' : ''
      }`,
    };
  }
  try {
    const current = await openList<CapacityObject>(
      c,
      '/api/fs/get',
      { path: c.root, password: '' },
      signal,
      diagnostics
    );
    const own = quotaValues(current?.mount_details);
    diagnostics.push(
      `当前目录 ${c.root}：mount_details ${
        current?.mount_details == null ? '缺失' : '存在'
      }，容量${own ? '有效' : '无效或未提供'}`
    );
    if (own) return { ...own, scope: 'mount', mountCount: 1 };
  } catch (error) {
    if (
      error instanceof RemoteMediaError &&
      /^(REMOTE_(401|429)|OPENLIST_AUTH)$/.test(error.code)
    )
      throw error;
    diagnostics.push(
      '/api/fs/get 补充查询未取得容量，继续检查指定路径的挂载列表'
    );
  }
  const parts = c.root.split('/').filter(Boolean);
  // Only descend along the configured path, never guess parents outside the account.
  for (let i = 1; i < parts.length && i < 16; i++) {
    const nested = await list('/' + parts.slice(0, i).join('/'));
    const selected = match(nested.mounts);
    if (selected) return selected;
  }
  return null;
}
export async function queryCapacity(
  c: MediaConnection,
  signal?: AbortSignal,
  force = false
): Promise<CloudCapacity> {
  const key = credentialKey(c) + ':' + c.root;
  const cached = quotaCache.get(key);
  if (!force && cached && Date.now() - cached.value.checkedAt < 60000)
    return { ...cached.value, diagnostics: ['使用 60 秒内成功取得的容量缓存'] };
  const stop = deadline(12000, signal);
  const diagnostics: string[] = [];
  let basePath: string | undefined;
  try {
    const service = await detectService(c, false, stop.signal);
    let value: CloudCapacity;
    if (service.kind !== 'openlist') {
      value = await queryDavCapacity(c, stop.signal);
      if (value.free === null)
        throw new RemoteMediaError(
          'CAPACITY_UNKNOWN',
          value.error || 'WebDAV 未返回容量'
        );
    } else {
      if (service.hideStorageDetails)
        throw new RemoteMediaError(
          'CAPACITY_HIDDEN',
          '服务端已隐藏存储容量信息'
        );
      try {
        const profile = await openList<{ base_path?: unknown; role?: number }>(
          c,
          '/api/me',
          {},
          stop.signal,
          diagnostics
        );
        if (profile?.role === 1)
          throw new RemoteMediaError(
            'CAPACITY_GUEST',
            '当前账号无权读取存储容量'
          );
        if (typeof profile?.base_path === 'string')
          basePath = mediaRelativePath(profile.base_path);
        diagnostics.push(
          `当前账号：${profile?.role === 2 ? '管理员' : '普通用户'}，BasePath=${
            basePath ?? '未返回'
          }`
        );
      } catch (error) {
        if (
          error instanceof RemoteMediaError &&
          /^(REMOTE_(401|403|429)|OPENLIST_AUTH|CAPACITY_GUEST)$/.test(
            error.code
          )
        )
          throw error;
        diagnostics.push('未取得账号基本路径，继续按账号可见目录查询');
      }
      let found: Awaited<ReturnType<typeof openListCapacityRound>> = null;
      for (let round = 0; round < 3; round++) {
        if (round) await pause(3000, stop.signal);
        diagnostics.push(`第 ${round + 1}/3 轮容量查询`);
        found = await openListCapacityRound(c, stop.signal, diagnostics);
        if (found) break;
      }
      if (!found) {
        const restricted = basePath && basePath !== '/';
        diagnostics.push(
          'hide_storage_details 是服务端私有设置，普通文件 API 无法确认开关值'
        );
        throw new RemoteMediaError(
          restricted ? 'CAPACITY_SCOPE' : 'CAPACITY_UNKNOWN',
          restricted
            ? '当前账号可见目录未提供容量，无法查询其上级存储；请检查服务端容量统计及可见权限'
            : '存储服务未提供有效容量，请检查服务端容量统计及可见权限'
        );
      }
      value = { ...found, checkedAt: Date.now() };
    }
    const result = {
      ...value,
      diagnostics: diagnostics.slice(0, 80),
      attemptedAt: Date.now(),
    };
    quotaCache.delete(key);
    quotaCache.set(key, { value: result, basePath });
    while (quotaCache.size > 64)
      quotaCache.delete(quotaCache.keys().next().value as string);
    return result;
  } catch (error) {
    const reason = stop.signal.aborted
      ? '容量查询超时或已取消'
      : error instanceof RemoteMediaError
      ? error.message
      : '容量查询失败';
    const invalidatesCache =
      error instanceof RemoteMediaError &&
      /^(REMOTE_(401|403|429)|OPENLIST_AUTH|CAPACITY_HIDDEN|CAPACITY_SCOPE|CAPACITY_GUEST)$/.test(
        error.code
      );
    if (invalidatesCache) quotaCache.delete(key);
    if (
      cached &&
      Date.now() - cached.value.checkedAt < 5 * 60000 &&
      (!basePath || basePath === cached.basePath) &&
      !invalidatesCache
    )
      return {
        ...cached.value,
        stale: true,
        attemptedAt: Date.now(),
        diagnostics: diagnostics.slice(0, 80),
        error: `${reason}；显示上次成功值，请稍后刷新`,
      };
    return {
      total: null,
      used: null,
      free: null,
      checkedAt: Date.now(),
      attemptedAt: Date.now(),
      diagnostics: diagnostics.slice(0, 80),
      error: reason,
    };
  } finally {
    stop.dispose();
  }
}
async function queryDavCapacity(
  c: MediaConnection,
  signal?: AbortSignal
): Promise<CloudCapacity> {
  const stop = deadline(3000, signal);
  try {
    const body = Buffer.from(
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>'
    );
    const r = await dav(c, c.root, 'PROPFIND', {
      signal: stop.signal,
      retry: false,
      body,
      headers: {
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': String(body.length),
      },
    });
    if (r.status !== 207) {
      await r.body?.cancel();
      remoteFailure(r.status);
    }
    const xml = (await boundedBytes(r, 256 * 1024)).toString('utf8');
    const blocks =
      xml.match(
        /<(?:[\w.-]+:)?propstat\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?propstat\s*>/gi
      ) || [];
    const valid = blocks
      .filter((block) =>
        /<(?:[\w.-]+:)?status\b[^>]*>\s*HTTP\/[^<]*\s200\b/i.test(block)
      )
      .join('\n');
    const number = (tag: string) => {
      const match = new RegExp(
        '<(?:[\\w.-]+:)?' +
          tag +
          '\\b[^>]*>\\s*(\\d+)\\s*</(?:[\\w.-]+:)?' +
          tag +
          '\\s*>',
        'i'
      ).exec(valid);
      const value = match ? Number(match[1]) : NaN;
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const used = number('quota-used-bytes'),
      free = number('quota-available-bytes');
    const total =
      used !== null && free !== null && Number.isSafeInteger(used + free)
        ? used + free
        : null;
    return {
      total,
      used,
      free,
      checkedAt: Date.now(),
      ...(free === null ? { error: '服务未提供容量信息，不影响上传' } : {}),
    };
  } catch {
    return {
      total: null,
      used: null,
      free: null,
      checkedAt: Date.now(),
      error: '容量信息暂不可用，不影响上传',
    };
  } finally {
    stop.dispose();
  }
}
export function rangeBounds(range: string | null, size: number) {
  if (!range) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size &&
    !(!m[1] && Number(m[2]) === 0)
    ? { start, end, partial: true }
    : null;
}
export async function remoteStream(
  c: MediaConnection,
  path: string,
  size: number,
  range: string | null,
  signal: AbortSignal,
  head = false
) {
  const bounds = rangeBounds(head ? null : range, size);
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  });
  if (!bounds) {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const response = await dav(c, path, head ? 'HEAD' : 'GET', {
    signal,
    headers: bounds.partial
      ? { Range: `bytes=${bounds.start}-${bounds.end}` }
      : {},
  });
  const length = bounds.end - bounds.start + 1;
  const expectedRange = `bytes ${bounds.start}-${bounds.end}/${size}`;
  if (
    response.status !== (bounds.partial ? 206 : 200) ||
    Number(response.headers.get('content-length')) !== length ||
    (bounds.partial &&
      response.headers.get('content-range') !== expectedRange) ||
    (response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity') ||
    /html|json/i.test(response.headers.get('content-type') || '')
  ) {
    await response.body?.cancel();
    throw new RemoteMediaError(
      'REMOTE_RANGE',
      '远端返回的文件大小或 Range 不符，请检查文件是否变化及 OpenList 本机代理设置'
    );
  }
  headers.set('Content-Length', String(length));
  if (bounds.partial) headers.set('Content-Range', expectedRange);
  return new Response(head ? null : response.body, {
    status: bounds.partial ? 206 : 200,
    headers,
  });
}
export async function checkConnection(
  input: MediaConnection,
  signal?: AbortSignal
): Promise<MediaConnectionCheck> {
  // Reserve the final three seconds for targeted cleanup, even after cancellation.
  const work = deadline(12000, signal);
  const results: MediaConnectionCheck['results'] = [];
  let c = input;
  let path = '';
  let created = false;
  let writeUncertain = false;
  let stage = '目录访问';
  let method = 'PROPFIND';
  const addResult = (name: string, ok: boolean | null, message: string) => {
    results.push({ name, ok, message });
  };
  let capacity: CloudCapacity = {
    total: null,
    used: null,
    free: null,
    checkedAt: Date.now(),
    error: '容量查询未完成，不影响上传',
  };
  let service: MediaRemoteService = {
    kind: 'unknown',
    canScan: false,
    message: '扫描目录检查未完成',
  };
  let lookups: Promise<void> | undefined;
  try {
    c = await resolveRemoteConnection(input, work.signal);
    discovery.rejected.delete(credentialKey(c));
    path = remotePath(c, c.root + '/.lunatv-check-' + randomUUID());
    lookups = Promise.all([
      queryCapacity(c, work.signal, true).then((value) => {
        capacity = value;
      }),
      inspectRemoteService(c, true, work.signal).then((value) => {
        service = value;
      }),
    ])
      .then(() => undefined)
      .catch(() => undefined);
    const options = { signal: work.signal, timeoutMs: 4000, retry: false };
    const r = await dav(c, c.root, 'PROPFIND', {
      ...options,
      headers: { Depth: '0' },
    });
    if (r.status !== 207) {
      await r.body?.cancel();
      if (!r.ok) remoteFailure(r.status);
      throw new RemoteMediaError(
        'DAV_RESPONSE',
        `HTTP ${r.status}，未返回 WebDAV 目录响应`
      );
    }
    const xml = (await boundedBytes(r, 512 * 1024)).toString('utf8');
    if (!parseDavObjects(xml, c.url, c.root, '0')?.get(c.root)?.is_dir)
      throw new RemoteMediaError(
        'DAV_DIRECTORY',
        '目标不是可访问的 WebDAV 目录'
      );
    addResult(stage, true, '可访问');
    stage = '上传权限';
    method = 'PUT';
    const bytes = Buffer.from('LunaTV connection check');
    created = true; // A lost PUT response still requires a targeted cleanup attempt.
    const put = await dav(c, path, 'PUT', {
      ...options,
      body: bytes,
      headers: { 'Content-Length': String(bytes.length) },
    });
    await put.body?.cancel();
    if (!put.ok) remoteFailure(put.status);
    addResult(stage, true, '可写入');
    stage = '分段读取';
    method = 'GET';
    const read = await dav(c, path, 'GET', {
      ...options,
      headers: { Range: 'bytes=0-5' },
    });
    const data = await boundedBytes(read, 1024);
    const ok =
      read.status === 206 &&
      read.headers.get('content-range') === `bytes 0-5/${bytes.length}` &&
      data.equals(bytes.subarray(0, 6));
    addResult(
      stage,
      ok,
      ok ? '支持' : `HTTP ${read.status}，分段响应或内容不符`
    );
  } catch (e) {
    const status =
      e instanceof RemoteMediaError
        ? /^REMOTE_(\d+)$/.exec(e.code)?.[1]
        : undefined;
    const message = work.signal.aborted
      ? '检查已超时或取消，已停止后续探测'
      : e instanceof RemoteMediaError
      ? e.message
      : '连接失败或请求超时';
    writeUncertain = method === 'PUT' && !status;
    addResult(stage, false, `${status ? `HTTP ${status}，` : ''}${message}`);
  } finally {
    if (created) {
      const cleanup = deadline(3000);
      try {
        await davDelete(c, path, cleanup.signal);
        addResult(
          '临时文件清理',
          writeUncertain ? null : true,
          writeUncertain
            ? '当前未发现残留；写入结果未确认，请留意对象：' + path
            : '测试文件已清理'
        );
      } catch {
        addResult('临时文件清理', false, '清理未确认，请检查对象：' + path);
      } finally {
        cleanup.dispose();
      }
    }
    if (lookups) await lookups;
    work.dispose();
  }
  for (const name of ['上传权限', '分段读取'])
    if (!results.some((result) => result.name === name))
      results.push({ name, ok: null, message: '未执行，前一项检查未通过' });
  return { results, capacity, service, url: c.url };
}
