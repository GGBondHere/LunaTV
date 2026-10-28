'use client';

import CryptoJS from 'crypto-js';

import { getAuthInfoFromBrowserCookie } from './auth';
import { type UploadView, MEDIA_CHUNK_BYTES } from './media';

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
  options: RequestInit = {}
): Promise<T> {
  const account = currentMediaAccount();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);
  try {
    assertMediaAccount(account);
    const response = await fetch(url, {
      ...options,
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
    if (timedOut) throw new MediaClientError('连接超时，已上传的断点仍然保留');
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
  signal?: AbortSignal
) {
  return mediaRequest<T>(url, {
    method,
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
export async function hashMediaPart(part: Blob) {
  const bytes = new Uint8Array(await part.arrayBuffer());
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
  progress: (text: string) => void
) {
  if (
    file.name !== session.name ||
    file.size !== session.size ||
    file.lastModified !== session.modified
  )
    throw new Error('请选择原来上传的同一个文件；如要更换视频，请先取消旧任务');
  for (let index = 0; index < session.hashes.length; index++) {
    if (signal.aborted) throw new DOMException('已暂停', 'AbortError');
    progress(`正在核对断点 ${index + 1}/${session.hashes.length}`);
    const digest = await hashMediaPart(
      file.slice(
        index * MEDIA_CHUNK_BYTES,
        Math.min(file.size, (index + 1) * MEDIA_CHUNK_BYTES)
      )
    );
    if (digest !== session.hashes[index])
      throw new Error('所选文件与上传断点不一致，请重新选择原文件');
  }
}
export function uploadMediaPart(
  session: UploadView,
  part: Blob,
  signal: AbortSignal,
  progress: (bytes: number) => void
): Promise<UploadView> {
  const account = currentMediaAccount();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    request.open('PATCH', `/api/media/uploads/${session.id}`);
    request.setRequestHeader('Upload-Offset', String(session.offset));
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.responseType = 'json';
    request.timeout = 90000;
    request.upload.onprogress = (event) => {
      if (!signal.aborted && account === currentMediaAccount())
        progress(event.loaded);
    };
    request.onload = () => {
      finish();
      try {
        assertMediaAccount(account);
        if (request.status >= 200 && request.status < 300)
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
export function mediaChanged() {
  window.dispatchEvent(new Event('mediaUpdated'));
}
