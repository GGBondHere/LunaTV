'use client';

import { RefreshCw } from 'lucide-react';
import { Suspense } from 'react';

import { refreshPublicFavorites } from '@/lib/public-favorites.client';
import { usePublicFavorites } from '@/hooks/usePublicFavorites';

import CollectionTabs from '@/components/CollectionTabs';
import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

function SharedFavoritesClient() {
  const state = usePublicFavorites();
  const items = Object.entries(state.favorites).sort(
    ([, a], [, b]) => b.save_time - a.save_time
  );

  return (
    <PageLayout activePath='/shared'>
      <div className='px-2 sm:px-10 py-4 sm:py-8'>
        <div className='mb-8 flex justify-center'>
          <CollectionTabs active='shared' />
        </div>
        <section className='max-w-[95%] mx-auto mb-8'>
          <div className='mb-4 flex items-center justify-between'>
            <h1 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
              公共收藏
            </h1>
            {state.enabled && (
              <button
                type='button'
                onClick={() => {
                  void refreshPublicFavorites();
                }}
                disabled={state.loading}
                className='flex items-center gap-1 text-sm text-gray-500 hover:text-blue-500 disabled:opacity-50'
              >
                <RefreshCw
                  size={16}
                  className={state.loading ? 'animate-spin' : ''}
                />
                {state.loading ? '刷新中' : '刷新'}
              </button>
            )}
          </div>
          {!state.enabled ? (
            <p className='text-center text-gray-500 py-8'>
              公共收藏需要 Redis、Kvrocks 或 Upstash 服务端存储。
            </p>
          ) : (
            <>
              {state.error && (
                <div
                  role='alert'
                  className='mb-6 flex items-center gap-3 text-sm text-red-500'
                >
                  <span>{state.error}</span>
                  <button
                    type='button'
                    disabled={state.loading}
                    onClick={() => {
                      void refreshPublicFavorites();
                    }}
                    className='underline'
                  >
                    重试
                  </button>
                </div>
              )}
              {!state.loaded && !state.error && (
                <p className='text-center text-gray-500 py-8'>
                  正在加载公共收藏...
                </p>
              )}
              {state.loaded && items.length === 0 && (
                <p className='text-center text-gray-500 py-8'>
                  暂无公共收藏，可从视频菜单或播放页加入。
                </p>
              )}
              <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'>
                {items.map(([key, favorite]) => {
                  const separator = key.indexOf('+');
                  return (
                    <VideoCard
                      key={key}
                      from='public'
                      source={key.slice(0, separator)}
                      id={key.slice(separator + 1)}
                      title={favorite.title}
                      poster={favorite.cover}
                      year={favorite.year}
                      episodes={favorite.total_episodes}
                      source_name={favorite.source_name}
                      query={favorite.search_title}
                      type={favorite.total_episodes > 1 ? 'tv' : 'movie'}
                    />
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>
    </PageLayout>
  );
}

export default function SharedFavoritesPage() {
  return (
    <Suspense>
      <SharedFavoritesClient />
    </Suspense>
  );
}
