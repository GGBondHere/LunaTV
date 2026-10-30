import { createHash, randomUUID } from 'crypto';
import {
  access,
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  truncate,
} from 'fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { isAbsolute, join, resolve } from 'path';
import { Readable } from 'stream';

import { getAuthInfoFromCookie } from './auth';
import { getConfig } from './config';
import { db } from './db';
import {
  type CloudCapacity,
  type MediaAdminPolicy,
  type MediaConnection,
  type MediaList,
  type MediaPolicy,
  type MediaScanStatus,
  type MediaSettings,
  type MediaView,
  type UploadView,
  DEFAULT_LOCAL_SCAN,
  GiB,
  MEDIA_CHUNK_BYTES,
  MEDIA_COVER_BYTES,
  MEDIA_LEGACY_CHUNK_BYTES,
  MEDIA_SOURCE,
  MEDIA_UPLOAD_CHECKPOINT_BYTES,
  MEDIA_UPLOAD_REQUESTS,
  MEDIA_UPLOAD_WINDOW_BYTES,
  parseMediaSettings,
} from './media';
import {
  type LocalMediaRef,
  deleteLocalMedia,
  LocalMediaError,
  localObject,
  localPath,
  openLocalMedia,
} from './media-local.server';
import { probeRemote } from './media-probe.server';
import {
  checkMediaTools,
  createMediaCover,
  inspectMedia,
} from './media-processing.server';
import {
  checkConnection,
  davDelete,
  davPut,
  davStat,
  ensureDavDirectory,
  inspectRemoteService,
  listDavDirectory,
  objectFingerprint,
  queryCapacity,
  RemoteMediaError,
  remoteObject,
  remotePath,
  remoteStream,
  resolveRemoteConnection,
} from './media-remote.server';
import {
  cachedRemoteStream,
  createMediaStreamLease,
  invalidateMediaStreams,
  measuredMediaResponse,
} from './media-stream.server';
import type { PlayRecord } from './types';

const COVER_RESERVE = 12 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const SCAN_FORMAT_VERSION = 'h264-hevc-v1:';
interface UploadRuntime {
  session: Session;
  durableOffset: number;
  parts: Map<number, string>;
  active: Map<number, UploadWrite>;
  checkpoint?: Promise<void>;
  checkpointRetryAt?: number;
}
interface UploadWrite {
  stop: AbortController;
  done: Promise<void>;
  writtenBytes: number;
}
interface MediaAuth {
  username: string;
  isAdmin: boolean;
}
interface Session extends UploadView {
  owner: string;
  storage?: RemoteRef;
  remoteAttempted?: boolean;
  fingerprint?: string;
  customCover?: boolean;
  playable?: boolean;
}
interface RemoteRef {
  connectionId: string;
  path: string;
  metadataSource?: 'propfind';
  nativeId?: string; // Legacy metadata, no longer queried.
  modified?: string;
  fingerprint?: string;
  etag?: string;
}
interface CapacityLedger {
  baseUsed: number;
  debt: number;
  ids?: string[];
  entries?: Record<string, number>;
  deletedIds?: string[];
}
interface RecordFile extends Omit<MediaView, 'canManage'> {
  owner: string;
  state: 'ready' | 'deleting';
  cleanupOnly?: boolean;
  retainSource?: boolean;
  cleanupError?: string;
  storage?: RemoteRef;
  imported?: boolean;
  localFile?: LocalMediaRef;
  customTitle?: boolean;
  customCover?: boolean;
  unavailable?: boolean;
  staged?: { hashes: string[]; chunkBytes: number };
}
interface Controller {
  root: string;
  init?: Promise<void>;
  locks: Map<string, Promise<unknown>>;
  active: number;
  worker: Promise<unknown>;
  processing: Set<string>;
  processingJobs: Map<string, Promise<void>>;
  requeue: Set<string>;
  timer?: ReturnType<typeof setInterval>;
  coverReservations: Map<string, number>;
  remoteAborts: Map<string, AbortController>;
  capacities: Map<string, CloudCapacity>;
  capacityJobs: Map<string, Promise<CloudCapacity>>;
  uploads: Map<string, UploadRuntime>;
  transfers: Map<
    string,
    {
      sent: number;
      started: number;
      sampleAt: number;
      sampleBytes: number;
      speed: number;
      finished: boolean;
      finishedAt: number;
    }
  >;
  deletionJobs: Set<string>;
  deletionAborts: Map<string, AbortController>;
  deletionWorker: Promise<void>;
  localDeletionWorker: Promise<void>;
  restoring?: boolean;
}
const symbol = Symbol.for('lunatv.media.controller');
const globalMedia = globalThis as typeof globalThis & { [symbol]?: Controller };
const controller: Controller =
  globalMedia[symbol] ||
  (globalMedia[symbol] = {
    root: '',
    locks: new Map(),
    active: 0,
    worker: Promise.resolve(),
    processing: new Set(),
    processingJobs: new Map(),
    requeue: new Set(),
    coverReservations: new Map(),
    remoteAborts: new Map(),
    capacities: new Map(),
    capacityJobs: new Map(),
    uploads: new Map(),
    transfers: new Map(),
    deletionJobs: new Set(),
    deletionAborts: new Map(),
    deletionWorker: Promise.resolve(),
    localDeletionWorker: Promise.resolve(),
  });
controller.uploads ||= new Map();
controller.processingJobs ||= new Map();
controller.transfers ||= new Map();
controller.deletionJobs ||= new Set();
controller.deletionAborts ||= new Map();
controller.deletionWorker ||= Promise.resolve();
controller.localDeletionWorker ||= Promise.resolve();

