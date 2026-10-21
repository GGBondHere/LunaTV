'use client';

import { Users } from 'lucide-react';

import {
  refreshPublicFavorites,
  togglePublicFavorite,
} from '@/lib/public-favorites.client';
import type { PublicFavoriteInput } from '@/lib/types';
import { usePublicFavorites } from '@/hooks/usePublicFavorites';

interface PublicFavoriteButtonProps {
  source: string;
  id: string;
  favorite: PublicFavoriteInput;
  compact?: boolean;
  disabled?: boolean;
}

export default function PublicFavoriteButton({
  source,
  id,
  favorite,
  compact = false,
  disabled = false,
}: PublicFavoriteButtonProps) {
  const state = usePublicFavorites();
  if (!state.enabled) return null;
  const key = `${source}+${id}`;
  const existing = state.favorites[key];
  const pending = state.pendingKeys.has(key);
  const label = state.error
    ? '公共收藏加载失败，点击重试'
    : !state.loaded
    ? '公共收藏加载中...'
    : existing
    ? existing.canDelete
      ? '移出公共收藏'
      : '已加入公共收藏'
    : '加入公共收藏';

  return (
    <button
      type='button'
      data-button='true'
      title={label}
      aria-label={label}
      aria-pressed={!!existing}
      disabled={
        disabled ||
        pending ||
        (!state.loaded && !state.error) ||
        (!!existing && !existing.canDelete && !state.error)
      }
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.error) void refreshPublicFavorites();
        else void togglePublicFavorite(key, favorite);
      }}
      className={`flex-shrink-0 transition-colors hover:opacity-80 disabled:cursor-default disabled:opacity-60 ${
        existing
          ? 'text-blue-500'
          : compact
          ? 'text-white hover:text-blue-400'
          : 'text-blue-500/70 hover:text-blue-500'
      }`}
    >
      <Users
        size={compact ? 20 : 28}
        fill={existing ? 'currentColor' : 'none'}
        fillOpacity={0.2}
      />
    </button>
  );
}
