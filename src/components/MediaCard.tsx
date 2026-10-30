'use client';

import {
  ExternalLink,
  Film,
  MoreHorizontal,
  Pencil,
  PlayCircle,
  Trash2,
} from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { type MediaView, mediaCover, mediaDuration } from '@/lib/media';
import { useLongPress } from '@/hooks/useLongPress';

import MobileActionSheet from './MobileActionSheet';

export default function MediaCard({
  item,
  progress,
  onEdit,
  onDelete,
}: {
  item: MediaView;
  progress: number;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const playable =
    !item.unavailable && !item.processing && !item.processingError;
  const play = () => {
    if (playable) router.push(`/media/${item.id}`);
  };
  const longPress = useLongPress({
    onLongPress: () => setMenu(true),
    onClick: play,
    longPressDelay: 500,
  });
  const actions = [
    ...(playable
      ? [
          {
            id: 'play',
            label: '播放',
            icon: <PlayCircle size={20} />,
            onClick: play,
            color: 'primary' as const,
          },
          {
            id: 'new-tab',
            label: '新标签页播放',
            icon: <ExternalLink size={20} />,
            onClick: () => {
              window.open(`/media/${item.id}`, '_blank', 'noopener');
            },
          },
        ]
      : []),
    ...(item.canManage
      ? [
          {
            id: 'edit',
            label: '修改标题和封面',
            icon: <Pencil size={20} />,
            onClick: onEdit,
          },
        ]
      : []),
    ...(item.canManage
      ? [
          {
            id: 'delete',
            label: '删除视频',
            icon: <Trash2 size={20} />,
            onClick: onDelete,
            color: 'danger' as const,
          },
        ]
      : []),
  ];
  return (
    <>
      <article
        className='group min-w-0'
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu(true);
        }}
      >
        <div
          role='button'
          tabIndex={0}
          aria-label={`${item.processing ? '处理中' : '播放'} ${item.title}`}
          aria-disabled={!playable}
          {...longPress}
          onClick={play}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              play();
            }
          }}
          className={`relative aspect-video overflow-hidden rounded-xl bg-gray-200 shadow-sm transition-shadow dark:bg-gray-800 ${
            playable ? 'cursor-pointer hover:shadow-lg' : 'cursor-default'
          }`}
        >
          {item.hasCover ? (
            <Image
              src={mediaCover(item)}
              alt={item.title}
              fill
              unoptimized
              sizes='(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw'
              className='object-cover transition-transform duration-300 group-hover:scale-105'
            />
          ) : (
            <div className='flex h-full items-center justify-center text-gray-400'>
              <Film size={42} />
            </div>
          )}
          <span className='absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white'>
            {item.processing
              ? '处理中'
              : item.processingError
              ? '处理失败'
              : item.unavailable
              ? '暂不可播放'
              : mediaDuration(item.duration)}
          </span>
          {progress > 0 && (
            <div
              className='absolute bottom-0 left-0 h-1 bg-green-500'
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          )}
        </div>
        <div className='mt-2 flex items-start justify-between gap-2'>
          <button
            type='button'
            className='min-w-0 text-left text-sm font-medium text-gray-800 dark:text-gray-200'
            onClick={play}
          >
            <span className='line-clamp-2 break-words'>{item.title}</span>
          </button>
          <button
            type='button'
            aria-label={`操作 ${item.title}`}
            className='rounded-lg p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
            onClick={() => setMenu(true)}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
        {item.processingError && (
          <p className='mt-1 text-xs text-red-500'>{item.processingError}</p>
        )}
      </article>
      <MobileActionSheet
        isOpen={menu}
        onClose={() => setMenu(false)}
        title={item.title}
        poster={mediaCover(item)}
        actions={actions}
      />
    </>
  );
}
