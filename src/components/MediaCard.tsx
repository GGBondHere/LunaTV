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
  const play = () => {
    if (!item.pendingDeletion) router.push(`/media/${item.id}`);
  };
  const longPress = useLongPress({
    onLongPress: () => setMenu(true),
    onClick: play,
    longPressDelay: 500,
  });
  const actions = [
    ...(!item.pendingDeletion
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
    ...(item.canManage && !item.pendingDeletion
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
            label: item.pendingDeletion ? '重试清理' : '删除视频',
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
          aria-label={`播放 ${item.title}`}
          {...longPress}
          onClick={play}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              play();
            }
          }}
          className='relative aspect-video cursor-pointer overflow-hidden rounded-xl bg-gray-200 shadow-sm transition-shadow hover:shadow-lg dark:bg-gray-800'
        >
          {item.hasCover && !item.pendingDeletion ? (
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
            {item.pendingDeletion ? '等待清理' : mediaDuration(item.duration)}
          </span>
          {progress > 0 && !item.pendingDeletion && (
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
