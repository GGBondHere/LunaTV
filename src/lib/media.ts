export const MEDIA_SOURCE = '__uploaded_media__';
export const MEDIA_CHUNK_BYTES = 8 * 1024 * 1024;
export const MEDIA_COVER_BYTES = 5 * 1024 * 1024;
export const MEDIA_SETTINGS_KEY = 'media:settings';
export const GiB = 1024 ** 3;

export interface MediaSettings {
  allowUploads: boolean;
  quotaGiB: number;
  maxFileGiB: number;
  minFreeGiB: number;
}
export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  allowUploads: true,
  quotaGiB: 70,
  maxFileGiB: 4,
  minFreeGiB: 10,
};

export function parseMediaSettings(value: unknown): MediaSettings {
  if (value === undefined || value === null)
    return { ...DEFAULT_MEDIA_SETTINGS };
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
  return {
    allowUploads: input.allowUploads,
    quotaGiB: input.quotaGiB,
    maxFileGiB: input.maxFileGiB,
    minFreeGiB: input.minFreeGiB,
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
  hasCover: boolean;
  canManage: boolean;
  pendingDeletion?: boolean;
}
export interface UploadView {
  id: string;
  name: string;
  size: number;
  modified: number;
  title: string;
  offset: number;
  hashes: string[];
  hasCover: boolean;
  updatedAt: number;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  error?: string;
}
export interface MediaPolicy {
  enabled: boolean;
  reason: string;
  settings: MediaSettings;
  usedBytes: number;
  reservedBytes: number;
  freeBytes: number;
  availableBytes: number;
  overQuota: boolean;
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