export class MediaError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
function fail(code: string, message: string, status = 400): never {
  throw new MediaError(code, message, status);
}
export function mediaResponse(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
export function mediaError(error: unknown) {
  if (error instanceof RemoteMediaError || error instanceof LocalMediaError)
    error = new MediaError(error.code, error.message, error.status);
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC')
    error = new MediaError(
      'DISK_LOW',
      '磁盘空间不足，上传已暂停，断点仍然保留',
      507
    );
  return mediaResponse(
    {
      code: error instanceof MediaError ? error.code : 'MEDIA_ERROR',
      error:
        error instanceof MediaError
          ? error.message
          : '共享视频操作失败，请重试',
    },
    error instanceof MediaError ? error.status : 500
  );
}
export async function mediaRoute(action: () => Promise<Response>) {
  try {
    return await action();
  } catch (error) {
    return mediaError(error);
  }
}
export async function mediaAuth(request: NextRequest): Promise<MediaAuth> {
  if (
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage'
  )
    fail('UNAVAILABLE', '共享视频需要服务端用户存储', 400);
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin) {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        fail('FORBIDDEN', '不允许跨站操作', 403);
      }
      if (host !== request.headers.get('host') && host !== request.nextUrl.host)
        fail('FORBIDDEN', '不允许跨站操作', 403);
    }
  }
  const username = getAuthInfoFromCookie(request)?.username;
  if (!username) fail('UNAUTHORIZED', '请先登录', 401);
  const user = (await getConfig()).UserConfig.Users.find(
    (item) => item.username === username
  );
  if (username !== process.env.USERNAME && (!user || user.banned))
    fail('UNAUTHORIZED', '账号已失效或被封禁', 401);
  return {
    username,
    isAdmin:
      username === process.env.USERNAME ||
      user?.role === 'admin' ||
      user?.role === 'owner',
  };
}
export function requireMediaAdmin(auth: MediaAuth) {
  if (!auth.isAdmin) fail('FORBIDDEN', '只有管理员可以修改共享视频设置', 403);
}
function validId(id: string) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    fail('NOT_FOUND', '视频或上传任务不存在', 404);
  return id;
}
function dir(kind: 'items' | 'uploads', id: string) {
  return join(controller.root, kind, validId(id));
}
async function lock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = controller.locks.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  controller.locks.set(key, current);
  try {
    return await current;
  } finally {
    if (controller.locks.get(key) === current) controller.locks.delete(key);
  }
}
async function atomicJSON(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
async function json<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function ids(kind: 'items' | 'uploads') {
  return (await readdir(join(controller.root, kind), { withFileTypes: true }))
    .filter((item) => item.isDirectory() && /^[0-9a-f-]{36}$/i.test(item.name))
    .map((item) => item.name);
}
async function treeSize(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    try {
      bytes += entry.isDirectory()
        ? await treeSize(child)
        : (await stat(child)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return bytes;
}
async function initialize() {
  const configured =
    process.env.MEDIA_DIR?.trim() ||
    (process.env.DOCKER_ENV === 'true'
      ? '/data/media'
      : join(process.cwd(), 'data', 'media'));
  if (!isAbsolute(configured))
    fail('INVALID_DIRECTORY', 'MEDIA_DIR 必须为绝对路径');
  if (!controller.init) {
    controller.root = resolve(configured);
    controller.init = (async () => {
      await mkdir(controller.root, { recursive: true });
      await access(controller.root, constants.R_OK | constants.W_OK);
      await mkdir(join(controller.root, 'items'), { recursive: true });
      await mkdir(join(controller.root, 'uploads'), { recursive: true });
      await checkMediaTools();
      const recover: Session[] = [];
      for (const id of await ids('uploads')) {
        const path = dir('uploads', id);
        const session = await json<Session>(join(path, 'session.json'));
        if (!session) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        const published = await json<RecordFile>(
          join(dir('items', id), 'media.json')
        );
        if (!published) {
          const moved = join(dir('items', id), 'video.mp4');
          if (await stat(moved).catch(() => null)) {
            await rename(moved, join(path, 'video.part'));
            await rename(
              join(dir('items', id), 'cover.jpg'),
              join(path, 'cover.jpg')
            ).catch(() => undefined);
            await rm(dir('items', id), { recursive: true, force: true });
          }
        }
        if (
          published?.staged &&
          (published.state === 'deleting' || session.status === 'cancelling')
        ) {
          session.status = 'cancelling';
          session.accepted = true;
        } else if (published?.staged && published.state === 'ready') {
          session.accepted = true;
          session.playable =
            !published.processing &&
            !published.processingError &&
            !published.unavailable;
          session.status = published.processingError ? 'failed' : 'processing';
          if (published.processingError) {
            session.error = published.processingError;
            session.retryable = !/^(视频容器不支持|视频编码不支持)/.test(
              published.processingError
            );
          }
          session.offset = session.size;
          session.hashes = published.staged.hashes;
          session.chunkBytes = published.staged.chunkBytes;
          if (
            !published.storage &&
            !(await stat(join(path, 'video.part')).catch(() => null)) &&
            (await stat(join(dir('items', id), 'video.mp4')).catch(() => null))
          )
            await rename(
              join(dir('items', id), 'video.mp4'),
              join(path, 'video.part')
            );
          const stagedFile = await stat(join(path, 'video.part')).catch(
            () => null
          );
          if (!stagedFile || stagedFile.size !== session.size) {
            session.status = 'failed';
            session.retryable = true;
            session.error = '视频暂存文件缺失或不完整';
            published.unavailable = true;
            published.processing = false;
            if (!session.playable)
              published.processingError = '视频文件缺失或不完整';
            await atomicJSON(join(dir('items', id), 'media.json'), published);
          }
        } else if (published?.state === 'ready') {
          session.status = 'ready';
          if (published.storage)
            await rm(join(path, 'video.part'), { force: true });
        }
        if (
          (session.status === 'uploading' || session.status === 'processing') &&
          published?.state !== 'ready'
        ) {
          const file = await stat(join(path, 'video.part')).catch(() => null);
          if (!file || file.size < session.offset) {
            session.status = 'failed';
            session.error = '临时文件不完整，请取消后重新上传';
          } else await truncate(join(path, 'video.part'), session.offset);
        }
        await atomicJSON(join(path, 'session.json'), session);
        if (session.status === 'processing' || session.status === 'cancelling')
          recover.push(session);
      }
      recover.forEach((session) =>
        queueMediaProcessing(session.id, {
          username: session.owner,
          isAdmin: false,
        })
      );
      await cleanupMediaArtifacts().catch(() => undefined);
      for (const item of await records())
        if (item.state === 'deleting')
          queueMediaDeletion(item.id, !!item.storage);
      if (!controller.timer) {
        controller.timer = setInterval(() => {
          void cleanupMedia().catch(() => undefined);
        }, 60 * 60 * 1000);
        controller.timer.unref();
      }
    })().catch(() => {
      controller.init = undefined;
      fail(
        'STORAGE_ERROR',
        '媒体目录不可读写，或缺少 ffmpeg/ffprobe；请检查挂载、UID 1001 权限和镜像'
      );
    });
  }
  await controller.init;
}
async function sessions() {
  const records = await Promise.all(
    (
      await ids('uploads')
    ).map(
      (id) =>
        controller.uploads.get(id)?.session ||
        json<Session>(join(dir('uploads', id), 'session.json'))
    )
  );
  return records.filter((item): item is Session => item !== null);
}
async function records() {
  const result = await Promise.all(
    (
      await ids('items')
    ).map((id) => json<RecordFile>(join(dir('items', id), 'media.json')))
  );
  return result.filter((item): item is RecordFile => item !== null);
}
export async function getMediaSettings() {
  return parseMediaSettings(await db.getMediaSettings());
}
function mergeConnectionCredentials(c: MediaConnection, old?: MediaConnection) {
  const input = c as MediaConnection & {
    clearPassword?: boolean;
  };
  return {
    ...c,
    password: input.clearPassword ? '' : c.password || old?.password || '',
  };
}
export async function saveMediaSettings(value: unknown) {
  return lock('settings', async () => {
    const previous = await getMediaSettings();
    let settings: MediaSettings;
    try {
      const input = value as MediaSettings;
      if (!input || typeof input !== 'object') throw new Error('设置无效');
      const incoming = input.connections || [];
      const parsed = parseMediaSettings({
        ...input,
        connections: incoming.map((c) =>
          mergeConnectionCredentials(
            c,
            previous.connections?.find((p) => p.id === c.id)
          )
        ),
      });
      const connections: MediaConnection[] = [];
      for (const c of parsed.connections || []) {
        const old = previous.connections?.find((p) => p.id === c.id);
        const merged =
          !old || old.url !== c.url ? await resolveRemoteConnection(c) : c;
        if (
          old &&
          [old.url, old.root, old.username].join('\n') !==
            [merged.url, merged.root, merged.username].join('\n')
        ) {
          merged.id = randomUUID();
          if (parsed.activeConnectionId === c.id)
            parsed.activeConnectionId = merged.id;
        }
        connections.push(merged);
      }
      // Retain identities even across an active connection switch; old videos must never be retargeted.
      for (const old of previous.connections || [])
        if (!connections.some((c) => c.id === old.id))
          connections.push({ ...old, scan: { ...old.scan, automatic: false } });
      settings = parseMediaSettings({ ...parsed, connections });
    } catch (error) {
      fail('INVALID_SETTINGS', (error as Error).message);
    }
    await lock('quota', () => db.setMediaSettings(settings));
    for (const [id, job] of Array.from(scanner.jobs)) {
      if (id === 'local') {
        if (
          JSON.stringify(settings.localScan || DEFAULT_LOCAL_SCAN) !==
          JSON.stringify(previous.localScan || DEFAULT_LOCAL_SCAN)
        )
          job.stop.abort();
        continue;
      }
      const next = settings.connections?.find((c) => c.id === id);
      const before = previous.connections?.find((c) => c.id === id);
      if (!next || JSON.stringify(next) !== JSON.stringify(before))
        job.stop.abort();
    }
    controller.capacities.clear();
    return settings;
  });
}
function publicSettings(settings: MediaSettings): MediaSettings {
  return {
    allowUploads: settings.allowUploads,
    quotaGiB: settings.quotaGiB,
    maxFileGiB: settings.maxFileGiB,
    minFreeGiB: settings.minFreeGiB,
  };
}
async function connection(id: string) {
  const found = (await getMediaSettings()).connections?.find(
    (c) => c.id === id
  );
  if (!found)
    fail('MISSING_CONNECTION', '视频的存储连接尚未配置，请联系管理员补配', 503);
  return found;
}
async function capacity(c: MediaConnection, force = false) {
  const cached = controller.capacities.get(c.id);
  if (
    !force &&
    cached &&
    Date.now() - (cached.attemptedAt ?? cached.checkedAt) < 60000
  )
    return cached;
  let job = controller.capacityJobs.get(c.id);
  if (!job) {
    job = queryCapacity(c, undefined, force)
      .then(async (result) => {
        controller.capacities.set(c.id, result);
        // Conservative debt persists until a quota snapshot actually covers committed writes.
        await lock('capacity:' + c.id, async () => {
          const file = join(controller.root, `capacity-${c.id}.json`);
          const ledger = await json<CapacityLedger>(file);
          if (
            ledger &&
            !result.stale &&
            result.used !== null &&
            (ledger.debt === 0 || result.used >= ledger.baseUsed + ledger.debt)
          )
            await atomicJSON(file, {
              ...ledger,
              baseUsed: result.used,
              debt: 0,
              ids: ledger.ids,
              entries: {},
            });
        });
        return result;
      })
      .finally(() => controller.capacityJobs.delete(c.id));
    controller.capacityJobs.set(c.id, job);
  }
  return job;
}
async function cloudDebt(
  c: MediaConnection,
  committed?: { id: string; bytes: number },
  releasedId?: string,
  releasedBytes = 0
) {
  return lock('capacity:' + c.id, async () => {
    const file = join(controller.root, `capacity-${c.id}.json`);
    const state: CapacityLedger = (await json<CapacityLedger>(file)) || {
      baseUsed: controller.capacities.get(c.id)?.used || 0,
      debt: 0,
      ids: [],
      entries: {},
    };
    if (committed && !state.ids?.includes(committed.id)) {
      state.debt += committed.bytes;
      state.ids = [...(state.ids || []), committed.id];
      state.entries = { ...state.entries, [committed.id]: committed.bytes };
    }
    if (releasedId && !state.deletedIds?.includes(releasedId)) {
      if (!state.ids?.includes(releasedId) && !state.entries?.[releasedId])
        return state.debt;
      if (state.entries?.[releasedId]) {
        state.debt = Math.max(0, state.debt - state.entries[releasedId]);
        delete state.entries[releasedId];
      } else if (state.debt > 0 && state.ids?.includes(releasedId))
        state.baseUsed = Math.max(0, state.baseUsed - releasedBytes);
      state.deletedIds = [...(state.deletedIds || []), releasedId];
    }
    await atomicJSON(file, state);
    return state.debt;
  });
}
async function displayedCapacity(c: MediaConnection): Promise<CloudCapacity> {
  const cached = controller.capacities.get(c.id);
  if (cached && Date.now() - (cached.attemptedAt ?? cached.checkedAt) < 60000)
    return cached;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      capacity(c),
      new Promise<CloudCapacity>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              total: null,
              used: null,
              free: null,
              checkedAt: Date.now(),
              error: '容量查询尚未完成，可稍后刷新；已有视频仍可观看',
            }),
          1500
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function policy(): Promise<MediaPolicy> {
  const settings = await getMediaSettings();
  const usedBytes = await treeSize(controller.root);
  // 未完成任务按固定预算计费；流式写入与清单提交之间也不会少算或重复预留视频。
  let allocated = 0;
  let managedWritten = 0;
  for (const id of await ids('items')) {
    const written = await treeSize(dir('items', id));
    managedWritten += written;
    allocated += controller.coverReservations.get(id) ?? written;
  }
  for (const session of await sessions()) {
    const written = await treeSize(dir('uploads', session.id));
    managedWritten += written;
    allocated +=
      session.status !== 'ready' &&
      (session.status !== 'failed' ||
        session.retryable ||
        session.remoteAttempted)
        ? session.size + COVER_RESERVE
        : written;
  }
  // Files placed into the media directory externally also consume the local quota.
  allocated += Math.max(0, usedBytes - managedWritten);
  const reservedBytes = Math.max(0, allocated - usedBytes);
  const stagingReservedBytes = await pendingUploadBytes();
  const disk = await statfs(controller.root, { bigint: true });
  const freeBytes = Number(disk.bavail * disk.bsize);
  const availableBytes = Math.max(
    0,
    Math.min(
      settings.quotaGiB * GiB - allocated,
      freeBytes - settings.minFreeGiB * GiB - stagingReservedBytes
    )
  );
  let cloudUsed = 0,
    cloudReserved = 0;
  let quotaBytes: number | null = settings.quotaGiB * GiB;
  let targetAvailable = availableBytes;
  let storageAvailableBytes = availableBytes;
  let availableBytesKnown = true;
  let overQuota = allocated > settings.quotaGiB * GiB;
  let reason = '';
  if (settings.uploadStorage === 'webdav') {
    availableBytesKnown = false;
    try {
      const c = await connection(settings.activeConnectionId || '');
      const target = await inspectRemoteService({
        ...c,
        scan: { ...c.scan, root: c.root },
      });
      if (!target.canScan)
        fail(
          'REMOTE_UNAVAILABLE',
          'WebDAV 存储目录不可访问，请检查地址、账号、密码和目录',
          503
        );
      const cloud = await displayedCapacity(c).catch(() => ({
        free: null,
      }));
      cloudUsed = (await records())
        .filter((r) => r.storage?.connectionId === c.id && !r.staged)
        .reduce((n, r) => n + r.bytes, 0);
      cloudReserved = (await sessions())
        .filter((s) => s.storage?.connectionId === c.id && s.status !== 'ready')
        .reduce((n, s) => n + s.size, 0);
      quotaBytes = settings.remoteQuotaGiB
        ? settings.remoteQuotaGiB * GiB
        : null;
      const budget =
        quotaBytes === null ? Infinity : quotaBytes - cloudUsed - cloudReserved;
      availableBytesKnown = cloud.free !== null || quotaBytes !== null;
      const cloudFree =
        cloud.free === null
          ? Infinity
          : cloud.free - cloudReserved - (await cloudDebt(c));
      storageAvailableBytes = Math.max(0, Math.min(budget, cloudFree));
      targetAvailable = Math.max(
        0,
        Math.min(
          storageAvailableBytes,
          freeBytes - settings.minFreeGiB * GiB - stagingReservedBytes
        )
      );
      overQuota = budget < 0;
    } catch (e) {
      targetAvailable = 0;
      storageAvailableBytes = 0;
      reason =
        e instanceof MediaError || e instanceof RemoteMediaError
          ? e.message
          : '暂时无法使用所选上传位置，请稍后重试';
    }
  }
  return {
    enabled: true,
    uploadAvailable: settings.allowUploads && targetAvailable > 0,
    reason,
    settings: publicSettings(settings),
    usedBytes: settings.uploadStorage === 'webdav' ? cloudUsed : usedBytes,
    reservedBytes:
      settings.uploadStorage === 'webdav' ? cloudReserved : reservedBytes,
    freeBytes,
    availableBytes: targetAvailable,
    storageAvailableBytes: availableBytesKnown
      ? storageAvailableBytes
      : undefined,
    availableBytesKnown,
    overQuota,
    quotaBytes,
  };
}
export async function mediaPolicy(): Promise<MediaPolicy> {
  const settings = await getMediaSettings();
  let readable = false;
  try {
    await initialize();
    readable = true;
    return await policy();
  } catch (error) {
    return {
      enabled: readable,
      uploadAvailable: false,
      reason:
        error instanceof MediaError
          ? error.message
          : readable
          ? '无法计算上传空间，已有视频仍可观看'
          : '无法读取媒体目录',
      settings: publicSettings(settings),
      usedBytes: 0,
      reservedBytes: 0,
      freeBytes: 0,
      availableBytes: 0,
      overQuota: false,
    };
  }
}
function view(item: RecordFile, auth: MediaAuth): MediaView {
  return {
    id: item.id,
    title: item.title,
    duration: item.duration,
    width: item.width,
    height: item.height,
    bytes: item.bytes,
    createdAt: item.createdAt,
    revision: item.revision,
    contentRevision: item.contentRevision,
    hasCover: item.hasCover,
    canManage: auth.isAdmin || (!item.imported && item.owner === auth.username),
    unavailable: item.unavailable,
    processing: item.processing,
    processingError: item.processingError,
    videoCodec: item.videoCodec,
  };
}
function uploadView(session: Session): UploadView {
  const transfer =
    session.status === 'processing' && !session.playable
      ? controller.transfers.get(session.id)
      : undefined;
  return {
    id: session.id,
    name: session.name,
    size: session.size,
    modified: session.modified,
    title: session.title,
    offset: session.offset,
    hashes: session.hashes,
    chunkBytes: session.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES,
    checkpointOffset:
      controller.uploads.get(session.id)?.durableOffset ?? session.offset,
    received: Array.from(controller.uploads.get(session.id)?.parts || []).map(
      ([offset, hash]) => ({ offset, hash })
    ),
    hasCover: session.hasCover,
    updatedAt: session.updatedAt,
    status:
      session.playable && session.status !== 'cancelling'
        ? 'ready'
        : session.status,
    error: session.playable ? undefined : session.error,
    stage: session.playable ? undefined : session.stage,
    retryable: session.retryable,
    accepted:
      session.accepted || session.playable || session.status === 'ready',
    transfer: transfer
      ? {
          sentBytes: transfer.sent,
          totalBytes: session.size,
          elapsedMs: Date.now() - transfer.started,
          speed: transfer.finished ? 0 : transfer.speed,
          awaitingConfirmation: transfer.finished,
        }
      : undefined,
  };
}
export async function mediaItems(
  auth: MediaAuth,
  mine = false
): Promise<MediaView[]> {
  await initialize();
  return (await records())
    .filter(
      (item) =>
        item.state === 'ready' && (!mine || item.owner === auth.username)
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => view(item, auth));
}
export async function mediaList(
  auth: MediaAuth,
  mine = false
): Promise<MediaList> {
  const status = await mediaPolicy();
  if (!status.enabled) return { items: [], upload: null, policy: status };
  await cleanupMedia();
  const items = await mediaItems(auth, mine);
  const session = (await sessions()).find(
    (item) =>
      item.owner === auth.username &&
      item.status !== 'ready' &&
      !item.playable &&
      !item.accepted
  );
  return {
    items,
    upload: session ? uploadView(session) : null,
    policy: status,
  };
}
async function record(id: string, allowUnavailable = false) {
  await initialize();
  const item = await json<RecordFile>(join(dir('items', id), 'media.json'));
  if (!item || item.state !== 'ready') {
    invalidateMediaStreams(id);
    fail('NOT_FOUND', '视频已被移除或尚未发布', 404);
  }
  if (!allowUnavailable && (item.processing || item.processingError))
    fail(
      item.processing ? 'MEDIA_PROCESSING' : 'MEDIA_PROCESSING_FAILED',
      item.processing
        ? '视频正在处理中，请稍后播放'
        : item.processingError || '视频处理失败',
      409
    );
  if (item.unavailable && !allowUnavailable) {
    invalidateMediaStreams(id);
    fail(
      'MEDIA_UNAVAILABLE',
      '源文件已变化或不可用，请等待管理员重新扫描',
      409
    );
  }
  return item;
}
export async function getMedia(id: string, auth: MediaAuth) {
  return view(await record(id), auth);
}
function manage(owner: string, auth: MediaAuth) {
  if (owner !== auth.username && !auth.isAdmin)
    fail('FORBIDDEN', '只能管理自己上传的视频', 403);
}
function manageRecord(item: RecordFile | Session, auth: MediaAuth) {
  if ('imported' in item && item.imported) requireMediaAdmin(auth);
  else manage(item.owner, auth);
}
function title(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
    fail('INVALID_TITLE', '标题需要 1–100 个字符');
  return value.trim();
}
async function getSession(id: string, auth: MediaAuth) {
  await initialize();
  const session =
    controller.uploads.get(id)?.session ||
    (await json<Session>(join(dir('uploads', id), 'session.json')));
  if (!session) fail('NOT_FOUND', '上传任务已过期，请重新选择视频', 404);
  manage(session.owner, auth);
  return session;
}
async function persistSession(session: Session, syncVideo: boolean) {
  if (syncVideo) {
    const file = await open(
      join(dir('uploads', session.id), 'video.part'),
      'r+'
    );
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  await atomicJSON(join(dir('uploads', session.id), 'session.json'), session);
}
async function saveSession(session: Session, videoSynced = false) {
  return lock('upload-state:' + session.id, async () => {
    const live = controller.uploads.get(session.id);
    if (
      live?.session.status === 'cancelling' &&
      session.status !== 'cancelling'
    )
      fail('INTERRUPTED', '任务已取消', 409);
    await persistSession(
      session,
      !!live &&
        !videoSynced &&
        session.status !== 'cancelling' &&
        !(session.status === 'failed' && !session.retryable) &&
        session.offset > live.durableOffset
    );
    if (live) {
      live.durableOffset = session.offset;
    }
  });
}
function queueUploadCheckpoint(live: UploadRuntime) {
  const session = live.session;
  if (
    live.checkpoint ||
    controller.restoring ||
    controller.uploads.get(session.id) !== live ||
    session.status !== 'uploading' ||
    Date.now() < (live.checkpointRetryAt || 0) ||
    session.offset <= live.durableOffset ||
    (session.offset !== session.size &&
      session.offset - live.durableOffset < MEDIA_UPLOAD_CHECKPOINT_BYTES)
  )
    return;
  const snapshot = { ...session, hashes: [...session.hashes] };
  // This queue never takes the upload lock or replaces newer in-memory receipts.
  live.checkpoint = lock('upload-state:' + session.id, async () => {
    if (
      controller.restoring ||
      controller.uploads.get(session.id) !== live ||
      live.session.status !== 'uploading' ||
      snapshot.offset <= live.durableOffset
    )
      return;
    await persistSession(snapshot, true);
    live.durableOffset = snapshot.offset;
    live.checkpointRetryAt = 0;
  })
    .catch((error: unknown) => {
      live.checkpointRetryAt = Date.now() + 5000;
      // eslint-disable-next-line no-console
      console.warn('[media-upload] checkpoint failed', {
        id: session.id,
        code: (error as NodeJS.ErrnoException)?.code || 'STORAGE_ERROR',
      });
    })
    .finally(() => {
      live.checkpoint = undefined;
      queueUploadCheckpoint(live);
    });
}
export async function uploadStatus(id: string, auth: MediaAuth) {
  return lock(id, async () => {
    const session = await getSession(id, auth);
    const live = controller.uploads.get(id);
    if (live) queueUploadCheckpoint(live);
    return uploadView(session);
  });
}
export async function beginUpload(
  input: {
    name?: unknown;
    size?: unknown;
    modified?: unknown;
    title?: unknown;
    chunkBytes?: unknown;
  },
  auth: MediaAuth
) {
  await initialize();
  return lock('quota', async () => {
    if (controller.restoring)
      fail('SETTINGS_RESTORE', '数据正在恢复，请稍后上传', 409);
    const current = await policy();
    const settings = await getMediaSettings();
    if (!current.settings.allowUploads)
      fail('UPLOAD_DISABLED', '管理员已暂停上传', 403);
    const size = input.size;
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      (input.chunkBytes !== undefined &&
        input.chunkBytes !== MEDIA_CHUNK_BYTES &&
        input.chunkBytes !== MEDIA_LEGACY_CHUNK_BYTES) ||
      typeof input.name !== 'string' ||
      input.name.length > 255 ||
      !/\.mp4$/i.test(input.name) ||
      typeof input.modified !== 'number' ||
      !Number.isSafeInteger(input.modified) ||
      input.modified < 0
    )
      fail('INVALID_FILE', '请选择有效的 MP4 视频');
    const existing = (await sessions()).find(
      (item) =>
        item.owner === auth.username &&
        item.status !== 'ready' &&
        !item.playable &&
        !item.accepted
    );
    if (existing) {
      if (
        existing.name === input.name &&
        existing.size === size &&
        existing.modified === input.modified &&
        existing.status !== 'failed'
      )
        return uploadView(existing);
      fail('UPLOAD_CONFLICT', '已有未完成上传，请先继续或取消该任务', 409);
    }
    if (current.uploadAvailable === false)
      fail(
        'UPLOAD_UNAVAILABLE',
        current.reason || '当前上传位置额度或空间不足，已有视频仍可观看',
        507
      );
    if (size > current.settings.maxFileGiB * GiB)
      fail(
        'FILE_TOO_LARGE',
        `文件超过单个 ${current.settings.maxFileGiB} GiB 的限制`,
        413
      );
    if (size + COVER_RESERVE > current.availableBytes)
      fail(
        'NO_SPACE',
        current.overQuota
          ? '共享视频已超额，暂停新增上传'
          : '额度或磁盘空间不足，无法预留此次上传',
        507
      );
    const session: Session = {
      id: randomUUID(),
      owner: auth.username,
      name: input.name,
      size,
      modified: input.modified,
      title: title(input.title),
      offset: 0,
      hashes: [],
      chunkBytes:
        input.chunkBytes === MEDIA_CHUNK_BYTES
          ? MEDIA_CHUNK_BYTES
          : MEDIA_LEGACY_CHUNK_BYTES,
      status: 'uploading',
      hasCover: false,
      updatedAt: Date.now(),
      ...(settings.uploadStorage === 'webdav'
        ? {
            storage: {
              connectionId: settings.activeConnectionId || '',
              path: remotePath(
                await connection(settings.activeConnectionId || ''),
                (await connection(settings.activeConnectionId || '')).root +
                  '/.lunatv-media/' +
                  randomUUID() +
                  '.mp4'
              ),
            },
          }
        : {}),
    };
    await mkdir(dir('uploads', session.id));
    const file = await open(
      join(dir('uploads', session.id), 'video.part'),
      'wx'
    );
    await file.close();
    await saveSession(session);
    return uploadView(session);
  });
}
async function pendingUploadBytes() {
  let remaining = (await sessions())
    .filter((item) => ['uploading', 'processing'].includes(item.status))
    .reduce((n, item) => {
      const live = controller.uploads.get(item.id);
      const chunkBytes = item.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES;
      const received = Array.from(live?.parts.keys() || []).reduce(
        (sum, offset) => sum + Math.min(chunkBytes, item.size - offset),
        0
      );
      const writing = Array.from(live?.active || []).reduce(
        (sum, [offset, part]) =>
          sum +
          (offset >= item.offset && !live?.parts.has(offset)
            ? part.writtenBytes
            : 0),
        0
      );
      return (
        n +
        Math.max(0, item.size - item.offset - received - writing) +
        COVER_RESERVE
      );
    }, 0);
  for (const [id, budget] of Array.from(controller.coverReservations))
    remaining += Math.max(0, budget - (await treeSize(dir('items', id))));
  return remaining;
}
async function checkWrite(bytes: number, enforceUploads = true) {
  if (controller.restoring)
    fail('SETTINGS_RESTORE', '数据正在恢复，上传已暂停', 409);
  const settings = await getMediaSettings();
  if (enforceUploads && !settings.allowUploads)
    fail('UPLOAD_DISABLED', '管理员已暂停上传，断点已保留', 403);
  const remaining = await pendingUploadBytes();
  const disk = await statfs(controller.root, { bigint: true });
  if (
    Number(disk.bavail * disk.bsize) - Math.max(bytes, remaining) <
    settings.minFreeGiB * GiB
  )
    fail('DISK_LOW', '磁盘触及保留空间，上传已暂停，断点保留 24 小时', 507);
}
async function limitedBody(
  request: NextRequest,
  limit: number,
  write: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal = request.signal
) {
  if (!request.body) fail('EMPTY_BODY', '没有收到文件内容');
  const reader = request.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  let count = 0;
  try {
    while (!request.signal.aborted && !signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) fail('CHUNK_TOO_LARGE', '上传块超过限制', 413);
      await write(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (request.signal.aborted || signal.aborted)
    fail('INTERRUPTED', '上传连接中断，断点已保留', 409);
  return count;
}
export async function appendUpload(
  id: string,
  request: NextRequest,
  auth: MediaAuth,
  timing: Record<string, number> = {}
) {
  const queuedAt = performance.now();
  let finish = () => undefined as void;
  let live: UploadRuntime | undefined;
  const stop = new AbortController();
  const abort = () => stop.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) stop.abort();
  const offset = Number(request.headers.get('Upload-Offset'));
  const checksum = request.headers.get('Upload-Checksum');
  let admitted = false;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let drainWrites = async () => undefined as void;
  try {
    const admission = await lock<{ view: UploadView } | { expected: number }>(
      id,
      async () => {
        timing.queue = performance.now() - queuedAt;
        const session = await getSession(id, auth);
        if (session.status !== 'uploading')
          fail('UPLOAD_STATE', '该任务当前不能接收数据', 409);
        const chunkBytes = session.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES;
        if (
          !request.headers.has('Upload-Offset') ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset >= session.size ||
          offset % chunkBytes !== 0 ||
          (checksum !== null && !/^[a-f0-9]{64}$/.test(checksum))
        )
          fail('OFFSET_CONFLICT', '上传偏移已变化，请读取断点后继续', 409);
        const expected = Math.min(chunkBytes, session.size - offset);
        const state = controller.uploads.get(id) || {
          session,
          durableOffset: session.offset,
          parts: new Map<number, string>(),
          active: new Map<number, UploadWrite>(),
        };
        const priorHash =
          offset < session.offset
            ? session.hashes[offset / chunkBytes]
            : state.parts.get(offset);
        if (priorHash) {
          if (checksum === priorHash) return { view: uploadView(session) };
          fail(
            'CHUNK_CONFLICT',
            '该分块与已有数据不一致，请重新核对原文件',
            409
          );
        }
        if (offset >= session.offset + MEDIA_UPLOAD_WINDOW_BYTES)
          fail('UPLOAD_WINDOW', '等待前面的分块接收完成，请稍后继续', 429);
        if (state.active.has(offset))
          fail('CHUNK_BUSY', '该分块正在接收，请稍后重试', 409);
        const checkingAt = performance.now();
        await lock('quota', () => checkWrite(expected));
        timing.space = performance.now() - checkingAt;
        if (stop.signal.aborted) fail('INTERRUPTED', '上传已暂停', 409);
        const activeTasks = Array.from(controller.uploads.values()).filter(
          (s) => s.active.size > 0
        ).length;
        if (
          state.active.size >= MEDIA_UPLOAD_REQUESTS ||
          (state.active.size === 0 && activeTasks >= 2)
        )
          fail('UPLOAD_BUSY', '其他朋友正在上传，请稍后重试', 429);
        state.active.set(offset, {
          stop,
          writtenBytes: 0,
          done: new Promise<void>((resolve) => {
            finish = resolve;
          }),
        });
        controller.uploads.set(id, state);
        live = state;
        admitted = true;
        controller.active++;
        return { expected };
      }
    );
    if ('view' in admission) return admission.view;
    const state = live;
    if (!state) fail('UPLOAD_STATE', '上传任务已变化，请重试', 409);
    const expected = admission.expected;
    const filePath = join(dir('uploads', id), 'video.part');
    file = await open(filePath, 'r+');
    let position = offset;
    const hash = createHash('sha256');
    let buffer = Buffer.allocUnsafe(256 * 1024);
    let buffered = 0;
    let writeMs = 0;
    let queuedBytes = 0;
    let writeError: unknown;
    let writeTail = Promise.resolve();
    const pendingWrites = new Set<Promise<void>>();
    drainWrites = () => writeTail;
    const flush = async () => {
      if (writeError) throw writeError;
      if (!buffered) return;
      const data = buffer.subarray(0, buffered);
      buffer = Buffer.allocUnsafe(256 * 1024);
      buffered = 0;
      queuedBytes += data.length;
      const job = writeTail
        .then(async () => {
          if (writeError || stop.signal.aborted) return;
          const started = performance.now();
          let written = 0;
          while (written < data.length) {
            const result = await file?.write(
              data,
              written,
              data.length - written,
              position
            );
            if (!result?.bytesWritten) throw new Error('写入失败');
            written += result.bytesWritten;
            position += result.bytesWritten;
            const active = state.active.get(offset);
            if (active) active.writtenBytes += result.bytesWritten;
          }
          writeMs += performance.now() - started;
        })
        .catch((error: unknown) => {
          writeError = error;
          stop.abort();
        })
        .finally(() => {
          queuedBytes -= data.length;
          pendingWrites.delete(job);
        });
      writeTail = job;
      pendingWrites.add(job);
      // Receive ahead of disk writes, with at most 2 MiB queued per request.
      while (queuedBytes >= 2 * 1024 * 1024) {
        await Promise.race(Array.from(pendingWrites));
        if (writeError) throw writeError;
      }
    };
    const receivingAt = performance.now();
    const count = await limitedBody(
      request,
      expected,
      async (chunk) => {
        hash.update(chunk);
        let start = 0;
        while (start < chunk.length) {
          const length = Math.min(
            buffer.length - buffered,
            chunk.length - start
          );
          buffer.set(chunk.subarray(start, start + length), buffered);
          buffered += length;
          start += length;
          if (buffered === buffer.length) await flush();
        }
      },
      stop.signal
    ).catch((error: unknown) => {
      throw writeError || error;
    });
    timing.receive = performance.now() - receivingAt;
    if (count !== expected) fail('INTERRUPTED', '上传块不完整，请重试', 409);
    await flush();
    const flushingAt = performance.now();
    await drainWrites();
    if (writeError) throw writeError;
    timing.flush = performance.now() - flushingAt;
    timing.write = writeMs;
    const digest = hash.digest('hex');
    if (checksum && checksum !== digest)
      fail('CHUNK_CONFLICT', '分块校验失败，请重新选择原文件', 409);
    const committingAt = performance.now();
    return await lock(id, async () => {
      timing.commit = performance.now() - committingAt;
      const session = await getSession(id, auth);
      if (
        stop.signal.aborted ||
        controller.restoring ||
        session.status !== 'uploading' ||
        controller.uploads.get(id) !== state
      )
        fail('INTERRUPTED', '上传已暂停或取消', 409);
      state.parts.set(offset, digest);
      const chunkBytes = session.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES;
      const committed = {
        ...session,
        hashes: [...session.hashes],
        updatedAt: Date.now(),
      };
      while (state.parts.has(committed.offset)) {
        committed.hashes.push(state.parts.get(committed.offset) as string);
        state.parts.delete(committed.offset);
        committed.offset += Math.min(
          chunkBytes,
          session.size - committed.offset
        );
      }
      state.session = committed;
      queueUploadCheckpoint(state);
      return uploadView(committed);
    });
  } finally {
    stop.abort();
    await drainWrites();
    try {
      const closingAt = performance.now();
      await file?.close();
      timing.close = performance.now() - closingAt;
    } finally {
      request.signal.removeEventListener('abort', abort);
      if (admitted && live) {
        live.active.delete(offset);
        controller.active--;
        finish();
      }
    }
  }
}
export async function putMediaCover(
  id: string,
  request: NextRequest,
  auth: MediaAuth,
  uploading: boolean
) {
  return lock(id, async () => {
    const item = uploading
      ? await getSession(id, auth)
      : await record(id, true);
    manageRecord(item, auth);
    if (uploading && (item as Session).status !== 'uploading')
      fail('UPLOAD_STATE', '当前不能替换上传封面', 409);
    const mime = request.headers.get('content-type')?.split(';')[0];
    if (!mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      fail('INVALID_COVER', '封面仅支持 JPG、PNG 或 WebP');
    const location = dir(uploading ? 'uploads' : 'items', id);
    await lock('quota', async () => {
      if (!uploading) {
        controller.coverReservations.set(
          id,
          (await treeSize(location)) + COVER_RESERVE
        );
      }
      try {
        // Existing covers are local metadata, independent of the target for new uploads.
        await checkWrite(MEDIA_COVER_BYTES + 2 * 1024 * 1024, uploading);
      } catch (error) {
        controller.coverReservations.delete(id);
        throw error;
      }
    });
    const input = join(location, `${randomUUID()}.image`);
    const output = join(location, `${randomUUID()}.jpg`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(input, 'wx');
      await limitedBody(request, MEDIA_COVER_BYTES, async (chunk) => {
        await file?.writeFile(chunk);
      });
      await file.close();
      const job = controller.worker
        .catch(() => undefined)
        .then(() => createMediaCover(input, output));
      controller.worker = job;
      await job.catch(() => fail('INVALID_COVER', '图片无法读取，请更换封面'));
      if ((await stat(output)).size > 2 * 1024 * 1024)
        fail('INVALID_COVER', '封面处理后过大，请更换图片');
      await rename(output, join(location, 'cover.jpg'));
      item.hasCover = true;
      item.customCover = true;
      if (uploading) {
        (item as Session).updatedAt = Date.now();
        await saveSession(item as Session);
      } else {
        (item as RecordFile).revision = randomUUID();
        await atomicJSON(join(location, 'media.json'), item);
      }
    } finally {
      await file?.close().catch(() => undefined);
      await rm(input, { force: true });
      await rm(output, { force: true });
      controller.coverReservations.delete(id);
    }
  });
}
function prepareMedia<T>(action: () => Promise<T>): Promise<T> {
  const job = controller.worker.catch(() => undefined).then(action);
  controller.worker = job;
  return job;
}
async function stageUpload(
  session: Session,
  auth: MediaAuth,
  info: Awaited<ReturnType<typeof inspectMedia>>,
  stop: AbortSignal
) {
  return lock(session.id, async () => {
    const current = await getSession(session.id, auth);
    const previous = await json<RecordFile>(
      join(dir('items', session.id), 'media.json')
    );
    if (
      current.status !== 'processing' ||
      stop.aborted ||
      controller.restoring ||
      previous?.state === 'deleting'
    )
      fail('INTERRUPTED', '任务已取消', 409);
    if (!previous) {
      const itemDir = dir('items', session.id);
      await mkdir(itemDir, { recursive: true });
      if (session.hasCover)
        await copyFile(
          join(dir('uploads', session.id), 'cover.jpg'),
          join(itemDir, 'cover.jpg')
        );
      await atomicJSON(join(itemDir, 'media.json'), {
        id: session.id,
        title: session.title,
        ...info,
        bytes: session.size,
        owner: session.owner,
        createdAt: Date.now(),
        revision: randomUUID(),
        contentRevision: session.id,
        hasCover: session.hasCover,
        customCover: session.customCover,
        state: 'ready',
        storage: session.storage,
        staged: {
          hashes: [...session.hashes],
          chunkBytes: session.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES,
        },
      } satisfies RecordFile);
    } else {
      if (session.hasCover && (!previous.hasCover || !previous.customCover))
        await copyFile(
          join(dir('uploads', session.id), 'cover.jpg'),
          join(dir('items', session.id), 'cover.jpg')
        );
      Object.assign(previous, info, {
        processing: undefined,
        processingError: undefined,
        unavailable: false,
        hasCover: previous.hasCover || session.hasCover,
        customCover: previous.customCover || session.customCover,
        revision: randomUUID(),
      });
      await atomicJSON(join(dir('items', session.id), 'media.json'), previous);
      session.hasCover = previous.hasCover;
    }
    session.playable = true;
    // Make publication visible immediately; durability work continues in this job.
    const live = controller.uploads.get(session.id);
    if (live) live.session = session;
  });
}
async function processUpload(id: string, auth: MediaAuth) {
  const session = await getSession(id, auth);
  if (session.status === 'cancelling') {
    await cleanCancelled(id, auth);
    return;
  }
  if (session.status !== 'processing') return;
  const stop = new AbortController();
  controller.remoteAborts.set(id, stop);
  const source = join(dir('uploads', id), 'video.part');
  try {
    const published = await json<RecordFile>(
      join(dir('items', id), 'media.json')
    );
    if (published?.state === 'ready' && !published.staged) {
      if (session.storage) await rm(source, { force: true });
      session.status = 'ready';
      session.error = undefined;
      session.retryable = false;
      await saveSession(session, true);
      controller.uploads.delete(id);
      return;
    }
    await lock('quota', () => checkWrite(2 * 1024 * 1024, !session.accepted));
    const info = await prepareMedia(() => {
      if (stop.signal.aborted) fail('INTERRUPTED', '任务已取消', 409);
      return inspectMedia(source, false, stop.signal);
    }).catch((error: Error) => {
      if (stop.signal.aborted) fail('INTERRUPTED', '任务已取消', 409);
      const unsupported = /^(视频容器不支持|视频编码不支持)/.test(
        error.message || ''
      );
      fail(
        unsupported ? 'UNSUPPORTED_FORMAT' : 'MEDIA_PROBE_FAILED',
        unsupported ? error.message : '无法读取视频或检查超时，可稍后重试'
      );
    });
    await stageUpload(session, auth, info, stop.signal);
    // Checkpoint synchronization and final disk flush no longer delay publication.
    await saveSession(session);
    if (controller.uploads.get(id)?.session === session)
      controller.uploads.delete(id);
    if (stop.signal.aborted) fail('INTERRUPTED', '任务已取消', 409);
    if (!session.hasCover) {
      try {
        await prepareMedia(() =>
          createMediaCover(
            source,
            join(dir('uploads', id), 'cover.jpg'),
            info.duration,
            false,
            stop.signal
          )
        );
        session.hasCover = true;
        await lock(id, async () => {
          const item = await json<RecordFile>(
            join(dir('items', id), 'media.json')
          );
          if (
            item?.state !== 'ready' ||
            item.customCover ||
            stop.signal.aborted
          )
            return;
          await copyFile(
            join(dir('uploads', id), 'cover.jpg'),
            join(dir('items', id), 'cover.jpg')
          );
          item.hasCover = true;
          item.revision = randomUUID();
          await atomicJSON(join(dir('items', id), 'media.json'), item);
        });
      } catch {
        session.hasCover = false;
      }
    }
    if (session.storage)
      await lock('media-transfer', async () => {
        if (!session.storage) return;
        if (stop.signal.aborted || controller.restoring)
          fail('INTERRUPTED', '任务已取消', 409);
        const c = await connection(session.storage.connectionId);
        const parent = session.storage.path.slice(
          0,
          session.storage.path.lastIndexOf('/')
        );
        await ensureDavDirectory(c, parent, stop.signal);
        const exists = await davStat(c, session.storage.path, stop.signal);
        if (exists && exists.size !== session.size)
          fail(
            'REMOTE_CONFLICT',
            '远端任务文件大小不符，请取消并清理该任务',
            409
          );
        if (!exists) {
          await lock(id, async () => {
            const current = await getSession(id, auth);
            if (current.status !== 'processing' || stop.signal.aborted)
              fail('INTERRUPTED', '任务已取消', 409);
            session.remoteAttempted = true;
            session.stage = '正在转存到存储服务';
            await saveSession(session);
          });
          const transfer = {
            sent: 0,
            started: Date.now(),
            sampleAt: Date.now(),
            sampleBytes: 0,
            speed: 0,
            finished: false,
            finishedAt: 0,
          };
          controller.transfers.set(id, transfer);
          await davPut(
            c,
            session.storage.path,
            source,
            session.size,
            stop.signal,
            (sent, finished) => {
              if (
                stop.signal.aborted ||
                controller.transfers.get(id) !== transfer
              )
                return;
              const now = Date.now();
              transfer.sent = Math.min(session.size, sent);
              transfer.finished = finished;
              if (finished) transfer.finishedAt = now;
              if (now - transfer.sampleAt >= 1000) {
                transfer.speed =
                  ((transfer.sent - transfer.sampleBytes) * 1000) /
                  (now - transfer.sampleAt);
                transfer.sampleAt = now;
                transfer.sampleBytes = transfer.sent;
              }
            }
          );
          // eslint-disable-next-line no-console
          console.info('[media-transfer]', {
            id,
            bytes: session.size,
            milliseconds: Date.now() - transfer.started,
            confirmationMs: transfer.finishedAt
              ? Date.now() - transfer.finishedAt
              : 0,
          });
        }
        // Use the same DAV properties as scanning/deletion, not download headers.
        const result = await remoteObject(c, session.storage.path, stop.signal);
        if (
          !result ||
          result.is_dir ||
          result.size !== session.size ||
          (!result.etag && !result.modified)
        )
          fail('REMOTE_VERIFY', '云端文件尚未确认，暂存保留，请稍后重试', 502);
        session.storage.metadataSource = 'propfind';
        session.storage.etag = result.etag;
        session.storage.modified = result.modified;
        session.storage.fingerprint = objectFingerprint(result);
        await cloudDebt(c, { id, bytes: session.size });
      });
    // 先完整构建目录，再原子发布；视频不复制，避免翻倍占用空间。
    await lock(id, async () => {
      await lock('quota', async () => {
        const latest = await getSession(id, auth);
        const previous = await json<RecordFile>(
          join(dir('items', id), 'media.json')
        );
        if (
          latest.status !== 'processing' ||
          stop.signal.aborted ||
          previous?.state !== 'ready'
        )
          fail('INTERRUPTED', '任务已取消', 409);
        await checkWrite(2 * 1024 * 1024, false);
        const itemDir = dir('items', id);
        await mkdir(itemDir, { recursive: true });
        if (!session.storage) await rename(source, join(itemDir, 'video.mp4'));
        const item: RecordFile = {
          ...previous,
          storage: session.storage,
          staged: undefined,
        };
        await atomicJSON(join(itemDir, 'media.json'), item);
        session.status = 'ready';
        session.updatedAt = Date.now();
        await saveSession(session);
        if (session.storage) await rm(source, { force: true });
      });
    });
    if (session.storage)
      void capacity(await connection(session.storage.connectionId), true).catch(
        () => undefined
      );
  } catch (error) {
    const published = await json<RecordFile>(
      join(dir('items', id), 'media.json')
    );
    if (published?.state === 'ready' && !published.staged) {
      session.status = 'failed';
      session.playable = true;
      session.retryable = true;
      session.error = '后台暂存文件清理未完成，可重试';
      await saveSession(session, true);
      controller.uploads.delete(id);
      return;
    }
    const current = await getSession(id, auth);
    if (current.status === 'cancelling') {
      await cleanCancelled(id, auth);
      return;
    }
    if (
      published?.staged &&
      !session.storage &&
      !(await stat(source).catch(() => null))
    )
      await rename(join(dir('items', id), 'video.mp4'), source).catch(
        () => undefined
      );
    if (session.playable) {
      session.status = 'failed';
      session.retryable = true;
      session.error =
        error instanceof MediaError || error instanceof RemoteMediaError
          ? error.message
          : '后台存储处理未完成，可重试';
    } else if (
      error instanceof MediaError &&
      ['DISK_LOW', 'UPLOAD_DISABLED', 'SETTINGS_RESTORE'].includes(error.code)
    ) {
      session.status = 'uploading';
      session.error = error.message;
    } else {
      session.status = 'failed';
      session.retryable = !(
        error instanceof MediaError && error.code === 'UNSUPPORTED_FORMAT'
      );
      session.error =
        error instanceof MediaError || error instanceof RemoteMediaError
          ? error.message
          : '视频处理失败，请取消后重新上传';
      if (!session.storage && !(await stat(source).catch(() => null))) {
        await rename(join(dir('items', id), 'video.mp4'), source).catch(
          () => undefined
        );
        await rename(
          join(dir('items', id), 'cover.jpg'),
          join(dir('uploads', id), 'cover.jpg')
        ).catch(() => undefined);
      }
      if (!session.retryable && !session.remoteAttempted && !session.accepted) {
        await rm(source, { force: true });
        await rm(dir('items', id), { recursive: true, force: true });
      }
    }
    session.updatedAt = Date.now();
    await lock(id, async () => {
      const latest = await getSession(id, auth);
      if (latest.status !== 'cancelling') {
        if (session.accepted && !session.playable) {
          const item = await json<RecordFile>(
            join(dir('items', id), 'media.json')
          );
          if (item?.state === 'ready') {
            item.processing = false;
            item.processingError = /^(视频容器不支持|视频编码不支持)/.test(
              session.error || ''
            )
              ? session.error
              : '视频处理失败，请稍后重试';
            item.unavailable = true;
            await atomicJSON(join(dir('items', id), 'media.json'), item);
          }
        }
        await saveSession(session);
      }
    });
  } finally {
    controller.transfers.delete(id);
    controller.remoteAborts.delete(id);
  }
}
async function cleanCancelled(id: string, auth: MediaAuth) {
  const active = controller.uploads.get(id)?.active;
  if (active)
    await Promise.all(Array.from(active.values(), (part) => part.done));
  const session = await getSession(id, auth);
  if (session.status !== 'cancelling') return;
  if (session.playable || session.accepted) {
    await lock(id, async () => {
      const item = await json<RecordFile>(join(dir('items', id), 'media.json'));
      if (item?.state === 'ready') {
        item.state = 'deleting';
        await atomicJSON(join(dir('items', id), 'media.json'), item);
      }
      invalidateMediaStreams(id);
    });
    await clearMediaProgress(id);
  }
  if (session.remoteAttempted && session.storage) {
    await davDelete(
      await connection(session.storage.connectionId),
      session.storage.path
    );
    await cloudDebt(
      await connection(session.storage.connectionId),
      undefined,
      id,
      session.size
    );
  }
  await lock(id, () =>
    lock('quota', async () => {
      const latest = await getSession(id, auth);
      if (latest.status !== 'cancelling') return;
      await rm(dir('items', id), { recursive: true, force: true });
      await rm(dir('uploads', id), { recursive: true, force: true });
      controller.uploads.delete(id);
    })
  );
}
function queueMediaProcessing(id: string, auth: MediaAuth) {
  if (controller.processing.has(id)) {
    controller.requeue.add(id);
    return;
  }
  controller.processing.add(id);
  const job = processUpload(id, auth);
  const settled = job
    .catch(() => undefined)
    .finally(async () => {
      const current = await json<Session>(
        join(dir('uploads', id), 'session.json')
      ).catch(() => null);
      try {
        if (current?.status === 'cancelling')
          await cleanCancelled(id, auth).catch(async () => {
            current.error = '取消任务的远端清理尚未完成，请重试取消';
            await saveSession(current);
          });
      } finally {
        controller.processing.delete(id);
        if (controller.processingJobs.get(id) === settled)
          controller.processingJobs.delete(id);
        const requested = controller.requeue.delete(id);
        if (
          requested &&
          current?.status === 'processing' &&
          !controller.restoring
        )
          queueMediaProcessing(id, auth);
      }
    })
    .catch(() => undefined);
  controller.processingJobs.set(id, settled);
}
export async function completeUpload(id: string, auth: MediaAuth) {
  const result = await lock(id, async () => {
    const session = await getSession(id, auth);
    if (
      session.status === 'ready' ||
      (session.status === 'processing' &&
        (session.accepted || session.playable))
    )
      return uploadView(session);
    if (
      (session.status !== 'uploading' &&
        session.status !== 'processing' &&
        !(session.status === 'failed' && session.retryable)) ||
      session.offset !== session.size
    )
      fail('UPLOAD_INCOMPLETE', '视频尚未完整上传', 409);
    if (controller.uploads.get(id)?.active.size)
      fail('CHUNK_BUSY', '正在确认最后的分块，请稍后重试', 409);
    const previous = await json<RecordFile>(
      join(dir('items', id), 'media.json')
    );
    if (previous?.state === 'deleting')
      fail('INTERRUPTED', '视频已被删除', 409);
    const file = await stat(join(dir('uploads', id), 'video.part')).catch(
      () => null
    );
    if ((!previous || previous.staged) && (!file || file.size !== session.size))
      fail(
        'UPLOAD_INCOMPLETE',
        '视频文件尚未完整接收，请重新打开上传面板',
        409
      );
    const processing: Session = {
      ...session,
      status: 'processing',
      accepted: true,
      error: undefined,
      retryable: false,
      stage: '正在检查视频',
      updatedAt: Date.now(),
    };
    if (!processing.playable) {
      const itemDir = dir('items', id);
      await mkdir(itemDir, { recursive: true });
      // This small durable record also restores a job whose final response was lost.
      await atomicJSON(join(itemDir, 'media.json'), {
        id,
        title: session.title,
        duration: 0,
        width: 0,
        height: 0,
        bytes: session.size,
        owner: session.owner,
        createdAt: Date.now(),
        revision: randomUUID(),
        contentRevision: id,
        hasCover: false,
        customCover: session.customCover,
        state: 'ready',
        storage: session.storage,
        ...previous,
        processing: true,
        processingError: undefined,
        unavailable: false,
        staged: {
          hashes: [...session.hashes],
          chunkBytes: session.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES,
        },
      } satisfies RecordFile);
    }
    const live = controller.uploads.get(id) || {
      session: processing,
      durableOffset: session.offset,
      parts: new Map<number, string>(),
      active: new Map<number, UploadWrite>(),
    };
    live.session = processing;
    controller.uploads.set(id, live);
    return uploadView(processing);
  });
  if (
    result.status === 'processing' ||
    controller.uploads.get(id)?.session.status === 'processing'
  )
    queueMediaProcessing(id, auth);
  return result;
}
export async function cancelUpload(id: string, auth: MediaAuth) {
  await lock(id, async () => {
    const session = await getSession(id, auth);
    if (session.status === 'ready')
      fail('ALREADY_PUBLISHED', '视频已发布，请从列表删除', 409);
    const cancelling: Session = {
      ...session,
      status: 'cancelling',
      updatedAt: Date.now(),
    };
    const live = controller.uploads.get(id);
    if (live) live.session = cancelling;
    for (const part of Array.from(
      controller.uploads.get(id)?.active.values() || []
    ))
      part.stop.abort();
    controller.remoteAborts.get(id)?.abort();
    await saveSession(cancelling);
  });
  // Serialize cleanup behind the active transfer, never delete its source while PUT is running.
  queueMediaProcessing(id, auth);
}
export async function editMedia(id: string, value: unknown, auth: MediaAuth) {
  return lock(id, async () => {
    const item = await record(id, true);
    manageRecord(item, auth);
    item.title = title(value);
    item.customTitle = true;
    item.revision = randomUUID();
    await atomicJSON(join(dir('items', id), 'media.json'), item);
    return view(item, auth);
  });
}
function sourceLocation(item: RecordFile) {
  return item.storage
    ? { scope: item.storage.connectionId, path: item.storage.path }
    : {
        scope: 'local',
        path: item.localFile?.path || '/items/' + item.id + '/video.mp4',
      };
}
function sourceLock(scope: string, path: string) {
  return (
    'media-source:' +
    scope +
    ':' +
    createHash('sha256').update(path).digest('hex')
  );
}
function blockOldScan(scope: string, path: string) {
  const job = scanner.jobs.get(scope);
  if (!job) return;
  if (!job.deletedPaths) job.deletedPaths = new Set();
  job.deletedPaths.add(path);
  if (job.deletedPaths.size > 20000) job.stop.abort();
}
function scanBlocked(scope: string, path: string) {
  return scanner.jobs.get(scope)?.deletedPaths?.has(path) || false;
}
interface IgnoredSource {
  id: string;
  scope: string;
  path: string;
  title?: string;
  reason?: string;
}
function ignoredSourceFile(scope: string, path: string) {
  return join(
    controller.root,
    'ignored-source-' +
      createHash('sha256')
        .update(JSON.stringify([scope, path]))
        .digest('hex') +
      '.json'
  );
}
async function rememberIgnoredSource(item: RecordFile, reason: string) {
  const location = sourceLocation(item);
  await atomicJSON(ignoredSourceFile(location.scope, location.path), {
    ...location,
    id: item.id,
    title: item.title,
    reason,
  });
}
// A removed path must not reappear when an untouched source is retained.
async function ignoredSource(scope: string, path: string) {
  return !!(await json<IgnoredSource>(ignoredSourceFile(scope, path)));
}
async function ignoredSources() {
  const names = (await readdir(controller.root)).filter((name) =>
    /^ignored-source-[a-f0-9]{64}\.json$/.test(name)
  );
  const markers = await Promise.all(
    names.map((name) => json<IgnoredSource>(join(controller.root, name)))
  );
  return markers.filter((marker): marker is IgnoredSource => !!marker);
}
async function ignoredSourceIds() {
  return new Set((await ignoredSources()).map((marker) => marker.id));
}
async function assertInternalSourceGone(item: RecordFile) {
  if (!item.cleanupOnly || item.retainSource || item.storage || item.localFile)
    return;
  let found = false;
  try {
    await lstat(join(dir('items', item.id), 'video.mp4'));
    found = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (found) {
    item.cleanupOnly = undefined;
    await atomicJSON(join(dir('items', item.id), 'media.json'), item);
    fail(
      'SOURCE_REAPPEARED',
      '本地源文件重新出现，已停止清理；请核对后再决定是否删除',
      409
    );
  }
}
async function purgeMediaRecord(item: RecordFile, progressCleared = false) {
  invalidateMediaStreams(item.id);
  await assertInternalSourceGone(item);
  if (!progressCleared) await clearMediaProgress(item.id);
  await lock('quota', async () => {
    await assertInternalSourceGone(item);
    await rm(dir('uploads', item.id), { recursive: true, force: true });
    for (const name of await readdir(dir('items', item.id))) {
      if (
        name === 'media.json' ||
        (name === 'video.mp4' &&
          item.retainSource &&
          !item.storage &&
          !item.localFile)
      )
        continue;
      if (
        name === 'video.mp4' &&
        item.cleanupOnly &&
        !item.storage &&
        !item.localFile
      )
        await assertInternalSourceGone(item);
      else
        await rm(join(dir('items', item.id), name), {
          recursive: true,
          force: true,
        });
    }
    await rm(join(dir('items', item.id), 'media.json'), { force: true });
    try {
      await rmdir(dir('items', item.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (
        item.retainSource &&
        !item.storage &&
        !item.localFile &&
        (error as NodeJS.ErrnoException).code === 'ENOTEMPTY'
      )
        return;
      // A concurrent external writer must never be swept up by recursive removal.
      await atomicJSON(join(dir('items', item.id), 'media.json'), item);
      await assertInternalSourceGone(item);
      throw error;
    }
  });
  if (item.storage && !item.retainSource) {
    await lock('capacity:' + item.storage.connectionId, async () => {
      const file = join(
          controller.root,
          'capacity-' + item.storage?.connectionId + '.json'
        ),
        ledger = await json<CapacityLedger>(file);
      if (!ledger) return;
      ledger.ids = ledger.ids?.filter((id) => id !== item.id);
      ledger.deletedIds = ledger.deletedIds?.filter((id) => id !== item.id);
      if (ledger.entries) delete ledger.entries[item.id];
      await atomicJSON(file, ledger);
    }).catch(() => undefined); // Periodic bookkeeping also prunes entries for removed items.
  }
}
export async function deleteMedia(id: string, auth: MediaAuth) {
  await initialize();
  const initial = await json<RecordFile>(join(dir('items', id), 'media.json'));
  if (!initial) return;
  manageRecord(initial, auth);
  if (initial.state === 'deleting') {
    queueMediaDeletion(id, !!initial.storage);
    return;
  }
  await lock(id, async () => {
    const item = await json<RecordFile>(join(dir('items', id), 'media.json'));
    if (!item) return;
    manageRecord(item, auth);
    if (item.state !== 'deleting') {
      item.state = 'deleting';
      await atomicJSON(join(dir('items', id), 'media.json'), item);
    }
    invalidateMediaStreams(id);
    controller.remoteAborts.get(id)?.abort();
    const location = sourceLocation(item);
    blockOldScan(location.scope, location.path);
  });
  queueMediaDeletion(id, !!initial.storage);
}
function queueMediaDeletion(id: string, remote: boolean) {
  if (controller.restoring || controller.deletionJobs.has(id)) return;
  controller.deletionJobs.add(id);
  const queue = remote ? 'deletionWorker' : 'localDeletionWorker';
  controller[queue] = controller[queue]
    .catch(() => undefined)
    .then(() => finishMediaDeletion(id))
    .catch(async (error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[media-delete]', {
        id,
        code:
          error instanceof MediaError ||
          error instanceof RemoteMediaError ||
          error instanceof LocalMediaError
            ? error.code
            : 'CLEANUP_PENDING',
      });
      await lock(id, async () => {
        const item = await json<RecordFile>(
          join(dir('items', id), 'media.json')
        );
        if (!item || item.state !== 'deleting') return;
        item.cleanupError =
          error instanceof MediaError ||
          error instanceof RemoteMediaError ||
          error instanceof LocalMediaError
            ? error.message
            : '文件清理暂未完成，将继续重试';
        await atomicJSON(join(dir('items', id), 'media.json'), item);
      }).catch(() => undefined);
    })
    .finally(() => controller.deletionJobs.delete(id));
}
async function verifyUploadedSource(
  item: RecordFile,
  c: MediaConnection
): Promise<'verified' | 'different' | 'unavailable'> {
  const original = await json<Session>(
    join(dir('uploads', item.id), 'session.json')
  );
  const chunkBytes = original?.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES;
  if (
    !original ||
    !original.storage ||
    !item.storage ||
    original.status !== 'ready' ||
    original.owner !== item.owner ||
    original.size !== item.bytes ||
    original.offset !== item.bytes ||
    original.storage?.connectionId !== item.storage?.connectionId ||
    original.storage?.path !== item.storage?.path ||
    ![MEDIA_CHUNK_BYTES, MEDIA_LEGACY_CHUNK_BYTES].includes(chunkBytes) ||
    !Array.isArray(original.hashes) ||
    original.hashes.length !== Math.ceil(item.bytes / chunkBytes) ||
    original.hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
  )
    return 'unavailable';
  if (controller.restoring)
    fail('SETTINGS_RESTORE', '后台清理已暂停，稍后重试', 409);
  const stop = new AbortController();
  controller.deletionAborts.set(item.id, stop);
  const timer = setTimeout(() => stop.abort(), 30 * 60 * 1000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await remoteStream(
      c,
      original.storage.path,
      item.bytes,
      null,
      stop.signal
    );
    reader = response.body?.getReader();
    if (!reader)
      throw new RemoteMediaError('REMOTE_EMPTY', '未收到校验内容，请稍后重试');
    let received = 0,
      partBytes = 0,
      index = 0;
    let hash = createHash('sha256');
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (stop.signal.aborted)
        throw new RemoteMediaError('INTERRUPTED', '后台校验已暂停，稍后重试');
      let offset = 0;
      while (offset < part.value.length) {
        const count = Math.min(
          part.value.length - offset,
          chunkBytes - partBytes,
          item.bytes - received
        );
        if (count <= 0) return 'different';
        hash.update(part.value.subarray(offset, offset + count));
        offset += count;
        received += count;
        partBytes += count;
        if (partBytes === chunkBytes || received === item.bytes) {
          if (hash.digest('hex') !== original.hashes[index++])
            return 'different';
          partBytes = 0;
          hash = createHash('sha256');
        }
      }
    }
    if (received !== item.bytes)
      throw new RemoteMediaError(
        'REMOTE_INTERRUPTED',
        '视频校验未读取完整，将继续重试'
      );
    return index === original.hashes.length ? 'verified' : 'different';
  } finally {
    clearTimeout(timer);
    stop.abort();
    await reader?.cancel().catch(() => undefined);
    if (controller.deletionAborts.get(item.id) === stop)
      controller.deletionAborts.delete(item.id);
  }
}
async function finishMediaDeletion(id: string) {
  await initialize();
  const initial = await json<RecordFile>(join(dir('items', id), 'media.json'));
  if (!initial || initial.state !== 'deleting' || controller.restoring) return;
  if (initial.staged) {
    await clearMediaProgress(id);
    const auth = { username: initial.owner, isAdmin: true };
    const task = await getSession(id, auth).catch((error: unknown) => {
      if (error instanceof MediaError && error.code === 'NOT_FOUND')
        return null;
      throw error;
    });
    if (task && task.status !== 'ready') {
      await cancelUpload(id, auth);
      await controller.processingJobs.get(id);
      const remaining = await json<Session>(
        join(dir('uploads', id), 'session.json')
      );
      if (remaining?.status === 'cancelling') await cleanCancelled(id, auth);
      return;
    }
  }
  const location = sourceLocation(initial);
  await lock(sourceLock(location.scope, location.path), () =>
    lock(id, async () => {
      const item = await json<RecordFile>(join(dir('items', id), 'media.json'));
      if (!item || item.state !== 'deleting') return;
      await clearMediaProgress(id);
      try {
        if (!item.cleanupOnly) {
          if (item.localFile)
            await deleteLocalMedia(controller.root, item.localFile);
          else if (item.storage) {
            const c = await connection(item.storage.connectionId);
            const ref = item.storage;
            const current = await remoteObject(c, ref.path);
            const matches = (value: {
              size: number;
              etag: string;
              modified: string;
            }) =>
              value.size === item.bytes &&
              (!ref.etag || value.etag === ref.etag) &&
              (ref.nativeId || !ref.fingerprint
                ? !!(ref.etag || ref.modified) &&
                  (!ref.modified ||
                    objectFingerprint({ ...value, etag: '' }) ===
                      objectFingerprint({
                        size: item.bytes,
                        etag: '',
                        modified: ref.modified,
                      }))
                : objectFingerprint(value) === ref.fingerprint);
            const changed = (message?: string) =>
              fail(
                'REMOTE_CHANGED',
                message ||
                  (item.imported
                    ? '源文件已变化或旧条目尚未更新，请先重新扫描；未删除网盘文件'
                    : '网盘文件与上传记录不一致，已停止删除；未删除网盘文件'),
                409
              );
            if (current) {
              if (
                current.is_dir ||
                current.size !== item.bytes ||
                (!current.etag && !current.modified)
              )
                changed();
              if (!matches(current)) {
                // Older uploads saved HEAD validators, which may differ from DAV
                // properties. Verify against HEAD first; never adopt an unverified
                // current object merely because its path and size match.
                if (
                  item.imported ||
                  ref.nativeId ||
                  !isManagedPath(c, ref.path)
                )
                  changed();
                let verified = false;
                if (
                  !ref.metadataSource &&
                  ref.fingerprint &&
                  (ref.etag || ref.modified)
                ) {
                  const legacy = await davStat(c, ref.path);
                  verified = !!legacy && matches(legacy);
                }
                if (!verified) {
                  const content = await verifyUploadedSource(item, c);
                  if (content === 'unavailable')
                    changed('缺少完整上传校验记录，源文件已保留');
                  if (content === 'different')
                    changed('视频内容与原上传不一致，源文件已保留');
                }
                const confirmed = await remoteObject(c, ref.path);
                if (
                  !confirmed ||
                  confirmed.is_dir ||
                  (!confirmed.etag && !confirmed.modified) ||
                  objectFingerprint(confirmed) !== objectFingerprint(current)
                )
                  changed('校验期间源文件标记变化，源文件已保留');
                ref.metadataSource = 'propfind';
                ref.etag = current.etag;
                ref.modified = current.modified;
                ref.fingerprint = objectFingerprint(current);
                await atomicJSON(join(dir('items', id), 'media.json'), item);
              }
              await davDelete(c, ref.path, undefined, current.etag);
            }
          } else await rm(join(dir('items', id), 'video.mp4'), { force: true });
          // Source deletion and index cleanup are separate durable phases.
          item.cleanupOnly = true;
          await atomicJSON(join(dir('items', id), 'media.json'), item);
        }
        if (item.storage && !item.retainSource) {
          const c = await connection(item.storage.connectionId);
          await cloudDebt(c, undefined, id, item.bytes);
          controller.capacities.delete(c.id);
        }
        await purgeMediaRecord(item, true);
      } catch (error) {
        if (
          error instanceof LocalMediaError ||
          ((error instanceof MediaError || error instanceof RemoteMediaError) &&
            [
              'REMOTE_CHANGED',
              'REMOTE_PATH',
              'SOURCE_REAPPEARED',
              'MISSING_CONNECTION',
            ].includes(error.code))
        ) {
          // Keep an unverified source intact, but never restore the deleted entry.
          item.retainSource = true;
          item.cleanupOnly = true;
          await rememberIgnoredSource(item, error.message);
          await atomicJSON(join(dir('items', id), 'media.json'), item);
          await purgeMediaRecord(item, true);
          return;
        }
        if (
          error instanceof MediaError ||
          error instanceof RemoteMediaError ||
          error instanceof LocalMediaError
        )
          throw error;
        fail('DELETE_FAILED', '视频已停止展示，但清理未完成；可重试清理', 500);
      }
    })
  );
}

async function removeMissingMedia(
  item: RecordFile,
  status: MediaScanStatus,
  stop: AbortController,
  confirmMissing: () => Promise<boolean>
) {
  const location = sourceLocation(item);
  return lock(sourceLock(location.scope, location.path), () =>
    lock(item.id, async () => {
      const current = await json<RecordFile>(
        join(dir('items', item.id), 'media.json')
      );
      if (!current || current.state !== 'ready' || stop.signal.aborted) return;
      if (!current.cleanupOnly && !(await confirmMissing())) return;
      if (stop.signal.aborted) return;
      current.state = 'deleting';
      current.cleanupOnly = true;
      await atomicJSON(join(dir('items', item.id), 'media.json'), current);
      invalidateMediaStreams(item.id);
      blockOldScan(location.scope, location.path);
      if (current.storage) {
        const c = await connection(current.storage.connectionId);
        await cloudDebt(c, undefined, current.id, current.bytes);
        controller.capacities.delete(c.id);
      }
      await purgeMediaRecord(current);
      status.removed = (status.removed || 0) + 1;
    })
  );
}
function inScanScope(path: string, root: string, recursive: boolean) {
  const prefix = root.replace(/\/$/, '') + '/';
  return (
    path.startsWith(prefix) &&
    (recursive || !path.slice(prefix.length).includes('/'))
  );
}
async function confirmRemoteMissing(
  c: MediaConnection,
  path: string,
  signal: AbortSignal
) {
  if (await remoteObject(c, path, signal)) return false;
  let parent = path.slice(0, path.lastIndexOf('/')) || '/';
  while (
    parent === c.scan.root ||
    parent.startsWith(c.scan.root.replace(/\/$/, '') + '/')
  ) {
    const directory = await remoteObject(c, parent, signal);
    if (directory) {
      if (!directory.is_dir) return false;
      const entries = await listDavDirectory(c, parent, signal);
      const child = path
        .slice(parent === '/' ? 1 : parent.length + 1)
        .split('/')[0];
      return !entries.some((entry) => entry.name === child);
    }
    if (parent === c.scan.root) return false;
    parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
  }
  return false;
}

export async function retryMediaDeletes(auth: MediaAuth) {
  requireMediaAdmin(auth);
  await initialize();
  for (const item of await records())
    if (item.state === 'deleting') await deleteMedia(item.id, auth);
}
export async function saveMediaProgress(
  id: string,
  username: string,
  value: PlayRecord
) {
  return lock(id, async () => {
    const item = await record(id);
    if (item.contentRevision && value?.media_revision !== item.contentRevision)
      fail('MEDIA_CHANGED', '视频内容已更新，请重新进入播放页', 409);
    if (!value || !Number.isFinite(value.play_time) || value.play_time < 0)
      fail('INVALID_PROGRESS', '播放进度无效');
    if (value.media_session !== undefined || value.media_seq !== undefined) {
      if (
        !/^[0-9a-f]{32}$/.test(value.media_session || '') ||
        !Number.isSafeInteger(value.media_seq) ||
        (value.media_seq || 0) < 1
      )
        fail('INVALID_PROGRESS', '播放会话无效');
      const previous = await db.getPlayRecord(username, MEDIA_SOURCE, id);
      if (
        previous &&
        previous.media_session === value.media_session &&
        (previous.media_seq || 0) >= (value.media_seq || 0)
      )
        return previous;
    }
    const progress: PlayRecord = {
      origin: 'upload',
      media_revision: item.contentRevision,
      ...(value.media_session
        ? { media_session: value.media_session, media_seq: value.media_seq }
        : {}),
      title: item.title,
      source_name: '共享视频',
      cover: item.hasCover ? `/api/media/${id}/cover?v=${item.revision}` : '',
      year: '',
      index: 1,
      total_episodes: 1,
      play_time: Math.min(value.play_time, item.duration),
      total_time: item.duration,
      save_time: Date.now(),
      search_title: item.title,
    };
    await db.savePlayRecord(username, MEDIA_SOURCE, id, progress);
    return progress;
  });
}
export async function serveMedia(
  id: string,
  request: NextRequest,
  cover: boolean
): Promise<Response> {
  const started = performance.now();
  const lease = createMediaStreamLease(validId(id), request.signal);
  const respond = (response: Response, storage: 'local' | 'webdav' = 'local') =>
    measuredMediaResponse(response, lease, id, storage, started);
  try {
    const item = await record(id, cover);
    if (!cover && item.storage && !item.staged)
      return respond(
        await cachedRemoteStream(
          id,
          item.contentRevision || item.revision,
          await connection(item.storage.connectionId),
          item.storage.path,
          item.bytes,
          request.headers.get('range'),
          lease.signal,
          request.method === 'HEAD'
        ),
        'webdav'
      );
    const path =
      item.staged && !cover
        ? join(dir('uploads', id), 'video.part')
        : join(dir('items', id), cover ? 'cover.jpg' : 'video.mp4');
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle =
        !cover && item.localFile
          ? await openLocalMedia(controller.root, item.localFile)
          : await open(path, 'r');
    } catch (e) {
      if (
        !cover &&
        item.staged &&
        (e as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        const latest = await record(id, cover);
        if (!latest.staged) {
          lease.release();
          return serveMedia(id, request, cover);
        }
        if (!item.storage) {
          handle = await open(join(dir('items', id), 'video.mp4'), 'r');
        } else fail('NOT_FOUND', '视频文件不存在', 404);
      } else {
        if (e instanceof LocalMediaError) throw e;
        fail('NOT_FOUND', cover ? '封面不存在' : '视频文件不存在', 404);
      }
    }
    const size = (
      await handle.stat().catch(async (error) => {
        await handle.close();
        throw error;
      })
    ).size;
    if (!size) {
      await handle.close();
      fail('NOT_FOUND', '视频或封面文件为空', 404);
    }
    let start = 0;
    let end = size - 1;
    let status = 200;
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'Content-Type': cover ? 'image/jpeg' : 'video/mp4',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    const range =
      request.method === 'HEAD' ? null : request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1]
          ? Number(match[1])
          : Math.max(0, size - Number(match[2]));
        end =
          match[1] && match[2]
            ? Math.min(size - 1, Number(match[2]))
            : size - 1;
      } else start = -1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= size ||
        (match && !match[1] && Number(match[2]) === 0)
      ) {
        await handle.close();
        headers.set('Content-Range', `bytes */${size}`);
        return respond(new Response(null, { status: 416, headers }));
      }
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(end - start + 1));
    if (request.method === 'HEAD') {
      await handle.close();
      return respond(new Response(null, { headers }));
    }
    const stream = handle.createReadStream({
      start,
      end,
      autoClose: true,
      highWaterMark: 256 * 1024,
    });
    const abort = () => stream.destroy();
    lease.signal.addEventListener('abort', abort, { once: true });
    if (lease.signal.aborted) stream.destroy();
    stream.once('close', () =>
      lease.signal.removeEventListener('abort', abort)
    );
    return respond(
      new Response(
        Readable.toWeb(stream, {
          strategy: {
            highWaterMark: 512 * 1024,
            size: (chunk: Uint8Array) => chunk.byteLength,
          },
        }) as ReadableStream<Uint8Array>,
        {
          status,
          headers,
        }
      )
    );
  } catch (error) {
    lease.release();
    if (error instanceof RemoteMediaError && error.status === 404)
      invalidateMediaStreams(id);
    throw error;
  }
}
export async function cleanupMedia() {
  await initialize();
  for (const session of await sessions()) {
    if (
      Date.now() - session.updatedAt < DAY ||
      controller.processing.has(session.id) ||
      controller.locks.has(session.id) ||
      controller.uploads.get(session.id)?.active.size ||
      controller.uploads.get(session.id)?.checkpoint ||
      session.remoteAttempted ||
      session.status === 'cancelling' ||
      session.retryable
    )
      continue;
    await lock(session.id, async () => {
      const current =
        controller.uploads.get(session.id)?.session ||
        (await json<Session>(join(dir('uploads', session.id), 'session.json')));
      if (
        current &&
        Date.now() - current.updatedAt >= DAY &&
        !controller.uploads.get(session.id)?.active.size &&
        !controller.uploads.get(session.id)?.checkpoint
      ) {
        await lock('quota', () =>
          rm(dir('uploads', session.id), { recursive: true, force: true })
        );
        controller.uploads.delete(session.id);
      }
    });
  }
  await cleanupMediaArtifacts();
  for (const item of await records())
    if (item.state === 'deleting') queueMediaDeletion(item.id, !!item.storage);
}
async function cleanupMediaArtifacts() {
  const retained = await ignoredSourceIds();
  // Only generated artifacts inside the media directory are eligible, never scanned originals.
  for (const entry of await readdir(controller.root, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^(?:scan-cover-[0-9a-f-]{36}\.jpg|deleted-[a-zA-Z0-9_-]+\.json|(?:scan-(?:cache-)?|capacity-)[a-zA-Z0-9_-]+\.json\.[0-9a-f-]{36}\.tmp)$/.test(
        entry.name
      )
    )
      continue;
    const path = join(controller.root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs >= DAY)
      await rm(path, { force: true });
  }
  for (const id of await ids('items')) {
    if (controller.locks.has(id) || controller.processing.has(id)) continue;
    await lock(id, async () => {
      const folder = dir('items', id),
        info = await stat(folder).catch(() => null);
      const item = await json<RecordFile>(join(folder, 'media.json'));
      if (!info || Date.now() - info.mtimeMs < DAY) return;
      if (
        !item &&
        !retained.has(id) &&
        !(await json(join(dir('uploads', id), 'session.json')))
      ) {
        await lock('quota', () => rm(folder, { recursive: true, force: true }));
        return;
      }
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (
          !entry.isFile() ||
          !/^[a-zA-Z0-9.-]+\.(?:tmp|image|jpg)$/.test(entry.name) ||
          entry.name === 'cover.jpg'
        )
          continue;
        const path = join(folder, entry.name),
          file = await stat(path).catch(() => null);
        if (file && Date.now() - file.mtimeMs >= DAY)
          await rm(path, { force: true });
      }
    });
  }
  await lock('quota', async () => {
    const active = new Set([
      ...(await records()).map((item) => item.id),
      ...(await sessions()).map((task) => task.id),
      ...Array.from(retained),
    ]);
    for (const c of (await getMediaSettings()).connections || []) {
      await lock('capacity:' + c.id, async () => {
        const file = join(controller.root, 'capacity-' + c.id + '.json'),
          ledger = await json<CapacityLedger>(file);
        if (!ledger) return;
        let changed = false;
        for (const [id, bytes] of Object.entries(ledger.entries || {})) {
          if (!active.has(id)) {
            ledger.debt = Math.max(0, ledger.debt - bytes);
            delete ledger.entries?.[id];
            changed = true;
          }
        }
        const ids = ledger.ids?.filter((id) => active.has(id)),
          deletedIds = ledger.deletedIds?.filter((id) => active.has(id));
        if (
          changed ||
          ids?.length !== ledger.ids?.length ||
          deletedIds?.length !== ledger.deletedIds?.length
        )
          await atomicJSON(file, { ...ledger, ids, deletedIds });
      });
    }
  });
}

