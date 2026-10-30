export const MEDIA_SOURCE = '__uploaded_media__';
export const MEDIA_CHUNK_BYTES = 16 * 1024 * 1024;
export const MEDIA_LEGACY_CHUNK_BYTES = 8 * 1024 * 1024;
export const MEDIA_UPLOAD_CONCURRENCY = 2;
export const MEDIA_UPLOAD_REQUESTS = 4;
export const MEDIA_UPLOAD_CHECKPOINT_BYTES = 64 * 1024 * 1024;
export const MEDIA_UPLOAD_WINDOW_BYTES = 128 * 1024 * 1024;
export const MEDIA_COVER_BYTES = 5 * 1024 * 1024;
export const MEDIA_SETTINGS_KEY = 'media:settings';
export const GiB = 1024 ** 3;

export interface MediaSettings {
  allowUploads: boolean;
  quotaGiB: number;
  maxFileGiB: number;
  minFreeGiB: number;
  uploadStorage?: 'local' | 'webdav';
  activeConnectionId?: string;
  remoteQuotaGiB?: number | null;
  connections?: MediaConnection[];
  localScan?: MediaScanSettings;
}
export interface MediaScanSettings {
  root: string;
  recursive: boolean;
  automatic: boolean;
  intervalMinutes: number;
}
export const DEFAULT_LOCAL_SCAN: MediaScanSettings = {
  root: '/',
  recursive: true,
  automatic: false,
  intervalMinutes: 60,
};
export interface MediaConnection {
  id: string;
  url: string;
  root: string;
  username: string;
  password: string;
  scan: MediaScanSettings;
}
export type MediaConnectionView = Omit<MediaConnection, 'password'> & {
  hasPassword: boolean;
  references?: number;
};
export interface CloudCapacity {
  total: number | null;
  used: number | null;
  free: number | null;
  checkedAt: number;
  error?: string;
  diagnostics?: string[];
  scope?: 'mount' | 'aggregate';
  mountCount?: number;
  stale?: boolean;
  attemptedAt?: number;
}
export interface MediaRemoteService {
  kind: 'openlist' | 'webdav' | 'unknown';
  canScan: boolean;
  message: string;
}
export interface MediaConnectionCheck {
  results: { name: string; ok: boolean | null; message: string }[];
  capacity: CloudCapacity;
  service: MediaRemoteService;
  url: string;
}
export interface MediaScanStatus {
  id: string;
  connectionId: string;
  state:
    | 'running'
    | 'stopping'
    | 'completed'
    | 'cancelled'
    | 'interrupted'
    | 'failed';
  startedAt: number;
  finishedAt?: number;
  lastSuccessAt?: number;
  added: number;
  updated: number;
  skipped: number;
  removed?: number;
  failed: number;
  visited: number;
  details: { path: string; reason: string }[];
  error?: string;
}
export interface MediaAdminPolicy extends Omit<MediaPolicy, 'settings'> {
  settings: Omit<MediaSettings, 'connections'> & {
    connections: MediaConnectionView[];
  };
  capacity?: CloudCapacity;
  remoteService?: MediaRemoteService;
  localUsedBytes: number;
  localReservedBytes: number;
  localDirectory: string;
  pendingDeletes: {
    id: string;
    title: string;
    path?: string;
    location?: 'local' | 'webdav';
    error?: string;
    running?: boolean;
  }[];
  pendingProcessing?: {
    id: string;
    title: string;
    location: 'local' | 'webdav';
    error?: string;
    running: boolean;
    retryable?: boolean;
    sentBytes?: number;
    totalBytes: number;
  }[];
  retainedSources?: {
    id: string;
    title: string;
    path: string;
    location: 'local' | 'webdav';
    reason: string;
  }[];
  missingConnections: { id: string; references: number }[];
  scans: MediaScanStatus[];
}

export function mediaRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    /[\\?#]/.test(value) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32) ||
    value.split('/').some((p) => p === '.' || p === '..')
  )
    throw new Error('目录包含不允许的路径字符');
  return '/' + value.split('/').filter(Boolean).join('/');
}
function mediaURL(value: unknown) {
  if (typeof value !== 'string') throw new Error('请填写连接地址');
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('连接地址仅支持不带账号、查询参数的 HTTP/HTTPS 地址');
  return url.toString().replace(/\/$/, '');
}
export function mediaApiURL(value: string) {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/dav$/i, '');
}
export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  allowUploads: true,
  quotaGiB: 70,
  maxFileGiB: 4,
  minFreeGiB: 10,
};

