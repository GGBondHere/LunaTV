'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  type MediaPolicy,
  formatMediaBytes,
  parseMediaSettings,
} from '@/lib/media';
import { mediaChanged, mediaJSON, mediaRequest } from '@/lib/media.client';

export default function MediaSettingsPanel() {
  const [policy, setPolicy] = useState<MediaPolicy | null>(null);
  const [draft, setDraft] = useState({
    allowUploads: true,
    quotaGiB: '70',
    maxFileGiB: '4',
    minFreeGiB: '10',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const apply = useCallback((value: MediaPolicy) => {
    setPolicy(value);
    setDraft({
      allowUploads: value.settings.allowUploads,
      quotaGiB: String(value.settings.quotaGiB),
      maxFileGiB: String(value.settings.maxFileGiB),
      minFreeGiB: String(value.settings.minFreeGiB),
    });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void mediaRequest<MediaPolicy>('/api/admin/media', {
      signal: controller.signal,
    })
      .then(apply)
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [apply]);
  const action = async (cleanup = false) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (cleanup) {
        apply(await mediaJSON<MediaPolicy>('/api/admin/media', 'DELETE'));
        setNotice('待清理文件已处理');
      } else {
        if (
          [draft.quotaGiB, draft.maxFileGiB, draft.minFreeGiB].some(
            (value) => !value.trim()
          )
        )
          throw new Error('容量设置不能为空');
        const settings = parseMediaSettings({
          allowUploads: draft.allowUploads,
          quotaGiB: Number(draft.quotaGiB),
          maxFileGiB: Number(draft.maxFileGiB),
          minFreeGiB: Number(draft.minFreeGiB),
        });
        apply(
          await mediaJSON<MediaPolicy>('/api/admin/media', 'PUT', settings)
        );
        setNotice('设置已生效');
      }
      mediaChanged();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className='space-y-4'
      onSubmit={(event) => {
        event.preventDefault();
        void action();
      }}
    >
      {policy && (
        <>
          <div className='grid gap-3 text-sm sm:grid-cols-2'>
            <p>已用：{formatMediaBytes(policy.usedBytes)}</p>
            <p>上传预留：{formatMediaBytes(policy.reservedBytes)}</p>
            <p>剩余可上传：{formatMediaBytes(policy.availableBytes)}</p>
            <p>磁盘空闲：{formatMediaBytes(policy.freeBytes)}</p>
          </div>
          {!policy.enabled && (
            <p
              role='status'
              className='rounded-lg bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
            >
              {policy.reason}。设置仍可预先保存。
            </p>
          )}
          {policy.overQuota && (
            <p className='text-sm text-amber-600'>
              已用和预留空间超过新额度，已停止新增上传；不会自动删除已有视频。
            </p>
          )}
        </>
      )}
      <label className='flex items-center gap-2 text-sm'>
        <input
          type='checkbox'
          checked={draft.allowUploads}
          disabled={busy || !policy}
          onChange={(event) =>
            setDraft({ ...draft, allowUploads: event.target.checked })
          }
        />
        允许上传
      </label>
      <div className='grid gap-4 sm:grid-cols-3'>
        {(['quotaGiB', 'maxFileGiB', 'minFreeGiB'] as const).map(
          (key, index) => (
            <label key={key} className='text-sm'>
              {['媒体库总额度', '单文件上限', '磁盘保留空间'][index]}（GiB）
              <input
                type='number'
                min={key === 'minFreeGiB' ? 1 : 0.001}
                step='any'
                value={draft[key]}
                disabled={busy || !policy}
                onChange={(event) =>
                  setDraft({ ...draft, [key]: event.target.value })
                }
                className='mt-2 w-full rounded-lg border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-600'
              />
            </label>
          )
        )}
      </div>
      <p className='text-xs leading-6 text-gray-500'>
        配置保存后实时生效。调低总额不清理视频；已预留任务可继续，关闭上传或触及磁盘保留空间时暂停。视频目录需单独备份，站点备份不含视频文件。
      </p>
      {error && (
        <p role='alert' className='text-sm text-red-500'>
          {error}
        </p>
      )}
      {notice && (
        <p role='status' className='text-sm text-green-600'>
          {notice}
        </p>
      )}
      <div className='flex gap-3'>
        <button
          type='submit'
          disabled={busy || !policy}
          className='rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'
        >
          {busy ? '处理中…' : '保存'}
        </button>
        <button
          type='button'
          disabled={busy || !policy?.enabled}
          onClick={() => void action(true)}
          className='rounded-lg bg-gray-100 px-4 py-2 text-sm hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:hover:bg-gray-700'
        >
          重试失败的文件清理
        </button>
      </div>
    </form>
  );
}
