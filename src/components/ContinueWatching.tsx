/* eslint-disable no-console */
'use client';

import { useEffect, useRef, useState } from 'react';

import type { PlayRecord } from '@/lib/db.client';
import {
  clearAllPlayRecords,
  getAllPlayRecords,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { type MediaList, type MediaView,MEDIA_SOURCE, mediaCover, mediaEnabled } from '@/lib/media';
import { currentMediaAccount, mediaRequest } from '@/lib/media.client';

import ScrollableRow from '@/components/ScrollableRow';
import VideoCard from '@/components/VideoCard';

interface ContinueWatchingProps {
  className?: string;
}

export default function ContinueWatching({ className }: ContinueWatchingProps) {
  const [playRecords, setPlayRecords] = useState<
    (PlayRecord & { key: string })[]
  >([]);
  const [loading, setLoading] = useState(true);
  const media = useRef(new Map<string, MediaView>());

  // 处理播放记录数据更新的函数
  const updatePlayRecords = (allRecords: Record<string, PlayRecord>) => {
    // 将记录转换为数组并根据 save_time 由近到远排序
    const recordsArray = Object.entries(allRecords).flatMap(([key, record]) => {
      if (!key.startsWith(`${MEDIA_SOURCE}+`)) return [{ ...record, key }];
      const item = media.current.get(key.slice(MEDIA_SOURCE.length + 1));
      return item ? [{ ...record, key, origin: 'upload' as const, title: item.title, cover: mediaCover(item) }] : [];
    });

    // 按 save_time 降序排序（最新的在前面）
    const sortedRecords = recordsArray.sort(
      (a, b) => b.save_time - a.save_time
    );

    setPlayRecords(sortedRecords);
  };

  useEffect(() => {
    let active = true;
    let generation = 0;
    let metadataGeneration = 0;
    let metadataLoading: Promise<void> | null = null;
    let latestRecords: Record<string, PlayRecord> = {};
    const controller = new AbortController();
    const fetchPlayRecords = async () => {
      const version = ++generation;
      const account = currentMediaAccount();
      try {

        // 从缓存或API获取所有播放记录
        const allRecords = await getAllPlayRecords();
        if (!active || version !== generation || account !== currentMediaAccount()) return;
        if (mediaEnabled() && Object.keys(allRecords).some((key) => key.startsWith(`${MEDIA_SOURCE}+`))) {
          const metadataVersion = ++metadataGeneration;
          const list = await mediaRequest<MediaList>('/api/media', { signal: controller.signal }).catch(() => null);
          if (!active || version !== generation || metadataVersion !== metadataGeneration || account !== currentMediaAccount()) return;
          media.current = new Map((list?.items || []).filter((item) => !item.pendingDeletion).map((item) => [item.id, item]));
        }
        if (!active || version !== generation || account !== currentMediaAccount()) return;
        updatePlayRecords(allRecords);
      } catch (error) {
        console.error('获取播放记录失败:', error);
        if (active && version === generation) setPlayRecords([]);
      } finally {
        if (active && version === generation) setLoading(false);
      }
    };

    fetchPlayRecords();
    const refresh = () => { void fetchPlayRecords(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('mediaUpdated', refresh);

    // 监听播放记录更新事件
    const unsubscribe = subscribeToDataUpdates(
      'playRecordsUpdated',
      (newRecords: Record<string, PlayRecord>) => {
        if (!active) return;
        latestRecords = newRecords;
        ++generation;
        const missing = mediaEnabled() && Object.keys(newRecords).some((key) => key.startsWith(`${MEDIA_SOURCE}+`) && !media.current.has(key.slice(MEDIA_SOURCE.length + 1)));
        if (!missing) { updatePlayRecords(newRecords); setLoading(false); return; }
        if (metadataLoading) return;
        const account = currentMediaAccount();
        const metadataVersion = ++metadataGeneration;
        metadataLoading = mediaRequest<MediaList>('/api/media', { signal: controller.signal })
          .then((list) => {
            if (!active || metadataVersion !== metadataGeneration || account !== currentMediaAccount()) return;
            media.current = new Map(list.items.filter((item) => !item.pendingDeletion).map((item) => [item.id, item]));
            updatePlayRecords(latestRecords);
          })
          .catch(() => { if (active && account === currentMediaAccount()) updatePlayRecords(latestRecords); })
          .finally(() => { metadataLoading = null; if (active && account === currentMediaAccount()) setLoading(false); });
      }
    );

    return () => { active = false; controller.abort(); unsubscribe(); window.removeEventListener('focus', refresh); window.removeEventListener('mediaUpdated', refresh); };
  }, []);

  // 如果没有播放记录，则不渲染组件
  if (!loading && playRecords.length === 0) {
    return null;
  }

  // 计算播放进度百分比
  const getProgress = (record: PlayRecord) => {
    if (record.total_time === 0) return 0;
    return (record.play_time / record.total_time) * 100;
  };

  // 从 key 中解析 source 和 id
  const parseKey = (key: string) => {
    const [source, id] = key.split('+');
    return { source, id };
  };

  return (
    <section className={`mb-8 ${className || ''}`}>
      <div className='mb-4 flex items-center justify-between'>
        <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
          继续观看
        </h2>
        {!loading && playRecords.length > 0 && (
          <button
            className='text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            onClick={async () => {
              await clearAllPlayRecords();
              setPlayRecords([]);
            }}
          >
            清空
          </button>
        )}
      </div>
      <ScrollableRow>
        {loading
          ? // 加载状态显示灰色占位数据
            Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
              >
                <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800'>
                  <div className='absolute inset-0 bg-gray-300 dark:bg-gray-700'></div>
                </div>
                <div className='mt-2 h-4 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
                <div className='mt-1 h-3 bg-gray-200 rounded animate-pulse dark:bg-gray-800'></div>
              </div>
            ))
          : // 显示真实数据
            playRecords.map((record) => {
              const { source, id } = parseKey(record.key);
              return (
                <div
                  key={record.key}
                  className='min-w-[96px] w-24 sm:min-w-[180px] sm:w-44'
                >
                  <VideoCard
                    id={id}
                    title={record.title}
                    poster={record.cover}
                    year={record.year}
                    source={source}
                    source_name={record.source_name}
                    progress={getProgress(record)}
                    episodes={record.total_episodes}
                    currentEpisode={record.index}
                    query={record.search_title}
                    origin={record.origin}
                    from='playrecord'
                    onDelete={() =>
                      setPlayRecords((prev) =>
                        prev.filter((r) => r.key !== record.key)
                      )
                    }
                    type={record.total_episodes > 1 ? 'tv' : ''}
                  />
                </div>
              );
            })}
      </ScrollableRow>
    </section>
  );
}