const scanSymbol = Symbol.for('lunatv.media.scan.runtime');
interface ScanRuntime {
  jobs: Map<
    string,
    {
      stop: AbortController;
      status: MediaScanStatus;
      deletedPaths?: Set<string>;
    }
  >;
  timer?: ReturnType<typeof setInterval>;
  starting?: Promise<void>;
  tick?: Promise<void>;
  probe: Promise<unknown>;
}
const scanGlobal = globalThis as typeof globalThis & {
  [scanSymbol]?: ScanRuntime;
};
const scanner: ScanRuntime =
  scanGlobal[scanSymbol] ||
  (scanGlobal[scanSymbol] = { jobs: new Map(), probe: Promise.resolve() });
function scanFile(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
    fail('INVALID_CONNECTION', '存储连接标识无效');
  return join(controller.root, `scan-${id}.json`);
}
async function scanStatuses() {
  const result: MediaScanStatus[] = [];
  const local =
    scanner.jobs.get('local')?.status ||
    (await json<MediaScanStatus>(scanFile('local')));
  if (local) result.push(local);
  for (const c of (await getMediaSettings()).connections || []) {
    const status =
      scanner.jobs.get(c.id)?.status ||
      (await json<MediaScanStatus>(scanFile(c.id)));
    if (status) result.push(status);
  }
  return result;
}
export async function mediaAdminPolicy(
  refresh = false
): Promise<MediaAdminPolicy> {
  const settings = await getMediaSettings();
  const c = settings.connections?.find(
    (x) => x.id === settings.activeConnectionId
  );
  if (refresh && c) {
    controller.capacities.delete(c.id);
    void capacity(c, true).catch(() => undefined);
    await inspectRemoteService(
      { ...c, scan: { ...c.scan, root: c.root } },
      true
    );
  }
  const basic = await mediaPolicy();
  const catalog = basic.enabled ? await records() : [];
  const tasks = basic.enabled ? await sessions() : [];
  const localUsedBytes = basic.enabled ? await treeSize(controller.root) : 0;
  const localReservedBytes = basic.enabled ? await pendingUploadBytes() : 0;
  const connections = (settings.connections || []).map((c) => ({
    id: c.id,
    url: c.url,
    root: c.root,
    username: c.username,
    scan: c.scan,
    hasPassword: !!c.password,
    references:
      catalog.filter((x) => x.storage?.connectionId === c.id).length +
      tasks.filter(
        (x) => x.storage?.connectionId === c.id && x.status !== 'ready'
      ).length,
  }));
  const missing = new Map<string, number>();
  for (const x of [...catalog, ...tasks])
    if (x.storage && !connections.some((c) => c.id === x.storage?.connectionId))
      missing.set(
        x.storage.connectionId,
        (missing.get(x.storage.connectionId) || 0) + 1
      );
  return {
    ...basic,
    settings: { ...settings, connections },
    localUsedBytes,
    localReservedBytes,
    capacity:
      c && basic.enabled
        ? await displayedCapacity(c).catch(() => ({
            total: null,
            used: null,
            free: null,
            checkedAt: Date.now(),
            error: '网盘容量暂时无法查询',
          }))
        : undefined,
    localDirectory: controller.root,
    remoteService:
      c && basic.enabled ? await inspectRemoteService(c) : undefined,
    pendingDeletes: catalog
      .filter((x) => x.state === 'deleting')
      .map((x) => ({
        id: x.id,
        title: x.title,
        path: x.storage?.path || x.localFile?.path,
        location: x.storage ? ('webdav' as const) : ('local' as const),
        error: x.cleanupError,
        running: controller.deletionJobs.has(x.id),
      })),
    pendingProcessing: tasks
      .filter(
        (task) =>
          (task.playable || task.accepted) &&
          task.status !== 'ready' &&
          task.status !== 'cancelling'
      )
      .map((task) => ({
        id: task.id,
        title: task.title,
        location: task.storage ? ('webdav' as const) : ('local' as const),
        error: task.error,
        running: controller.processing.has(task.id),
        retryable: task.retryable !== false || task.status === 'uploading',
        sentBytes: controller.transfers.get(task.id)?.sent,
        totalBytes: task.size,
      })),
    retainedSources: (basic.enabled ? await ignoredSources() : []).map(
      (item) => ({
        id: item.id,
        title: item.title || '已移除的视频',
        path: item.path,
        location:
          item.scope === 'local' ? ('local' as const) : ('webdav' as const),
        reason: item.reason || '删除时未能确认源文件，已保留源文件',
      })
    ),
    scans: basic.enabled ? await scanStatuses() : [],
    missingConnections: Array.from(missing, ([id, references]) => ({
      id,
      references,
    })),
  };
}
export async function checkMediaConnection(
  id: string,
  draft?: unknown,
  signal?: AbortSignal
) {
  await initialize();
  let c: MediaConnection;
  if (draft !== undefined) {
    const settings = await getMediaSettings();
    if (
      !draft ||
      typeof draft !== 'object' ||
      (draft as MediaConnection).id !== id
    )
      fail('INVALID_SETTINGS', '连接配置无效');
    try {
      const parsed = parseMediaSettings({
        ...settings,
        uploadStorage: 'local',
        connections: [
          mergeConnectionCredentials(
            draft as MediaConnection,
            settings.connections?.find((x) => x.id === id)
          ),
        ],
      });
      const candidate = parsed.connections?.[0];
      if (!candidate) fail('INVALID_SETTINGS', '连接配置无效');
      c = candidate;
    } catch (error) {
      fail('INVALID_SETTINGS', (error as Error).message);
    }
  } else c = await connection(id);
  const result = await checkConnection(c, signal);
  if (draft === undefined) controller.capacities.set(id, result.capacity);
  return result;
}
async function clearMediaProgress(id: string) {
  invalidateMediaStreams(id);
  const users = new Set(
    [...(await db.getAllUsers()), process.env.USERNAME].filter(
      (x): x is string => !!x
    )
  );
  for (const user of Array.from(users))
    await db.deletePlayRecord(user, MEDIA_SOURCE, id);
}
function scanDetail(status: MediaScanStatus, path: string, reason: string) {
  if (status.details.length < 200) status.details.push({ path, reason });
}
function isManagedPath(c: MediaConnection, path: string) {
  return (
    path === c.root.replace(/\/$/, '') + '/.lunatv-media' ||
    path.startsWith(c.root.replace(/\/$/, '') + '/.lunatv-media/')
  );
}
async function runScan(
  c: MediaConnection,
  status: MediaScanStatus,
  stop: AbortController
) {
  const persist = () =>
    lock('scan-state:' + c.id, () => atomicJSON(scanFile(c.id), status));
  const root = remotePath(c, c.scan.root),
    queue = [{ path: root, depth: 0 }];
  const seen = new Set<string>(),
    visited = new Set<string>();
  const originals = (await records()).filter(
    (item) => item.storage?.connectionId === c.id
  );
  const byPath = new Map(
    originals.map((item) => [item.storage?.path || '', item])
  );
  const cacheFile = join(controller.root, 'scan-cache-' + c.id + '.json');
  const unsupported =
    (await json<Record<string, string>>(cacheFile).catch(() => null)) || {};
  const nextCache: Record<string, string> = {};
  let complete = true;
  try {
    while (queue.length && !stop.signal.aborted) {
      if (
        Date.now() - status.startedAt > 4 * 3600000 ||
        status.visited >= 20000
      ) {
        complete = false;
        scanDetail(status, root, '达到本轮扫描限制');
        break;
      }
      const directory = queue.shift();
      if (!directory || visited.has(directory.path)) continue;
      visited.add(directory.path);
      const entries = await listDavDirectory(c, directory.path, stop.signal);
      if (entries.length + status.visited > 20000) {
        complete = false;
        scanDetail(status, directory.path, '目录条目超过本轮 20000 条限制');
        break;
      }
      for (const source of entries) {
        if (stop.signal.aborted) break;
        if (Date.now() - status.startedAt > 4 * 3600000) {
          complete = false;
          break;
        }
        const path = source.path;
        status.visited++;
        if (isManagedPath(c, path)) continue;
        if (source.is_dir) {
          if (c.scan.recursive) {
            if (directory.depth >= 20) {
              complete = false;
              scanDetail(status, path, '达到目录深度限制');
            } else queue.push({ path, depth: directory.depth + 1 });
          }
          continue;
        }
        seen.add(path);
        const existing = byPath.get(path),
          fingerprint = objectFingerprint(source);
        if (
          existing?.state === 'deleting' ||
          scanBlocked(c.id, path) ||
          (await lock(sourceLock(c.id, path), () => ignoredSource(c.id, path)))
        ) {
          status.skipped++;
          continue;
        }
        if (existing && existing.storage?.fingerprint !== fingerprint) {
          await lock(sourceLock(c.id, path), () =>
            lock(existing.id, async () => {
              const item = await json<RecordFile>(
                join(dir('items', existing.id), 'media.json')
              );
              if (item?.state === 'ready') {
                item.unavailable = true;
                invalidateMediaStreams(item.id);
                await atomicJSON(
                  join(dir('items', item.id), 'media.json'),
                  item
                );
              }
            })
          );
        }
        if (
          !/\.mp4$/i.test(source.name) ||
          source.size <= 0 ||
          (!source.etag && !source.modified)
        ) {
          status.skipped++;
          scanDetail(status, path, '跳过非 MP4、空文件或缺少变更标记的文件');
          continue;
        }
        if (
          existing &&
          existing.storage?.fingerprint === fingerprint &&
          !existing.unavailable
        ) {
          status.skipped++;
          continue;
        }
        if (unsupported[path] === SCAN_FORMAT_VERSION + fingerprint) {
          nextCache[path] = SCAN_FORMAT_VERSION + fingerprint;
          status.skipped++;
          scanDetail(status, path, '格式不支持，内容未变更');
          continue;
        }
        let temporary = '';
        try {
          await lock('quota', () => checkScanSpace());
          temporary = join(
            controller.root,
            'scan-cover-' + randomUUID() + '.jpg'
          );
          const probe = scanner.probe
            .catch(() => undefined)
            .then(() =>
              probeRemote(c, path, source.size, temporary, stop.signal)
            );
          scanner.probe = probe;
          const info = await probe;
          await lock(sourceLock(c.id, path), async () => {
            if (
              stop.signal.aborted ||
              scanBlocked(c.id, path) ||
              (await ignoredSource(c.id, path))
            )
              return;
            const after = await remoteObject(c, path, stop.signal);
            if (
              !after ||
              after.is_dir ||
              objectFingerprint(after) !== fingerprint
            )
              throw new RemoteMediaError(
                'SCAN_CHANGED',
                '处理期间文件变化，下轮重试'
              );
            const id = existing?.id || randomUUID();
            await lock(id, async () => {
              const previous = await json<RecordFile>(
                join(dir('items', id), 'media.json')
              );
              if (
                (existing && !previous) ||
                previous?.state === 'deleting' ||
                stop.signal.aborted ||
                scanBlocked(c.id, path)
              )
                return;
              if (previous && previous.storage?.fingerprint !== fingerprint)
                await clearMediaProgress(id);
              await lock('quota', async () => {
                await checkScanSpace();
                await mkdir(dir('items', id), { recursive: true });
                const item: RecordFile = {
                  id,
                  owner: '',
                  imported: true,
                  state: 'ready',
                  title: previous?.customTitle
                    ? previous.title
                    : source.name.replace(/\.mp4$/i, '').slice(0, 100) ||
                      '未命名视频',
                  duration: info.duration,
                  width: info.width,
                  height: info.height,
                  bytes: after.size,
                  createdAt: previous?.createdAt || Date.now(),
                  revision: randomUUID(),
                  hasCover: previous?.customCover
                    ? previous.hasCover
                    : info.hasCover,
                  customTitle: previous?.customTitle,
                  customCover: previous?.customCover,
                  contentRevision:
                    previous?.storage?.fingerprint === fingerprint
                      ? previous.contentRevision || id
                      : randomUUID(),
                  storage: {
                    connectionId: c.id,
                    path,
                    metadataSource: 'propfind',
                    etag: after.etag,
                    modified: after.modified,
                    fingerprint,
                  },
                };
                try {
                  if (info.hasCover && !previous?.customCover)
                    await rename(
                      temporary,
                      join(dir('items', id), 'cover.jpg')
                    );
                  await atomicJSON(join(dir('items', id), 'media.json'), item);
                  if (!item.hasCover)
                    await rm(join(dir('items', id), 'cover.jpg'), {
                      force: true,
                    });
                } catch (error) {
                  if (
                    !previous &&
                    !(await json(join(dir('items', id), 'media.json')))
                  )
                    await rm(dir('items', id), {
                      recursive: true,
                      force: true,
                    });
                  throw error;
                }
                byPath.set(path, item);
                if (previous) status.updated++;
                else status.added++;
              });
            });
          });
        } catch (error) {
          if (stop.signal.aborted) break;
          if (
            error instanceof RemoteMediaError &&
            error.code === 'UNSUPPORTED_FORMAT'
          ) {
            nextCache[path] = SCAN_FORMAT_VERSION + fingerprint;
            status.skipped++;
          } else status.failed++;
          scanDetail(
            status,
            path,
            error instanceof Error ? error.message : '文件检查失败，下轮重试'
          );
        } finally {
          if (temporary) await rm(temporary, { force: true });
        }
        if (status.visited % 10 === 0) await persist();
      }
      await persist();
      if (!complete) break;
    }
    if (complete && !stop.signal.aborted && !status.failed) {
      if (!(await remoteObject(c, root, stop.signal))?.is_dir)
        throw new RemoteMediaError(
          'DAV_DIRECTORY',
          '扫描根目录已不可用，保留原片库'
        );
      for (const item of originals) {
        if (
          stop.signal.aborted ||
          Date.now() - status.startedAt > 4 * 3600000
        ) {
          complete = false;
          break;
        }
        const ref = item.storage;
        if (
          !ref ||
          item.staged ||
          item.createdAt > status.startedAt ||
          (item.state !== 'ready' && !item.cleanupOnly) ||
          (seen.has(ref.path) && !item.cleanupOnly) ||
          !inScanScope(
            ref.path,
            root,
            c.scan.recursive || isManagedPath(c, ref.path)
          )
        )
          continue;
        try {
          await removeMissingMedia(item, status, stop, () =>
            confirmRemoteMissing(c, ref.path, stop.signal)
          );
        } catch (error) {
          status.failed++;
          scanDetail(
            status,
            ref.path,
            error instanceof Error
              ? error.message
              : '无法确认缺失状态，保留记录'
          );
        }
      }
    }
    status.state = stop.signal.aborted
      ? 'cancelled'
      : complete
      ? 'completed'
      : 'interrupted';
    if (status.state === 'completed' && !status.failed)
      status.lastSuccessAt = Date.now();
  } catch (error) {
    status.state = stop.signal.aborted ? 'cancelled' : 'failed';
    status.error =
      error instanceof Error ? error.message : '扫描失败，请稍后重试';
  } finally {
    status.finishedAt = Date.now();
    try {
      await atomicJSON(cacheFile, nextCache);
      await persist();
    } finally {
      scanner.jobs.delete(c.id);
    }
  }
}

