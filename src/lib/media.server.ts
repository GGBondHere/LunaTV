import { createHash, randomUUID } from 'crypto';
import {
  access,
  constants,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
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
  type MediaList,
  type MediaPolicy,
  type MediaSettings,
  type MediaView,
  type UploadView,
  GiB,
  MEDIA_CHUNK_BYTES,
  MEDIA_COVER_BYTES,
  MEDIA_SOURCE,
  parseMediaSettings,
} from './media';
import {
  checkMediaTools,
  createMediaCover,
  inspectMedia,
} from './media-processing.server';
import type { PlayRecord } from './types';

const COVER_RESERVE = 12 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
interface MediaAuth {
  username: string;
  isAdmin: boolean;
}
interface Session extends UploadView {
  owner: string;
}
interface RecordFile extends Omit<MediaView, 'canManage'> {
  owner: string;
  state: 'ready' | 'deleting';
}
interface Controller {
  root: string;
  init?: Promise<void>;
  locks: Map<string, Promise<unknown>>;
  active: number;
  worker: Promise<unknown>;
  processing: Set<string>;
  timer?: ReturnType<typeof setInterval>;
  coverReservations: Map<string, number>;
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
    coverReservations: new Map(),
  });

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
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
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
    if (entry.isSymbolicLink())
      fail('STORAGE_ERROR', '媒体目录含不支持的符号链接');
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
        if (published?.state === 'ready') {
          session.status = 'ready';
        }
        if (session.status === 'uploading' || session.status === 'processing') {
          const file = await stat(join(path, 'video.part')).catch(() => null);
          if (!file || file.size < session.offset) {
            session.status = 'failed';
            session.error = '临时文件不完整，请取消后重新上传';
          } else await truncate(join(path, 'video.part'), session.offset);
        }
        await atomicJSON(join(path, 'session.json'), session);
        if (session.status === 'processing') recover.push(session);
      }
      recover.forEach((session) =>
        queueMediaProcessing(session.id, {
          username: session.owner,
          isAdmin: false,
        })
      );
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
    ).map((id) => json<Session>(join(dir('uploads', id), 'session.json')))
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
export async function saveMediaSettings(value: unknown) {
  let settings: MediaSettings;
  try {
    settings = parseMediaSettings(value);
  } catch (error) {
    fail('INVALID_SETTINGS', (error as Error).message);
  }
  await lock('quota', () => db.setMediaSettings(settings));
  return settings;
}
async function policy(): Promise<MediaPolicy> {
  const settings = await getMediaSettings();
  const usedBytes = await treeSize(controller.root);
  // 未完成任务按固定预算计费；流式写入与清单提交之间也不会少算或重复预留视频。
  let allocated = 0;
  for (const id of await ids('items'))
    allocated +=
      controller.coverReservations.get(id) ??
      (await treeSize(dir('items', id)));
  for (const session of await sessions())
    allocated += ['uploading', 'processing'].includes(session.status)
      ? session.size + COVER_RESERVE
      : await treeSize(dir('uploads', session.id));
  const reservedBytes = Math.max(0, allocated - usedBytes);
  const disk = await statfs(controller.root, { bigint: true });
  const freeBytes = Number(disk.bavail * disk.bsize);
  const availableBytes = Math.max(
    0,
    Math.min(
      settings.quotaGiB * GiB - allocated,
      freeBytes - settings.minFreeGiB * GiB - reservedBytes
    )
  );
  return {
    enabled: true,
    reason: '',
    settings,
    usedBytes,
    reservedBytes,
    freeBytes,
    availableBytes,
    overQuota: allocated > settings.quotaGiB * GiB,
  };
}
export async function mediaPolicy(): Promise<MediaPolicy> {
  const settings = await getMediaSettings();
  try {
    await initialize();
    return await policy();
  } catch (error) {
    return {
      enabled: false,
      reason: error instanceof MediaError ? error.message : '无法读取媒体目录',
      settings,
      usedBytes: 0,
      reservedBytes: 0,
      freeBytes: 0,
      availableBytes: 0,
      overQuota: false,
    };
  }
}
function view(item: RecordFile, auth: MediaAuth): MediaView {
  const { owner, state: _state, ...metadata } = item;
  return {
    ...metadata,
    canManage: auth.isAdmin || owner === auth.username,
    pendingDeletion: _state === 'deleting',
  };
}
function uploadView(session: Session): UploadView {
  const { owner: _owner, ...metadata } = session;
  return metadata;
}
export async function mediaList(
  auth: MediaAuth,
  mine = false
): Promise<MediaList> {
  const status = await mediaPolicy();
  if (!status.enabled) return { items: [], upload: null, policy: status };
  await cleanupMedia();
  const items = (await records())
    .filter(
      (item) =>
        (item.state === 'ready' ||
          auth.isAdmin ||
          item.owner === auth.username) &&
        (!mine || item.owner === auth.username)
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => view(item, auth));
  const session = (await sessions()).find(
    (item) => item.owner === auth.username && item.status !== 'ready'
  );
  return {
    items,
    upload: session ? uploadView(session) : null,
    policy: status,
  };
}
async function record(id: string) {
  await initialize();
  const item = await json<RecordFile>(join(dir('items', id), 'media.json'));
  if (!item || item.state !== 'ready')
    fail('NOT_FOUND', '视频已被移除或尚未发布', 404);
  return item;
}
export async function getMedia(id: string, auth: MediaAuth) {
  return view(await record(id), auth);
}
function manage(owner: string, auth: MediaAuth) {
  if (owner !== auth.username && !auth.isAdmin)
    fail('FORBIDDEN', '只能管理自己上传的视频', 403);
}
function title(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
    fail('INVALID_TITLE', '标题需要 1–100 个字符');
  return value.trim();
}
async function getSession(id: string, auth: MediaAuth) {
  await initialize();
  const session = await json<Session>(join(dir('uploads', id), 'session.json'));
  if (!session) fail('NOT_FOUND', '上传任务已过期，请重新选择视频', 404);
  manage(session.owner, auth);
  return session;
}
async function saveSession(session: Session) {
  await atomicJSON(join(dir('uploads', session.id), 'session.json'), session);
}
export async function uploadStatus(id: string, auth: MediaAuth) {
  return uploadView(await getSession(id, auth));
}
export async function beginUpload(
  input: {
    name?: unknown;
    size?: unknown;
    modified?: unknown;
    title?: unknown;
  },
  auth: MediaAuth
) {
  await initialize();
  return lock('quota', async () => {
    const current = await policy();
    if (!current.settings.allowUploads)
      fail('UPLOAD_DISABLED', '管理员已暂停上传', 403);
    const size = input.size;
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      typeof input.name !== 'string' ||
      input.name.length > 255 ||
      !/\.mp4$/i.test(input.name) ||
      typeof input.modified !== 'number' ||
      !Number.isSafeInteger(input.modified) ||
      input.modified < 0
    )
      fail('INVALID_FILE', '请选择有效的 MP4 视频');
    const existing = (await sessions()).find(
      (item) => item.owner === auth.username && item.status !== 'ready'
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
      status: 'uploading',
      hasCover: false,
      updatedAt: Date.now(),
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
async function checkWrite(bytes: number) {
  const settings = await getMediaSettings();
  if (!settings.allowUploads)
    fail('UPLOAD_DISABLED', '管理员已暂停上传，断点已保留', 403);
  const disk = await statfs(controller.root, { bigint: true });
  let remaining = (await sessions())
    .filter((item) => ['uploading', 'processing'].includes(item.status))
    .reduce(
      (n, item) => n + Math.max(0, item.size - item.offset) + COVER_RESERVE,
      0
    );
  for (const [id, budget] of Array.from(controller.coverReservations))
    remaining += Math.max(0, budget - (await treeSize(dir('items', id))));
  if (
    Number(disk.bavail * disk.bsize) - Math.max(bytes, remaining) <
    settings.minFreeGiB * GiB
  )
    fail('DISK_LOW', '磁盘触及保留空间，上传已暂停，断点保留 24 小时', 507);
}
async function limitedBody(
  request: NextRequest,
  limit: number,
  write: (chunk: Uint8Array) => Promise<void>
) {
  if (!request.body) fail('EMPTY_BODY', '没有收到文件内容');
  const reader = request.body.getReader();
  let count = 0;
  try {
    while (!request.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) fail('CHUNK_TOO_LARGE', '上传块超过限制', 413);
      await write(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (request.signal.aborted)
    fail('INTERRUPTED', '上传连接中断，断点已保留', 409);
  return count;
}
export async function appendUpload(
  id: string,
  request: NextRequest,
  auth: MediaAuth
) {
  return lock(id, async () => {
    const session = await getSession(id, auth);
    if (session.status !== 'uploading')
      fail('UPLOAD_STATE', '该任务当前不能接收数据', 409);
    const offset = Number(request.headers.get('Upload-Offset'));
    if (
      !request.headers.has('Upload-Offset') ||
      !Number.isSafeInteger(offset) ||
      offset !== session.offset
    )
      fail('OFFSET_CONFLICT', '上传偏移已变化，请读取断点后继续', 409);
    const expected = Math.min(MEDIA_CHUNK_BYTES, session.size - offset);
    if (!expected) return uploadView(session);
    if (controller.active >= 2)
      fail('UPLOAD_BUSY', '其他朋友正在上传，请稍后重试', 429);
    controller.active++;
    const filePath = join(dir('uploads', id), 'video.part');
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await lock('quota', () => checkWrite(expected));
      file = await open(filePath, 'r+');
      let position = offset;
      const hash = createHash('sha256');
      const count = await limitedBody(request, expected, async (chunk) => {
        hash.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          const result = await file?.write(
            chunk,
            written,
            chunk.length - written,
            position
          );
          if (!result?.bytesWritten) throw new Error('写入失败');
          written += result.bytesWritten;
          position += result.bytesWritten;
        }
      });
      if (count !== expected) fail('INTERRUPTED', '上传块不完整，请重试', 409);
      await file.sync();
      const committed = {
        ...session,
        offset: offset + count,
        hashes: [...session.hashes, hash.digest('hex')],
        updatedAt: Date.now(),
      };
      await saveSession(committed);
      return uploadView(committed);
    } catch (error) {
      await file?.close();
      file = undefined;
      await truncate(filePath, offset).catch(() => undefined);
      throw error;
    } finally {
      await file?.close();
      controller.active--;
    }
  });
}
export async function putMediaCover(
  id: string,
  request: NextRequest,
  auth: MediaAuth,
  uploading: boolean
) {
  return lock(id, async () => {
    const item = uploading ? await getSession(id, auth) : await record(id);
    manage(item.owner, auth);
    if (uploading && (item as Session).status !== 'uploading')
      fail('UPLOAD_STATE', '当前不能替换上传封面', 409);
    const mime = request.headers.get('content-type')?.split(';')[0];
    if (!mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      fail('INVALID_COVER', '封面仅支持 JPG、PNG 或 WebP');
    const location = dir(uploading ? 'uploads' : 'items', id);
    await lock('quota', async () => {
      if (!uploading) {
        const current = await policy();
        if (current.availableBytes < COVER_RESERVE)
          fail('NO_SPACE', '没有足够空间替换封面，请先释放空间', 507);
        controller.coverReservations.set(
          id,
          (await treeSize(location)) + COVER_RESERVE
        );
      }
      try {
        await checkWrite(MEDIA_COVER_BYTES + 2 * 1024 * 1024);
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
async function processUpload(id: string, auth: MediaAuth) {
  await lock(id, async () => {
    const session = await getSession(id, auth);
    if (session.status !== 'processing') return;
    const source = join(dir('uploads', id), 'video.part');
    try {
      await lock('quota', () => checkWrite(2 * 1024 * 1024));
      const info = await inspectMedia(source).catch((error) =>
        fail(
          'UNSUPPORTED_FORMAT',
          /^(视频容器不支持|视频编码不支持)/.test(error.message || '')
            ? error.message
            : '无法读取视频或检查超时，请确认 MP4 文件完整'
        )
      );
      if (!session.hasCover) {
        try {
          await createMediaCover(
            source,
            join(dir('uploads', id), 'cover.jpg'),
            info.duration
          );
          session.hasCover = true;
        } catch {
          session.hasCover = false;
        }
      }
      // 先完整构建目录，再原子发布；视频不复制，避免翻倍占用空间。
      await lock('quota', async () => {
        await checkWrite(2 * 1024 * 1024);
        const itemDir = dir('items', id);
        await mkdir(itemDir, { recursive: true });
        await rename(source, join(itemDir, 'video.mp4'));
        if (session.hasCover)
          await rename(
            join(dir('uploads', id), 'cover.jpg'),
            join(itemDir, 'cover.jpg')
          );
        const item: RecordFile = {
          id,
          title: session.title,
          ...info,
          bytes: session.size,
          owner: session.owner,
          createdAt: Date.now(),
          revision: randomUUID(),
          hasCover: session.hasCover,
          state: 'ready',
        };
        await atomicJSON(join(itemDir, 'media.json'), item);
        session.status = 'ready';
        session.updatedAt = Date.now();
        await saveSession(session);
      });
    } catch (error) {
      const published = await json<RecordFile>(
        join(dir('items', id), 'media.json')
      );
      if (published?.state === 'ready') {
        session.status = 'ready';
        await saveSession(session);
        return;
      }
      if (
        error instanceof MediaError &&
        ['DISK_LOW', 'UPLOAD_DISABLED'].includes(error.code)
      ) {
        session.status = 'uploading';
        session.error = error.message;
      } else {
        session.status = 'failed';
        session.error =
          error instanceof MediaError
            ? error.message
            : '视频处理失败，请取消后重新上传';
        await rm(source, { force: true });
        await rm(dir('items', id), { recursive: true, force: true });
      }
      session.updatedAt = Date.now();
      await saveSession(session);
    }
  });
}
function queueMediaProcessing(id: string, auth: MediaAuth) {
  if (controller.processing.has(id)) return;
  controller.processing.add(id);
  const job = controller.worker
    .catch(() => undefined)
    .then(() => processUpload(id, auth));
  controller.worker = job;
  void job
    .catch(() => undefined)
    .finally(() => controller.processing.delete(id));
}
export async function completeUpload(id: string, auth: MediaAuth) {
  const result = await lock(id, async () => {
    const session = await getSession(id, auth);
    if (session.status === 'ready' || session.status === 'processing')
      return uploadView(session);
    if (session.status !== 'uploading' || session.offset !== session.size)
      fail('UPLOAD_INCOMPLETE', '视频尚未完整上传', 409);
    await lock('quota', () => checkWrite(2 * 1024 * 1024));
    session.status = 'processing';
    session.error = undefined;
    session.updatedAt = Date.now();
    await saveSession(session);
    return uploadView(session);
  });
  if (result.status === 'processing') queueMediaProcessing(id, auth);
  return result;
}
export async function cancelUpload(id: string, auth: MediaAuth) {
  await lock(id, async () => {
    const session = await getSession(id, auth);
    if (session.status === 'ready')
      fail('ALREADY_PUBLISHED', '视频已发布，请从列表删除', 409);
    await lock('quota', async () => {
      await rm(dir('items', id), { recursive: true, force: true });
      await rm(dir('uploads', id), { recursive: true, force: true });
    });
  });
}
export async function editMedia(id: string, value: unknown, auth: MediaAuth) {
  return lock(id, async () => {
    const item = await record(id);
    manage(item.owner, auth);
    item.title = title(value);
    item.revision = randomUUID();
    await atomicJSON(join(dir('items', id), 'media.json'), item);
    return view(item, auth);
  });
}
export async function deleteMedia(id: string, auth: MediaAuth) {
  await initialize();
  await lock(id, async () => {
    const item = await json<RecordFile>(join(dir('items', id), 'media.json'));
    if (!item) return;
    manage(item.owner, auth);
    item.state = 'deleting';
    await atomicJSON(join(dir('items', id), 'media.json'), item);
    try {
      const users = Array.from(
        new Set(
          [...(await db.getAllUsers()), process.env.USERNAME].filter(
            (value): value is string => !!value
          )
        )
      );
      for (const user of users)
        await db.deletePlayRecord(user, MEDIA_SOURCE, id);
      await lock('quota', async () => {
        // 清单最后删除；失败时留下 tombstone，重试不会误报空间已释放。
        await rm(join(dir('items', id), 'video.mp4'), { force: true });
        await rm(join(dir('items', id), 'cover.jpg'), { force: true });
        await rm(dir('uploads', id), { recursive: true, force: true });
        await rm(dir('items', id), { recursive: true, force: true });
      });
    } catch {
      fail(
        'DELETE_FAILED',
        '视频已停止展示，但清理未完成；请再次删除以重试',
        500
      );
    }
  });
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
) {
  await record(id);
  const path = join(dir('items', id), cover ? 'cover.jpg' : 'video.mp4');
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    fail('NOT_FOUND', cover ? '封面不存在' : '视频文件不存在', 404);
  }
  const size = (await handle.stat()).size;
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
  const range = request.method === 'HEAD' ? null : request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1]
        ? Number(match[1])
        : Math.max(0, size - Number(match[2]));
      end =
        match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
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
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  if (request.method === 'HEAD') {
    await handle.close();
    return new Response(null, { headers });
  }
  const stream = handle.createReadStream({ start, end, autoClose: true });
  const abort = () => stream.destroy();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) stream.destroy();
  stream.once('close', () =>
    request.signal.removeEventListener('abort', abort)
  );
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status,
    headers,
  });
}
export async function cleanupMedia() {
  await initialize();
  for (const session of await sessions()) {
    if (
      Date.now() - session.updatedAt < DAY ||
      controller.processing.has(session.id) ||
      controller.locks.has(session.id)
    )
      continue;
    await lock(session.id, async () => {
      const current = await json<Session>(
        join(dir('uploads', session.id), 'session.json')
      );
      if (current && Date.now() - current.updatedAt >= DAY)
        await lock('quota', () =>
          rm(dir('uploads', session.id), { recursive: true, force: true })
        );
    });
  }
}
