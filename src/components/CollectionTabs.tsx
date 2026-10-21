'use client';

import { useRouter } from 'next/navigation';

import { usePublicFavoritesEnabled } from '@/hooks/usePublicFavorites';

import CapsuleSwitch from './CapsuleSwitch';

export default function CollectionTabs({
  active,
}: {
  active: 'home' | 'favorites' | 'shared';
}) {
  const router = useRouter();
  const enabled = usePublicFavoritesEnabled();
  return (
    <CapsuleSwitch
      options={[
        { label: '首页', value: 'home' },
        { label: '收藏夹', value: 'favorites' },
        ...(enabled ? [{ label: '公共收藏', value: 'shared' }] : []),
      ]}
      active={active}
      onChange={(value) =>
        router.push(
          value === 'shared'
            ? '/shared'
            : value === 'favorites'
            ? '/?tab=favorites'
            : '/'
        )
      }
    />
  );
}