async function checkScanSpace() {
  if (controller.restoring)
    fail('SETTINGS_RESTORE', '数据正在恢复，扫描已暂停', 409);
  const settings = await getMediaSettings();
  const disk = await statfs(controller.root, { bigint: true });
  const reserved = (await sessions())
    .filter((s) => s.status !== 'ready')
    .reduce((n, s) => n + Math.max(0, s.size - s.offset) + COVER_RESERVE, 0);
  if (
    Number(disk.bavail * disk.bsize) - reserved - COVER_RESERVE <
    settings.minFreeGiB * GiB
  )
    fail('DISK_LOW', '本地暂存磁盘不足，扫描已暂停', 507);
}
async function runLocalScan(
  status: MediaScanStatus,
  stop: AbortController,
  settings: NonNullable<MediaSettings['localScan']>
) {
  const persist = () =>
    lock('scan-state:local', () => atomicJSON(scanFile('local'), status));
  const root = settings.root;
  const originals = (await records()).filter((item) => !item.storage);
  const byPath = new Map(
    originals
      .filter((item) => item.localFile)
      .map((item) => [item.localFile?.path || '', item])
  );
  const nextCache: Record<string, string> = {};
  const queue = [{ path: root, depth: 0 }];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const cacheFile = join(controller.root, 'scan-cache-local.json');
  const unsupported: Record<string, string> =
    (await json<Record<string, string>>(cacheFile).catch(() => null)) || {};
  let complete = true;
  try {
    while (queue.length && !stop.signal.aborted) {
      const directory = queue.shift();
      if (!directory || visited.has(directory.path)) continue;
      visited.add(directory.path);
      let entries: string[];
      try {
        const info = await lstat(
          join(controller.root, ...directory.path.split('/').filter(Boolean))
        );
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new LocalMediaError('LOCAL_LINK', '跳过符号链接或非目录');
        entries = await readdir(
          await localPath(controller.root, directory.path)
        );
      } catch (e) {
        complete = false;
        status.failed++;
        scanDetail(
          status,
          directory.path,
          e instanceof LocalMediaError ? e.message : '目录无法读取'
        );
        continue;
      }
      // Collect names before iterating; scanning never moves the source files.
      const names = entries.sort();
      for (const name of names) {
        if (stop.signal.aborted) break;
        if (
          status.visited >= 20000 ||
          Date.now() - status.startedAt > 4 * 3600000
        ) {
          complete = false;
          scanDetail(status, root, '达到本轮 20000 条目或 4 小时限制');
          break;
        }
        status.visited++;
        const path = directory.path.replace(/\/$/, '') + '/' + name;
        if (['items', 'uploads'].includes(path.split('/')[1])) continue;
        let temporary = '';
        let source: Awaited<ReturnType<typeof localObject>> = null;
        try {
          const info = await lstat(
            join(controller.root, ...path.split('/').filter(Boolean))
          );
          if (info.isSymbolicLink()) {
            status.skipped++;
            scanDetail(status, path, '跳过符号链接');
            continue;
          }
          if (info.isDirectory()) {
            if (settings.recursive) {
              if (directory.depth >= 20) {
                complete = false;
                scanDetail(status, path, '达到目录深度限制');
              } else queue.push({ path, depth: directory.depth + 1 });
            }
            continue;
          }
          if (!/\.mp4$/i.test(name)) {
            status.skipped++;
            continue;
          }
          source = await localObject(controller.root, path);
          if (!source) {
            status.skipped++;
            continue;
          }
          seen.add(path);
          let existing = byPath.get(path);
          if (
            existing?.state === 'deleting' ||
            scanBlocked('local', path) ||
            (await lock(sourceLock('local', path), () =>
              ignoredSource('local', path)
            ))
          ) {
            status.skipped++;
            continue;
          }
          const existingId = existing?.id;
          if (
            existingId &&
            existing?.localFile?.fingerprint === source.fingerprint &&
            existing.localFile.identity === source.identity &&
            !existing.unavailable
          ) {
            await lock(existingId, async () => {
              const current = await json<RecordFile>(
                join(dir('items', existingId), 'media.json')
              );
              if (
                current?.state !== 'ready' ||
                !current.localFile ||
                current.localFile.identity !== source?.identity
              )
                return;
              current.localFile.path = path;
              if (!current.customTitle)
                current.title =
                  name.replace(/\.mp4$/i, '').slice(0, 100) || '未命名视频';
              await atomicJSON(
                join(dir('items', existingId), 'media.json'),
                current
              );
            });
            status.skipped++;
            continue;
          }
          if (
            existingId &&
            (existing?.localFile?.fingerprint !== source.fingerprint ||
              existing?.localFile?.identity !== source.identity)
          ) {
            await lock(existingId, async () => {
              const current = await json<RecordFile>(
                join(dir('items', existingId), 'media.json')
              );
              if (current?.state === 'ready') {
                current.unavailable = true;
                invalidateMediaStreams(existingId);
                await atomicJSON(
                  join(dir('items', existingId), 'media.json'),
                  current
                );
              }
            });
          }
          if (unsupported[path] === SCAN_FORMAT_VERSION + source.fingerprint) {
            status.skipped++;
            nextCache[path] = SCAN_FORMAT_VERSION + source.fingerprint;
            scanDetail(status, path, '格式不支持，内容未变更');
            continue;
          }
          await lock('quota', () => checkScanSpace());
          temporary = join(controller.root, `scan-cover-${randomUUID()}.jpg`);
          const candidate = source;
          const probe = scanner.probe
            .catch(() => undefined)
            .then(async () => {
              if (stop.signal.aborted)
                throw new LocalMediaError('INTERRUPTED', '扫描已停止');
              const video = await inspectMedia(candidate.absolute);
              let hasCover = false;
              try {
                await createMediaCover(
                  candidate.absolute,
                  temporary,
                  video.duration
                );
                hasCover = true;
              } catch {
                /* Keep a placeholder for valid video. */
              }
              return { ...video, hasCover };
            });
          scanner.probe = probe;
          const video = await probe;
          const after = await localObject(controller.root, path);
          if (
            !after ||
            after.identity !== source.identity ||
            after.fingerprint !== source.fingerprint
          )
            throw new LocalMediaError(
              'LOCAL_CHANGED',
              '处理期间文件变化，下轮重试'
            );
          await lock(sourceLock('local', path), async () => {
            if (
              stop.signal.aborted ||
              scanBlocked('local', path) ||
              (await ignoredSource('local', path))
            )
              return;
            existing = byPath.get(path);
            const id = existing?.id || randomUUID();
            await lock(id, async () => {
              const previous = await json<RecordFile>(
                join(dir('items', id), 'media.json')
              );
              if (
                (existing && !previous) ||
                previous?.state === 'deleting' ||
                stop.signal.aborted ||
                scanBlocked('local', path)
              )
                return;
              const currentSource = await localObject(controller.root, path);
              if (
                !currentSource ||
                currentSource.identity !== after.identity ||
                currentSource.fingerprint !== after.fingerprint
              )
                throw new LocalMediaError(
                  'LOCAL_CHANGED',
                  '文件提交前发生变化，下轮重试'
                );
              if (
                previous?.localFile?.fingerprint &&
                (previous.localFile.fingerprint !== after.fingerprint ||
                  previous.localFile.identity !== after.identity)
              )
                await clearMediaProgress(id);
              await lock('quota', async () => {
                await checkScanSpace();
                await mkdir(dir('items', id), { recursive: true });
                if (video.hasCover && !previous?.customCover)
                  await rename(temporary, join(dir('items', id), 'cover.jpg'));
                const item: RecordFile = {
                  id,
                  owner: '',
                  imported: true,
                  state: 'ready',
                  title: previous?.customTitle
                    ? previous.title
                    : name.replace(/\.mp4$/i, '').slice(0, 100) || '未命名视频',
                  duration: video.duration,
                  width: video.width,
                  height: video.height,
                  bytes: after.bytes,
                  createdAt: previous?.createdAt || Date.now(),
                  revision: randomUUID(),
                  contentRevision:
                    previous?.localFile?.fingerprint === after.fingerprint &&
                    previous.localFile.identity === after.identity
                      ? previous.contentRevision || id
                      : randomUUID(),
                  hasCover: previous?.customCover
                    ? previous.hasCover
                    : video.hasCover,
                  customTitle: previous?.customTitle,
                  customCover: previous?.customCover,
                  localFile: {
                    path,
                    identity: after.identity,
                    fingerprint: after.fingerprint,
                  },
                };
                await atomicJSON(join(dir('items', id), 'media.json'), item);
                byPath.set(path, item);
                if (!item.hasCover)
                  await rm(join(dir('items', id), 'cover.jpg'), {
                    force: true,
                  });
                if (previous) status.updated++;
                else status.added++;
              });
            });
          });
          delete nextCache[path];
        } catch (e) {
          if (stop.signal.aborted) break;
          if (
            source &&
            /^(视频容器不支持|视频编码不支持)/.test((e as Error).message || '')
          ) {
            nextCache[path] = SCAN_FORMAT_VERSION + source.fingerprint;
            status.skipped++;
            scanDetail(status, path, (e as Error).message);
          } else {
            status.failed++;
            scanDetail(
              status,
              path,
              e instanceof LocalMediaError || e instanceof MediaError
                ? e.message
                : '文件无法检查，下轮重试'
            );
          }
        } finally {
          if (temporary) await rm(temporary, { force: true });
        }
        if (status.visited % 10 === 0) await persist();
      }
      await persist();
      if (!complete) break;
    }
    if (complete && !stop.signal.aborted && !status.failed) {
      const rootInfo = await stat(await localPath(controller.root, root));
      if (!rootInfo.isDirectory())
        throw new LocalMediaError(
          'LOCAL_DIRECTORY',
          '扫描根目录已不可用，保留原片库'
        );
      for (const item of originals) {
        const ref = item.localFile,
          path = ref?.path || '/items/' + item.id + '/video.mp4';
        if (
          stop.signal.aborted ||
          Date.now() - status.startedAt > 4 * 3600000
        ) {
          complete = false;
          break;
        }
        if (
          item.createdAt > status.startedAt ||
          (item.state !== 'ready' && !item.cleanupOnly) ||
          (seen.has(path) && !item.cleanupOnly) ||
          !inScanScope(path, root, settings.recursive || !ref)
        )
          continue;
        try {
          await removeMissingMedia(item, status, stop, async () => {
            if (ref) return !(await localObject(controller.root, path));
            try {
              await stat(join(dir('items', item.id), 'video.mp4'));
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return true;
              throw error;
            }
          });
        } catch (error) {
          status.failed++;
          scanDetail(
            status,
            path,
            error instanceof Error
              ? error.message
              : '无法确认旧文件状态，保留原记录'
          );
        }
      }
    }

    status.state = stop.signal.aborted
      ? 'cancelled'
      : complete
      ? 'completed'
      : 'interrupted';
    if (status.state === 'completed' && !status.failed)
      status.lastSuccessAt = Date.now();
  } catch (e) {
    status.state = stop.signal.aborted ? 'cancelled' : 'failed';
    status.error =
      e instanceof MediaError || e instanceof LocalMediaError
        ? e.message
        : '本地扫描失败，请稍后重试';
  } finally {
    status.finishedAt = Date.now();
    await atomicJSON(cacheFile, nextCache);
    await persist();
    scanner.jobs.delete('local');
  }
}
async function beginLocalScan() {
  return lock('scan-start:local', async () => {
    const running = scanner.jobs.get('local');
    if (running) return running.status;
    const settings = (await getMediaSettings()).localScan || DEFAULT_LOCAL_SCAN;
    const previous = await json<MediaScanStatus>(scanFile('local'));
    const status: MediaScanStatus = {
      id: randomUUID(),
      connectionId: 'local',
      state: 'running',
      startedAt: Date.now(),
      lastSuccessAt: previous?.lastSuccessAt,
      added: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      visited: 0,
      details: [],
    };
    const stop = new AbortController();
    scanner.jobs.set('local', { stop, status });
    try {
      await atomicJSON(scanFile('local'), status);
    } catch (e) {
      scanner.jobs.delete('local');
      throw e;
    }
    void runLocalScan(status, stop, settings).catch(() =>
      scanner.jobs.delete('local')
    );
    return status;
  });
}
export async function beginMediaScan(connectionId: string) {
  await initialize();
  if (controller.restoring)
    fail('SETTINGS_RESTORE', '数据正在恢复，请稍后扫描', 409);
  if (connectionId === 'local') return beginLocalScan();
  return lock('scan-start:' + connectionId, async () => {
    const c = await connection(connectionId);
    const running = scanner.jobs.get(c.id);
    if (running) return running.status;
    const service = await inspectRemoteService(c);
    if (!service.canScan) fail('SCAN_UNAVAILABLE', service.message, 400);
    const previous = await json<MediaScanStatus>(scanFile(c.id));
    const status: MediaScanStatus = {
      id: randomUUID(),
      connectionId: c.id,
      state: 'running',
      startedAt: Date.now(),
      lastSuccessAt: previous?.lastSuccessAt,
      added: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      visited: 0,
      details: [],
    };
    const stop = new AbortController();
    scanner.jobs.set(c.id, { stop, status });
    try {
      await atomicJSON(scanFile(c.id), status);
    } catch (e) {
      scanner.jobs.delete(c.id);
      throw e;
    }
    void runScan(c, status, stop).catch(() => scanner.jobs.delete(c.id));
    return status;
  });
}
export async function stopMediaScan(connectionId: string) {
  await initialize();
  if (connectionId !== 'local') await connection(connectionId);
  const job = scanner.jobs.get(connectionId);
  if (job) {
    job.status.state = 'stopping';
    job.stop.abort();
    await lock('scan-state:' + connectionId, () =>
      atomicJSON(scanFile(connectionId), job.status)
    );
  }
  return job?.status || (await json<MediaScanStatus>(scanFile(connectionId)));
}
export async function startMediaRuntime() {
  if (
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage'
  )
    return;
  if (scanner.starting) return scanner.starting;
  scanner.starting = (async () => {
    await initialize();
    for (const s of await scanStatuses())
      if (
        !scanner.jobs.has(s.connectionId) &&
        (s.state === 'running' || s.state === 'stopping')
      ) {
        s.state = 'interrupted';
        s.finishedAt = Date.now();
        await atomicJSON(scanFile(s.connectionId), s);
      }
    const tick = async () => {
      if (controller.restoring) return;
      const settings = await getMediaSettings();
      const targets = [
        { id: 'local', scan: settings.localScan || DEFAULT_LOCAL_SCAN },
        ...(settings.connections || []),
      ];
      for (const c of targets) {
        if (!c.scan.automatic || scanner.jobs.has(c.id)) continue;
        const previous = await json<MediaScanStatus>(scanFile(c.id));
        if (
          !previous ||
          Date.now() - (previous.finishedAt || previous.startedAt) >=
            c.scan.intervalMinutes * 60000
        )
          await beginMediaScan(c.id);
      }
    };
    const schedule = () => {
      if (!scanner.tick)
        scanner.tick = tick()
          .catch(() => undefined)
          .finally(() => {
            scanner.tick = undefined;
          });
    };
    schedule();
    scanner.timer = setInterval(schedule, 30000);
    scanner.timer.unref();
  })().catch(() => {
    scanner.starting = undefined;
    if (!scanner.timer) {
      scanner.timer = setTimeout(() => {
        scanner.timer = undefined;
        void startMediaRuntime();
      }, 30000);
      scanner.timer.unref();
    }
  });
  return scanner.starting;
}

