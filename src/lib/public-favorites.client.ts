'use client';

import { triggerGlobalError } from '@/components/GlobalErrorIndicator';

import { getAuthInfoFromBrowserCookie } from './auth';
import type { PublicFavoriteInput, PublicFavoriteView } from './types';

export function supportsPublicFavorites(): boolean {
  if (typeof window === 'undefined') return false;
  const config = (
    window as Window & { RUNTIME_CONFIG?: { STORAGE_TYPE?: string } }
  ).RUNTIME_CONFIG;
  return ['redis', 'kvrocks', 'upstash'].includes(
    config?.STORAGE_TYPE || 'localstorage'
  );
}

interface PublicFavoritesState {
  account: string | null;
  enabled: boolean;
  favorites: Record<string, PublicFavoriteView>;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  pendingKeys: ReadonlySet<string>;
}

export const emptyPublicFavoritesState: PublicFavoritesState = {
  account: null,
  enabled: false,
  favorites: {},
  loaded: false,
  loading: false,
  error: null,
  pendingKeys: new Set(),
};

let state = emptyPublicFavoritesState;
let revision = 0;
let session = 0;
let readPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function account() {
  return supportsPublicFavorites()
    ? getAuthInfoFromBrowserCookie()?.username || null
    : null;
}

function syncAccount() {
  const current = account();
  if (state.account !== current) {
    session++;
    revision++;
    readPromise = null;
    state = {
      ...emptyPublicFavoritesState,
      account: current,
      enabled: !!current,
    };
  }
}

function update(patch: Partial<PublicFavoritesState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function getPublicFavoritesSnapshot() {
  syncAccount();
  return state;
}

export function subscribePublicFavorites(listener: () => void) {
  syncAccount();
  if (listeners.size === 0) window.addEventListener('focus', handleFocus);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('focus', handleFocus);
  };
}

function handleFocus() {
  void refreshPublicFavorites();
}

async function request(path: string, options?: RequestInit): Promise<Response> {
  const requestAccount = account();
  const requestSession = session;
  const response = await fetch(path, { ...options, cache: 'no-store' });
  if (requestSession !== session || account() !== requestAccount) {
    throw new Error('账号已切换，已忽略旧请求');
  }
  if (response.ok) return response;
  if (response.status === 401) {
    await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
    const remainingAccount = account();
    if (
      requestSession === session &&
      (!remainingAccount || remainingAccount === requestAccount)
    ) {
      session++;
      revision++;
      readPromise = null;
      update({ ...emptyPublicFavoritesState, account: remainingAccount });
      window.location.assign(
        `/login?redirect=${encodeURIComponent(
          window.location.pathname + window.location.search
        )}`
      );
    }
  }
  const body = await response.json().catch(() => null);
  throw new Error(body?.error || `公共收藏请求失败 (${response.status})`);
}

export function refreshPublicFavorites(): Promise<void> {
  syncAccount();
  if (!state.enabled) return Promise.resolve();
  if (readPromise) return readPromise;
  const currentAccount = state.account;
  const currentRevision = revision;
  const isCurrent = () =>
    currentRevision === revision && account() === currentAccount;
  update({ loading: true, error: null });
  const operation = (async () => {
    try {
      const response = await request('/api/public-favorites');
      const favorites = (await response.json()) as Record<
        string,
        PublicFavoriteView
      >;
      if (isCurrent()) update({ favorites, loaded: true });
    } catch (error) {
      if (isCurrent())
        update({
          error: error instanceof Error ? error.message : '获取公共收藏失败',
        });
    } finally {
      if (isCurrent()) {
        readPromise = null;
        update({ loading: false });
      }
    }
  })();
  readPromise = operation;
  return operation;
}

export function loadPublicFavorites() {
  syncAccount();
  return state.loaded ? Promise.resolve() : refreshPublicFavorites();
}

export async function togglePublicFavorite(
  key: string,
  favorite: PublicFavoriteInput
): Promise<void> {
  syncAccount();
  if (
    !state.enabled ||
    !state.loaded ||
    state.error ||
    state.pendingKeys.has(key)
  )
    return;
  const existing = state.favorites[key];
  if (existing && !existing.canDelete) return;
  const currentAccount = state.account;
  const currentSession = session;
  const pending = new Set(state.pendingKeys);
  pending.add(key);
  update({ pendingKeys: pending });
  const isCurrent = () =>
    currentSession === session && account() === currentAccount;
  try {
    await request(
      existing
        ? `/api/public-favorites?key=${encodeURIComponent(key)}`
        : '/api/public-favorites',
      {
        method: existing ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(existing ? {} : { body: JSON.stringify({ key, favorite }) }),
      }
    );
    if (!isCurrent()) return;
    // 废弃写入前发出的读取，不能让旧列表覆盖本次写入后的刷新。
    revision++;
    readPromise = null;
    await refreshPublicFavorites();
    if (isCurrent() && state.error) triggerGlobalError(state.error);
  } catch (error) {
    if (isCurrent()) {
      triggerGlobalError(
        error instanceof Error ? error.message : '公共收藏操作失败'
      );
      // 权限或归属可能已经改变，保留原列表并重新获取服务端状态。
      revision++;
      readPromise = null;
      await refreshPublicFavorites();
    }
  } finally {
    if (isCurrent()) {
      const pendingKeys = new Set(state.pendingKeys);
      pendingKeys.delete(key);
      update({ pendingKeys });
    }
  }
}
