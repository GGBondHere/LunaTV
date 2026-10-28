'use client';

import { RefreshCw, Upload } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import {
  type PlayRecord,
  getAllPlayRecords,
  syncMediaProgressCache,
} from '@/lib/db.client';
import {
  type MediaList,
  type MediaView,
  formatMediaBytes,
  MEDIA_SOURCE,
} from '@/lib/media';
import {
  currentMediaAccount,
  mediaChanged,
  mediaJSON,
  mediaRequest,
} from '@/lib/media.client';
import { useMediaEnabled } from '@/hooks/useMediaEnabled';

import CollectionTabs from '@/components/CollectionTabs';
import MediaCard from '@/components/MediaCard';
import MediaEditor from '@/components/MediaEditor';
import MediaUploader from '@/components/MediaUploader';
import PageLayout from '@/components/PageLayout';

function MediaLibrary() {
  const [data, setData] = useState<MediaList | null>(null);
  const [progress, setProgress] = useState<Record<string, PlayRecord>>({});
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [upload, setUpload] = useState(false);
  const [editing, setEditing] = useState<MediaView | null>(null);
  const request = useRef<AbortController>();
  const version = useRef(0);
  const deleting = useRef(new Set<string>());
  const enabled = useMediaEnabled();
  const refresh = useCallback(async () => {
    if (!enabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const generation = ++version.current;
    const account = currentMediaAccount();
    setLoading(true);
    try {
      const [list, records] = await Promise.all([
        mediaRequest<MediaList>(`/api/media${mine ? '?mine=1' : ''}`, {
          signal: controller.signal,
        }),
        getAllPlayRecords(),
      ]);
      if (
        controller.signal.aborted ||
        generation !== version.current ||
        account !== currentMediaAccount()
      )
        return;
      setData(list);
      setProgress(records);
      setError('');
    } catch (failure) {
      if (!controller.signal.aborted && generation === version.current)
        setError((failure as Error).message);
    } finally {
      if (!controller.signal.aborted && generation === version.current)
        setLoading(false);
    }
  }, [enabled, mine]);
  useEffect(() => {
    void refresh();
    const update = () => {
      void refresh();
    };
    window.addEventListener('focus', update);
    window.addEventListener('mediaUpdated', update);
    return () => {
      request.current?.abort();
      window.removeEventListener('focus', update);
      window.removeEventListener('mediaUpdated', update);
    };
  }, [refresh]);
  const remove = async (item: MediaView) => {
    if (
      deleting.current.has(item.id) ||
      !window.confirm(
        item.pendingDeletion
          ? '重试清理该视频的剩余文件？'
          : `删除“${item.title}”？所有人将无法继续观看，文件会从服务器移除。`
      )
    )
      return;
    deleting.current.add(item.id);
    const account = currentMediaAccount();
    try {
      await mediaJSON(`/api/media/${item.id}`, 'DELETE');
      syncMediaProgressCache(item.id, null, account);
      setActionError('');
    } catch (failure) {
      setActionError((failure as Error).message);
    } finally {
      deleting.current.delete(item.id);
      mediaChanged();
    }
  };
  const items = (data?.items || []).filter((item) =>
    item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  return (
    <PageLayout activePath='/media'>
      <div className='px-3 py-4 sm:px-10 sm:py-8'>
        <div className='mb-8 flex justify-center overflow-x-auto'>
          <CollectionTabs active='media' />
        </div>
        <section className='mx-auto max-w-[95%]'>
          <div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
            <h1 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
              共享视频
            </h1>
            <div className='flex items-center gap-3'>
              <button
                type='button'
                onClick={() => void refresh()}
                disabled={loading || !enabled}
                className='flex items-center gap-1 text-sm text-gray-500 disabled:opacity-50'
              >
                <RefreshCw
                  size={16}
                  className={loading ? 'animate-spin' : ''}
                />
                刷新
              </button>
              <button
                type='button'
                disabled={
                  !data?.policy.enabled ||
                  (!data.policy.settings.allowUploads && !data.upload)
                }
                onClick={() => setUpload(true)}
                className='flex items-center gap-1 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50'
              >
                <Upload size={16} />
                {data?.upload ? '继续上传' : '上传视频'}
              </button>
            </div>
          </div>
          {!enabled ? (
            <p className='py-10 text-center text-gray-500'>
              {enabled === null
                ? '正在加载共享视频…'
                : '共享视频需要服务端用户存储和持久化目录，请由管理员配置。'}
            </p>
          ) : (
            <>
              {data && (
                <div className='mb-5 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900'>
                  {data.policy.enabled ? (
                    <>
                      已用 {formatMediaBytes(data.policy.usedBytes)} /{' '}
                      {data.policy.settings.quotaGiB} GiB · 上传预留{' '}
                      {formatMediaBytes(data.policy.reservedBytes)} · 还可上传{' '}
                      {formatMediaBytes(data.policy.availableBytes)}
                      {!data.policy.settings.allowUploads && (
                        <p className='mt-1 text-amber-600'>
                          管理员已暂停上传，已发布视频仍可观看。
                        </p>
                      )}
                      {data.policy.overQuota && (
                        <p className='mt-1 text-amber-600'>
                          共享空间已超额，停止新增上传，不影响已有视频。
                        </p>
                      )}
                    </>
                  ) : (
                    data.policy.reason
                  )}
                </div>
              )}
              <div className='mb-5 flex flex-wrap gap-3'>
                <div className='flex rounded-lg bg-gray-100 p-1 text-sm dark:bg-gray-800'>
                  {[false, true].map((value) => (
                    <button
                      key={String(value)}
                      type='button'
                      className={`rounded-md px-3 py-1 ${
                        mine === value
                          ? 'bg-white text-green-600 shadow-sm dark:bg-gray-700 dark:text-green-400'
                          : 'text-gray-500'
                      }`}
                      onClick={() => setMine(value)}
                    >
                      {value ? '我的上传' : '全部'}
                    </button>
                  ))}
                </div>
                <input
                  aria-label='搜索共享视频标题'
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder='搜索标题'
                  className='min-w-0 flex-1 rounded-lg border border-gray-300 bg-transparent px-3 py-2 text-sm sm:max-w-xs dark:border-gray-600'
                />
              </div>
              {error && (
                <div
                  role='alert'
                  className='mb-4 flex gap-3 text-sm text-red-500'
                >
                  {error}
                  <button
                    type='button'
                    onClick={() => void refresh()}
                    className='flex-shrink-0 underline'
                  >
                    重试
                  </button>
                </div>
              )}
              {actionError && (
                <p role='alert' className='mb-4 text-sm text-red-500'>
                  {actionError}
                </p>
              )}
              {!data && loading && (
                <p className='py-10 text-center text-gray-500'>
                  正在加载共享视频…
                </p>
              )}
              {data?.policy.enabled && !items.length && (
                <p className='py-10 text-center text-gray-500'>
                  {query
                    ? '没有匹配的视频'
                    : mine
                    ? '你还没有上传视频'
                    : '还没有共享视频，上传一个和朋友一起看吧'}
                </p>
              )}
              <div className='grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'>
                {items.map((item) => {
                  const record = progress[`${MEDIA_SOURCE}+${item.id}`];
                  return (
                    <MediaCard
                      key={item.id}
                      item={item}
                      progress={
                        record?.total_time
                          ? (record.play_time / record.total_time) * 100
                          : 0
                      }
                      onEdit={() => setEditing(item)}
                      onDelete={() => remove(item)}
                    />
                  );
                })}
              </div>
            </>
          )}
        </section>
        {upload && (
          <MediaUploader
            initial={data?.upload || null}
            onClose={() => {
              setUpload(false);
              void refresh();
            }}
          />
        )}
        {editing && (
          <MediaEditor
            item={editing}
            onClose={() => {
              setEditing(null);
              void refresh();
            }}
          />
        )}
      </div>
    </PageLayout>
  );
}
export default function MediaPage() {
  return (
    <Suspense>
      <MediaLibrary />
    </Suspense>
  );
}