export async function withMediaRestore<T>(
  settings: MediaSettings,
  action: () => Promise<T>
): Promise<T> {
  return lock('settings', async () => {
    const previous = await getMediaSettings();
    for (const c of settings.connections || []) {
      const old = previous.connections?.find((x) => x.id === c.id);
      if (
        old &&
        [old.url, old.root, old.username].join('\n') !==
          [c.url, c.root, c.username].join('\n')
      )
        fail(
          'CONNECTION_CONFLICT',
          '备份连接标识与现有位置冲突，请先核对媒体目录和连接',
          409
        );
    }
    controller.restoring = true;
    try {
      const writes: Promise<void>[] = [];
      for (const upload of Array.from(controller.uploads.values()))
        for (const part of Array.from(upload.active.values())) {
          part.stop.abort();
          writes.push(part.done);
        }
      await Promise.all(writes);
      await Promise.all(
        Array.from(controller.uploads.values(), (upload) => upload.checkpoint)
      );
      for (const job of Array.from(scanner.jobs.values())) job.stop.abort();
      for (const job of Array.from(controller.remoteAborts.values()))
        job.abort();
      for (const job of Array.from(controller.deletionAborts.values()))
        job.abort();
      await Promise.all(Array.from(controller.processingJobs.values()));
      await controller.worker.catch(() => undefined);
      await Promise.all([
        controller.deletionWorker.catch(() => undefined),
        controller.localDeletionWorker.catch(() => undefined),
      ]);
      return await lock('quota', action);
    } finally {
      controller.capacities.clear();
      controller.restoring = false;
    }
  });
}
