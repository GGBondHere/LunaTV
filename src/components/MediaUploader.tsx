'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  type UploadView,
  formatMediaBytes,
  MEDIA_CHUNK_BYTES,
  MEDIA_COVER_BYTES,
} from '@/lib/media';
import {
  assertMediaAccount,
  currentMediaAccount,
  mediaChanged,
  MediaClientError,
  mediaJSON,
  mediaRequest,
  uploadMediaPart,
  verifyMediaFile,
} from '@/lib/media.client';

export default function MediaUploader({
  initial,
  onClose,
}: {
  initial: UploadView | null;
  onClose: () => void;
}) {
  const [session, setSession] = useState(initial);
  const [file, setFile] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [title, setTitle] = useState(initial?.title || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initial?.error || '');
  const [stage, setStage] = useState(
    initial?.status === 'processing' ? '正在检查视频和生成封面' : ''
  );
  const [bytes, setBytes] = useState(initial?.offset || 0);
  const [speed, setSpeed] = useState(0);
  const controller = useRef<AbortController>();
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const close = () => {
    controller.current?.abort();
    onClose();
    mediaChanged();
  };
  const run = async () => {
    if (running.current) return;
    if (!file && session?.status !== 'processing') {
      setError('请先选择视频；续传需要重新选择原文件');
      return;
    }
    if (!title.trim() || title.trim().length > 100) {
      setError('标题需要 1–100 个字符');
      return;
    }
    const account = currentMediaAccount();
    const stop = new AbortController();
    controller.current = stop;
    running.current = true;
    setBusy(true);
    setError('');
    setSpeed(0);
    const current = () => {
      assertMediaAccount(account);
      if (stop.signal.aborted || !alive.current)
        throw new DOMException('已暂停', 'AbortError');
    };
    try {
      let task: UploadView | null = session
        ? await mediaRequest<UploadView>(`/api/media/uploads/${session.id}`, {
            signal: stop.signal,
          })
        : null;
      if (!task) {
        if (!file) return;
        task = await mediaJSON<UploadView>(
          '/api/media/uploads',
          'POST',
          {
            name: file.name,
            size: file.size,
            modified: file.lastModified,
            title,
          },
          stop.signal
        );
      }
      current();
      setSession(task);
      setBytes(task.offset);
      if (task.status === 'failed')
        throw new Error(task.error || '该视频检查失败，请取消后重新上传');
      if (task.status === 'uploading') {
        if (!file) throw new Error('请选择原视频文件');
        await verifyMediaFile(file, task, stop.signal, setStage);
        current();
        if (cover)
          await mediaRequest(`/api/media/uploads/${task.id}/cover`, {
            method: 'PUT',
            headers: { 'Content-Type': cover.type },
            body: cover,
            signal: stop.signal,
          });
        let retries = 0;
        while (task.offset < task.size) {
          current();
          setStage('正在上传');
          const offset: number = task.offset;
          const started = Date.now();
          try {
            task = await uploadMediaPart(
              task,
              file.slice(
                offset,
                Math.min(task.size, offset + MEDIA_CHUNK_BYTES)
              ),
              stop.signal,
              (sent) => {
                setBytes(offset + sent);
                setSpeed((sent * 1000) / Math.max(1, Date.now() - started));
              }
            );
            current();
            retries = 0;
            setSession(task);
            setBytes(task.offset);
          } catch (failure) {
            current();
            if (
              !(failure instanceof MediaClientError) ||
              (failure.status &&
                ![409, 429, 500, 502, 503, 504].includes(failure.status)) ||
              retries >= 3
            )
              throw failure;
            retries++;
            setStage(`连接恢复后重试（${retries}/3）`);
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, retries * 1000);
              stop.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true }
              );
            });
            current();
            task = await mediaRequest<UploadView>(
              `/api/media/uploads/${task.id}`,
              { signal: stop.signal }
            );
            await verifyMediaFile(file, task, stop.signal, setStage);
            current();
            setSession(task);
            setBytes(task.offset);
          }
        }
        task = await mediaJSON<UploadView>(
          `/api/media/uploads/${task.id}/complete`,
          'POST',
          undefined,
          stop.signal
        );
      }
      while (task.status === 'processing') {
        current();
        setStage('正在检查视频和生成封面');
        setSession(task);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current();
        task = await mediaRequest<UploadView>(`/api/media/uploads/${task.id}`, {
          signal: stop.signal,
        });
      }
      current();
      setSession(task);
      if (task.status !== 'ready')
        throw new Error(task.error || '处理已暂停，请稍后继续');
      mediaChanged();
      onClose();
    } catch (failure) {
      if (alive.current && account === currentMediaAccount()) {
        setError(
          failure instanceof DOMException && failure.name === 'AbortError'
            ? '已暂停，重新点击可继续上传'
            : (failure as Error).message
        );
        setStage('');
      }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const cancel = async () => {
    if (!session || !window.confirm('取消上传并删除已上传的临时文件？')) return;
    controller.current?.abort();
    try {
      await mediaJSON(`/api/media/uploads/${session.id}`, 'DELETE');
      mediaChanged();
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  const total = session?.size || file?.size || 0;
  return createPortal(
    <div
      className='fixed inset-0 z-[11000] flex items-center justify-center bg-black/50 p-4'
      onClick={close}
    >
      <section
        role='dialog'
        aria-modal='true'
        aria-label='上传共享视频'
        onClick={(event) => event.stopPropagation()}
        className='max-h-[90dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900'
      >
        <div className='flex items-center justify-between'>
          <h2 className='text-lg font-semibold'>上传共享视频</h2>
          <button
            type='button'
            onClick={close}
            className='rounded-lg px-2 py-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
          >
            关闭
          </button>
        </div>
        <p className='text-sm text-gray-500'>
          支持 MP4、H.264 视频和 AAC 音频。上传中关闭面板会暂停，24
          小时内可选择原文件续传；检查处理会在服务器继续。
        </p>
        {session && (
          <p className='break-all rounded-lg bg-gray-100 p-3 text-sm dark:bg-gray-800'>
            未完成：{session.name} · {formatMediaBytes(session.offset)} /{' '}
            {formatMediaBytes(session.size)}
          </p>
        )}
        <label className='block text-sm'>
          视频文件
          <input
            type='file'
            accept='.mp4,video/mp4'
            disabled={busy}
            className='mt-2 block w-full cursor-pointer rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700 transition-colors file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-green-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200'
            onChange={(event) => {
              const selected = event.target.files?.[0] || null;
              setFile(selected);
              if (!session && selected)
                setTitle(selected.name.replace(/\.mp4$/i, ''));
              setError('');
            }}
          />
        </label>
        <label className='block text-sm'>
          标题
          <input
            value={title}
            maxLength={100}
            disabled={busy || !!session}
            onChange={(event) => setTitle(event.target.value)}
            className='mt-2 w-full rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-600'
          />
        </label>
        <label className='block text-sm'>
          封面（可选，默认自动截帧）
          <input
            type='file'
            accept='image/jpeg,image/png,image/webp'
            disabled={busy}
            className='mt-2 block w-full cursor-pointer rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700 transition-colors file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-green-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200'
            onChange={(event) => {
              const selected = event.target.files?.[0] || null;
              if (selected && selected.size > MEDIA_COVER_BYTES) {
                event.target.value = '';
                setError('封面不能超过 5 MiB');
                return;
              }
              setCover(selected);
            }}
          />
        </label>
        {(busy || bytes > 0) && (
          <div className='space-y-2 text-sm'>
            <div
              role='progressbar'
              aria-label='视频上传进度'
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={total ? Math.floor((bytes / total) * 100) : 0}
              className='h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700'
            >
              <div
                className='h-full bg-green-500 transition-[width]'
                style={{
                  width: `${total ? Math.min(100, (bytes / total) * 100) : 0}%`,
                }}
              />
            </div>
            <p className='min-h-5 text-gray-500'>
              {stage || '上传已暂停'}
              {stage === '正在上传' && speed > 0
                ? ` · ${formatMediaBytes(speed)}/s · 剩余约 ${Math.ceil(
                    Math.max(0, total - bytes) / speed
                  )} 秒`
                : ''}
            </p>
          </div>
        )}
        {error && (
          <p role='alert' className='text-sm text-red-500'>
            {error}
          </p>
        )}
        <div className='flex items-center justify-end gap-3'>
          {session && (
            <button
              type='button'
              onClick={() => void cancel()}
              className='text-sm text-red-500'
            >
              取消任务
            </button>
          )}
          {busy ? (
            <button
              type='button'
              className='rounded-lg bg-gray-100 px-4 py-2 text-sm dark:bg-gray-800'
              onClick={() => controller.current?.abort()}
            >
              暂停
            </button>
          ) : (
            <button
              type='button'
              disabled={session?.status === 'failed'}
              onClick={() => void run()}
              className='rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50'
            >
              {session?.status === 'processing'
                ? '查看处理状态'
                : session
                ? '继续上传'
                : '开始上传'}
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}
