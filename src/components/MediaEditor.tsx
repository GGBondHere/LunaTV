'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';

import { type MediaView, MEDIA_COVER_BYTES } from '@/lib/media';
import { mediaChanged, mediaJSON, mediaRequest } from '@/lib/media.client';

export default function MediaEditor({
  item,
  onClose,
}: {
  item: MediaView;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [cover, setCover] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!title.trim() || title.trim().length > 100)
        throw new Error('标题需要 1–100 个字符');
      if (cover)
        await mediaRequest(`/api/media/${item.id}/cover`, {
          method: 'PUT',
          headers: { 'Content-Type': cover.type },
          body: cover,
        });
      await mediaJSON(`/api/media/${item.id}`, 'PATCH', { title });
      mediaChanged();
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      mediaChanged();
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className='fixed inset-0 z-[11000] flex items-center justify-center bg-black/50 p-4'>
      <form
        role='dialog'
        aria-modal='true'
        aria-label='修改共享视频'
        className='w-full max-w-md space-y-4 rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900'
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className='text-lg font-semibold'>修改视频</h2>
        <label className='block text-sm'>
          标题
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={100}
            disabled={busy}
            className='mt-2 w-full rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-600'
          />
        </label>
        <label className='block text-sm'>
          更换封面
          <input
            type='file'
            accept='image/jpeg,image/png,image/webp'
            disabled={busy}
            className='mt-2 block w-full cursor-pointer rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700 transition-colors file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-green-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200'
            onChange={(event) => {
              const image = event.target.files?.[0] || null;
              if (image && image.size > MEDIA_COVER_BYTES) {
                event.target.value = '';
                setError('封面不能超过 5 MiB');
              } else {
                setCover(image);
                setError('');
              }
            }}
          />
        </label>
        {error && (
          <p role='alert' className='text-sm text-red-500'>
            {error}
          </p>
        )}
        <div className='flex justify-end gap-3'>
          <button
            type='button'
            disabled={busy}
            onClick={onClose}
            className='px-3 py-2 text-sm text-gray-500'
          >
            取消
          </button>
          <button
            disabled={busy}
            className='rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50'
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
