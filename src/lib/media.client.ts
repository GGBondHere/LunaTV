'use client';

import CryptoJS from 'crypto-js';

import { getAuthInfoFromBrowserCookie } from './auth';
import {
  type UploadView,
  MEDIA_LEGACY_CHUNK_BYTES,
  MEDIA_UPLOAD_CONCURRENCY,
  MEDIA_UPLOAD_REQUESTS,
  MEDIA_UPLOAD_WINDOW_BYTES,
} from './media';

export class MediaClientError extends Error {
  constructor(message: string, public status = 0, public code = '') {
    super(message);
  }
}
export function currentMediaAccount() {
  return getAuthInfoFromBrowserCookie()?.username || '';
}
export function assertMediaAccount(account: string) {
  if (!account || account !== currentMediaAccount())
    throw new DOMException('账号已切换，请重新打开页面', 'AbortError');
}
export async function mediaRequest<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 45000, ...requestOptions } = options;
  const account = currentMediaAccount();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    assertMediaAccount(account);
    const response = await fetch(url, {
      ...requestOptions,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({
      error:
        response.status === 401 ? '登录已失效，请重新登录' : '共享视频响应无效',
    }));
    assertMediaAccount(account);
    if (!response.ok)
      throw new MediaClientError(
        data.error || '共享视频请求失败',
        response.status,
        data.code
      );
    return data as T;
  } catch (error) {
    assertMediaAccount(account);
    if (timedOut)
      throw new MediaClientError(
        url === '/api/admin/media/check'
          ? '连接检查超时，请检查地址是否可达'
          : '连接超时，已上传的断点仍然保留'
      );
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
export function mediaJSON<T>(
  url: string,
  method: string,
  data?: unknown,
  signal?: AbortSignal,
  timeoutMs?: number
) {
  return mediaRequest<T>(url, {
    method,
    signal,
    timeoutMs,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
export async function hashMediaPart(part: Blob) {
  const data = await part.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
  }
  const bytes = new Uint8Array(data);
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index++)
    words[index >>> 2] =
      (words[index >>> 2] || 0) | (bytes[index] << (24 - (index % 4) * 8));
  return CryptoJS.SHA256(
    CryptoJS.lib.WordArray.create(words, bytes.length)
  ).toString();
}
export async function verifyMediaFile(
  file: File,
  session: UploadView,
  signal: AbortSignal,
  progress: (text: string) => void,
  cache = new Map<number, string>()
) {
  if (
    file.name !== session.name ||
    file.size !== session.size ||
    file.lastModified !== session.modified
  )
    throw new Error('请选择原来上传的同一个文件；如要更换视频，请先取消旧任务');
  const chunkBytes = session.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES;
  const receipts = [
    ...session.hashes.map((hash, index) => ({
      offset: index * chunkBytes,
      hash,
    })),
    ...(session.received || []),
  ];
  for (let index = 0; index < receipts.length; index++) {
    if (signal.aborted) throw new DOMException('已暂停', 'AbortError');
    progress(`正在核对断点 ${index + 1}/${receipts.length}`);
    const part = receipts[index];
    const digest =
      cache.get(part.offset) ||
      (await hashMediaPart(
        file.slice(part.offset, Math.min(file.size, part.offset + chunkBytes))
      ));
    if (signal.aborted) throw new DOMException('已暂停', 'AbortError');
    cache.set(part.offset, digest);
    if (digest !== part.hash)
      throw new Error('所选文件与上传断点不一致，请重新选择原文件');
  }
  return cache;
}
export function uploadMediaPart(
  session: UploadView,
  part: Blob,
  signal: AbortSignal,
  progress: (bytes: number) => void,
  offset = session.offset,
  checksum?: string,
  bodySent?: () => void
): Promise<UploadView> {
  const account = currentMediaAccount();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    let sent = false;
    const release = () => {
      if (sent) return;
      sent = true;
      bodySent?.();
    };
    const finish = () => {
      signal.removeEventListener('abort', abort);
      release();
    };
    signal.addEventListener('abort', abort, { once: true });
    request.open('PATCH', `/api/media/uploads/${session.id}`);
    request.setRequestHeader('Upload-Offset', String(offset));
    if (checksum) request.setRequestHeader('Upload-Checksum', checksum);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.responseType = 'json';
    request.timeout = 90000;
    request.upload.onprogress = (event) => {
      if (!signal.aborted && account === currentMediaAccount())
        progress(event.loaded);
    };
    request.upload.onload = () => {
      if (!signal.aborted && account === currentMediaAccount())
        progress(part.size);
      release();
    };
    request.onload = () => {
      finish();
      try {
        assertMediaAccount(account);
        if (signal.aborted) throw new DOMException('已暂停', 'AbortError');
        if (
          request.status >= 200 &&
          request.status < 300 &&
          request.response?.id === session.id
        )
          resolve(request.response as UploadView);
        else
          reject(
            new MediaClientError(
              request.response?.error || '上传失败，请重试',
              request.status,
              request.response?.code
            )
          );
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => {
      finish();
      reject(new MediaClientError('连接中断，断点已保留'));
    };
    request.ontimeout = () => {
      finish();
      reject(new MediaClientError('上传超时，断点已保留'));
    };
    request.onabort = () => {
      finish();
      reject(new DOMException('已暂停', 'AbortError'));
    };
    if (signal.aborted) {
      finish();
      reject(new DOMException('已暂停', 'AbortError'));
    } else request.send(part);
  });
}
function waitMediaRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) reject(new DOMException('已暂停', 'AbortError'));
      else resolve();
    };
    const aborted = () => done();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) done();
  });
}

