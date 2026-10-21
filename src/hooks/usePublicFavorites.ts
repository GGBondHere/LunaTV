'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  emptyPublicFavoritesState,
  getPublicFavoritesSnapshot,
  loadPublicFavorites,
  refreshPublicFavorites,
  subscribePublicFavorites,
  supportsPublicFavorites,
} from '@/lib/public-favorites.client';

const getEmptySnapshot = () => emptyPublicFavoritesState;
const subscribeInactive = () => () => undefined;

export function usePublicFavorites(active = true) {
  const state = useSyncExternalStore(
    active ? subscribePublicFavorites : subscribeInactive,
    active ? getPublicFavoritesSnapshot : getEmptySnapshot,
    getEmptySnapshot
  );
  useEffect(() => {
    if (active && state.enabled) void loadPublicFavorites();
  }, [active, state.account, state.enabled]);
  return state;
}

export function usePublicFavoritesEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => setEnabled(supportsPublicFavorites()), []);
  return enabled;
}

// 由页面容器触发一次刷新；卡片只共享读取，避免每张卡片重新请求。
export function usePublicFavoritesPageRefresh() {
  const pathname = usePathname();
  useEffect(() => {
    void refreshPublicFavorites();
  }, [pathname]);
}