export function parseMediaSettings(value: unknown): MediaSettings {
  if (value === undefined || value === null)
    return { ...DEFAULT_MEDIA_SETTINGS, localScan: { ...DEFAULT_LOCAL_SCAN } };
  const input = value as MediaSettings;
  if (
    typeof input !== 'object' ||
    typeof input.allowUploads !== 'boolean' ||
    ![input.quotaGiB, input.maxFileGiB, input.minFreeGiB].every(
      (n) =>
        typeof n === 'number' &&
        Number.isFinite(n) &&
        n >= 1 / 1024 &&
        Number.isSafeInteger(Math.round(n * GiB))
    ) ||
    input.maxFileGiB > input.quotaGiB ||
    input.minFreeGiB < 1
  ) {
    throw new Error(
      '请填写有效容量：总额度和单文件上限必须大于零，单文件不能超过总额度，磁盘保留空间至少为 1 GiB'
    );
  }
  const connections: MediaConnection[] = [];
  if (input.connections !== undefined) {
    if (!Array.isArray(input.connections) || input.connections.length > 30)
      throw new Error('存储连接配置无效');
    for (const c of input.connections) {
      if (
        !c ||
        typeof c.id !== 'string' ||
        c.id === 'local' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) ||
        connections.some((x) => x.id === c.id)
      )
        throw new Error('存储连接标识无效或重复');
      if (
        ![c.username, c.password].every(
          (x) => typeof x === 'string' && x.length <= 4096 && !/[\r\n]/.test(x)
        )
      )
        throw new Error('存储连接凭据无效');
      const scan = c.scan;
      if (
        !scan ||
        typeof scan.recursive !== 'boolean' ||
        typeof scan.automatic !== 'boolean' ||
        !Number.isInteger(scan.intervalMinutes) ||
        scan.intervalMinutes < 5 ||
        scan.intervalMinutes > 10080
      )
        throw new Error('扫描间隔需为 5–10080 分钟');
      const root = mediaRelativePath(c.root);
      const scanRoot = mediaRelativePath(scan.root);
      if (root !== '/' && scanRoot !== root && !scanRoot.startsWith(root + '/'))
        throw new Error('扫描目录必须在存储目录内');
      connections.push({
        id: c.id,
        url: mediaURL(c.url),
        root,
        username: c.username,
        password: c.password,
        scan: {
          root: scanRoot,
          recursive: scan.recursive,
          automatic: scan.automatic,
          intervalMinutes: scan.intervalMinutes,
        },
      });
    }
  }
  const storage = input.uploadStorage ?? 'local';
  if (storage !== 'local' && storage !== 'webdav')
    throw new Error('请选择有效存储类型');
  if (
    storage === 'webdav' &&
    !connections.some((c) => c.id === input.activeConnectionId)
  )
    throw new Error('请选择 WebDAV 连接');
  const remoteQuotaGiB = input.remoteQuotaGiB ?? null;
  if (
    remoteQuotaGiB !== null &&
    (typeof remoteQuotaGiB !== 'number' ||
      !Number.isFinite(remoteQuotaGiB) ||
      remoteQuotaGiB <= 0 ||
      !Number.isSafeInteger(Math.round(remoteQuotaGiB * GiB)) ||
      input.maxFileGiB > remoteQuotaGiB)
  )
    throw new Error('WebDAV 站点额度无效或小于单文件上限');
  const localScan = input.localScan ?? DEFAULT_LOCAL_SCAN;
  if (
    !localScan ||
    typeof localScan.recursive !== 'boolean' ||
    typeof localScan.automatic !== 'boolean' ||
    !Number.isInteger(localScan.intervalMinutes) ||
    localScan.intervalMinutes < 5 ||
    localScan.intervalMinutes > 10080
  )
    throw new Error('本地扫描配置无效，扫描间隔需为 5–10080 分钟');
  return {
    allowUploads: input.allowUploads,
    quotaGiB: input.quotaGiB,
    maxFileGiB: input.maxFileGiB,
    minFreeGiB: input.minFreeGiB,
    uploadStorage: storage,
    activeConnectionId: input.activeConnectionId,
    remoteQuotaGiB,
    connections,
    localScan: {
      root: mediaRelativePath(localScan.root),
      recursive: localScan.recursive,
      automatic: localScan.automatic,
      intervalMinutes: localScan.intervalMinutes,
    },
  };
}

export interface MediaView {
  id: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
  revision: string;
  contentRevision?: string;
  hasCover: boolean;
  canManage: boolean;
  unavailable?: boolean;
  processing?: boolean;
  processingError?: string;
  videoCodec?: 'h264' | 'hevc';
}
export interface UploadView {
  id: string;
  name: string;
  size: number;
  modified: number;
  title: string;
  offset: number;
  hashes: string[];
  chunkBytes?: number;
  checkpointOffset?: number;
  received?: { offset: number; hash: string }[];
  transfer?: {
    sentBytes: number;
    totalBytes: number;
    elapsedMs: number;
    speed: number;
    awaitingConfirmation: boolean;
  };
  hasCover: boolean;
  updatedAt: number;
  status: 'uploading' | 'processing' | 'ready' | 'failed' | 'cancelling';
  stage?: string;
  retryable?: boolean;
  accepted?: boolean;
  error?: string;
}
export interface MediaPolicy {
  enabled: boolean;
  uploadAvailable?: boolean;
  reason: string;
  settings: MediaSettings;
  usedBytes: number;
  reservedBytes: number;
  freeBytes: number;
  // Upload admission includes the local space needed to stage the whole file.
  availableBytes: number;
  // Destination capacity excludes temporary local staging constraints.
  storageAvailableBytes?: number;
  availableBytesKnown?: boolean;
  overQuota: boolean;
  quotaBytes?: number | null;
}
export interface MediaList {
  items: MediaView[];
  upload: UploadView | null;
  policy: MediaPolicy;
}
export function mediaCover(item: MediaView) {
  return item.hasCover ? `/api/media/${item.id}/cover?v=${item.revision}` : '';
}
export function mediaEnabled() {
  return (
    typeof window !== 'undefined' &&
    !!(window as Window & { RUNTIME_CONFIG?: { ENABLE_MEDIA?: boolean } })
      .RUNTIME_CONFIG?.ENABLE_MEDIA
  );
}
export function formatMediaBytes(bytes: number) {
  return bytes >= GiB
    ? `${(bytes / GiB).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
export function mediaDuration(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(
        2,
        '0'
      )}:${String(n % 60).padStart(2, '0')}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