export async function uploadMediaFile(
  file: File,
  initial: UploadView,
  signal: AbortSignal,
  callbacks: {
    session: (task: UploadView) => void;
    progress: (bytes: number, speed: number) => void;
    stage: (text: string) => void;
  },
  hashes = new Map<number, string>()
): Promise<UploadView> {
  const account = currentMediaAccount();
  let task = initial;
  const current = () => {
    assertMediaAccount(account);
    if (signal.aborted) throw new DOMException('已暂停', 'AbortError');
  };
  for (let attempt = 0; ; attempt++) {
    current();
    if (task.status !== 'uploading') return task;
    await verifyMediaFile(
      file,
      task,
      signal,
      (text) => {
        current();
        callbacks.stage(text);
      },
      hashes
    );
    current();
    const chunkBytes = task.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES;
    const received = new Map<number, string>([
      ...task.hashes.map((hash, index): [number, string] => [
        index * chunkBytes,
        hash,
      ]),
      ...(task.received || []).map((part): [number, string] => [
        part.offset,
        part.hash,
      ]),
    ]);
    const pending: number[] = [];
    for (let offset = 0; offset < task.size; offset += chunkBytes)
      if (!received.has(offset)) pending.push(offset);
    let next = 0;
    let failure: unknown;
    let accepted = false;
    let sentBytes = 0;
    let speed = 0;
    let sending = 0;
    const inflight = new Map<number, number>();
    const batch = new AbortController();
    const abort = () => batch.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) batch.abort();
    const report = () => {
      if (batch.signal.aborted || account !== currentMediaAccount()) return;
      let bytes = 0;
      for (const offset of Array.from(received.keys()))
        bytes += Math.min(chunkBytes, task.size - offset);
      for (const [offset, count] of Array.from(inflight))
        if (!received.has(offset)) bytes += count;
      sentBytes = Math.min(task.size, bytes);
      callbacks.progress(sentBytes, speed);
      callbacks.stage(
        sentBytes === task.size && pending.length ? '正在确认上传' : '正在上传'
      );
    };
    report();
    let sampleTime = performance.now();
    let sampleBytes = sentBytes;
    const timer = setInterval(() => {
      const now = performance.now();
      speed = Math.max(
        0,
        ((sentBytes - sampleBytes) * 1000) / Math.max(1, now - sampleTime)
      );
      sampleBytes = sentBytes;
      sampleTime = now;
      report();
    }, 1000);
    const waiters = new Set<() => void>();
    const notify = () => {
      for (const done of Array.from(waiters)) done();
    };
    const waitForChange = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          waiters.delete(done);
          batch.signal.removeEventListener('abort', done);
          resolve();
        };
        waiters.add(done);
        batch.signal.addEventListener('abort', done, { once: true });
        if (batch.signal.aborted) done();
      });
    const waitForWindow = async (offset: number) => {
      while (
        !batch.signal.aborted &&
        offset >= task.offset + MEDIA_UPLOAD_WINDOW_BYTES
      ) {
        await waitForChange();
      }
    };
    const sender = async () => {
      while (sending >= MEDIA_UPLOAD_CONCURRENCY && !batch.signal.aborted)
        await waitForChange();
      if (batch.signal.aborted) throw new DOMException('已暂停', 'AbortError');
      sending++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        sending--;
        notify();
      };
    };
    const accept = (value: UploadView) => {
      if (
        value.id !== task.id ||
        value.size !== task.size ||
        (value.chunkBytes || MEDIA_LEGACY_CHUNK_BYTES) !== chunkBytes ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 0 ||
        value.offset > task.size
      )
        throw new MediaClientError('上传状态无效，请重新打开上传面板');
      value.hashes.forEach((hash, index) =>
        received.set(index * chunkBytes, hash)
      );
      for (const part of value.received || [])
        received.set(part.offset, part.hash);
      // Concurrent responses can arrive out of order; receipts only advance within a batch.
      if (
        value.offset > task.offset ||
        (value.offset === task.offset &&
          (value.checkpointOffset ?? value.offset) >=
            (task.checkpointOffset ?? task.offset))
      )
        task = value;
      task = {
        ...task,
        received: Array.from(received)
          .filter(([offset]) => offset >= task.offset)
          .map(([offset, hash]) => ({ offset, hash })),
      };
      callbacks.session(task);
      notify();
      report();
      if (
        task.accepted &&
        task.offset === task.size &&
        ['processing', 'ready'].includes(task.status)
      ) {
        // The server confirmed every byte; slow/lost earlier acknowledgements no longer block closing.
        accepted = true;
        callbacks.progress(task.size, speed);
        batch.abort();
      }
    };
    const worker = async () => {
      try {
        while (next < pending.length && !batch.signal.aborted) {
          current();
          const offset = pending[next++];
          if (received.has(offset)) continue;
          await waitForWindow(offset);
          if (batch.signal.aborted) return;
          const part = file.slice(
            offset,
            Math.min(task.size, offset + chunkBytes)
          );
          const hash = hashes.get(offset) || (await hashMediaPart(part));
          current();
          hashes.set(offset, hash);
          if (batch.signal.aborted) return;
          const release = await sender();
          inflight.set(offset, 0);
          let value: UploadView;
          try {
            value = await uploadMediaPart(
              task,
              part,
              batch.signal,
              (count) => {
                inflight.set(offset, Math.min(part.size, count));
                report();
              },
              offset,
              hash,
              release
            );
          } finally {
            release();
          }
          current();
          if (batch.signal.aborted) return;
          inflight.delete(offset);
          accept(value);
        }
      } catch (error) {
        if (!accepted && !failure) failure = error;
        batch.abort();
      }
    };
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(MEDIA_UPLOAD_REQUESTS, pending.length) },
          worker
        )
      );
      current();
      if (failure) throw failure;
      // Successful chunk responses already confirm a complete upload. Only fetch
      // another snapshot when receipts are missing or another tab may be involved.
      if (task.offset < task.size && task.status === 'uploading')
        task = await mediaRequest<UploadView>(`/api/media/uploads/${task.id}`, {
          signal,
        });
      current();
      callbacks.session(task);
      if (task.offset === task.size || task.status !== 'uploading') {
        if (task.status === 'uploading')
          await verifyMediaFile(
            file,
            task,
            signal,
            (text) => {
              current();
              callbacks.stage(text);
            },
            hashes
          );
        current();
        callbacks.progress(task.offset, 0);
        return task;
      }
      throw new MediaClientError('正在恢复尚未确认的分块', 409);
    } catch (error) {
      current();
      if (
        !(error instanceof MediaClientError) ||
        error.code === 'CHUNK_CONFLICT' ||
        (error.status !== 0 &&
          ![409, 429, 500, 502, 503, 504].includes(error.status)) ||
        attempt >= 3
      )
        throw error;
      callbacks.stage(`连接恢复后重试（${attempt + 1}/3）`);
      await waitMediaRetry((attempt + 1) * 1000, signal);
      task = await mediaRequest<UploadView>(`/api/media/uploads/${task.id}`, {
        signal,
      });
      current();
      callbacks.session(task);
    } finally {
      batch.abort();
      clearInterval(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}
export function mediaChanged() {
  window.dispatchEvent(new Event('mediaUpdated'));
}
