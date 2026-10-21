import type { PublicFavorite, PublicFavoriteInput } from './types';

export const PUBLIC_FAVORITES_KEY = 'shared:favorites:site';

// 在同一次原子操作中检查归属并删除，防止并发删除/重新添加改变归属。
export const DELETE_PUBLIC_FAVORITE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local favorite = cjson.decode(raw)
if ARGV[3] ~= '1' and favorite.addedBy ~= ARGV[2] then return -1 end
return redis.call('HDEL', KEYS[1], ARGV[1])
`;

export function parsePublicFavoriteKey(key: unknown): {
  source: string;
  id: string;
} | null {
  if (typeof key !== 'string') return null;
  const separator = key.indexOf('+');
  if (separator <= 0) return null;
  const source = key.slice(0, separator);
  const id = key.slice(separator + 1);
  return /^[\w-]+$/.test(id) ? { source, id } : null;
}

export function parsePublicFavoriteInput(
  value: unknown
): PublicFavoriteInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.title !== 'string' ||
    !item.title.trim() ||
    typeof item.source_name !== 'string' ||
    typeof item.year !== 'string' ||
    typeof item.cover !== 'string' ||
    (item.search_title !== undefined &&
      typeof item.search_title !== 'string') ||
    typeof item.total_episodes !== 'number' ||
    !Number.isSafeInteger(item.total_episodes) ||
    item.total_episodes < 1 ||
    (item.origin !== undefined && item.origin !== 'vod')
  )
    return null;

  // 显式挑选允许的字段，不接受客户端提供的添加者、时间或权限。
  return {
    title: item.title.trim(),
    source_name: item.source_name,
    year: item.year,
    cover: item.cover,
    total_episodes: item.total_episodes,
    search_title:
      typeof item.search_title === 'string' ? item.search_title : '',
  };
}

export function parsePublicFavoritesBackup(
  value: unknown
): Record<string, PublicFavorite> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('备份中的公共收藏格式无效');
  }
  const result: Record<string, PublicFavorite> = {};
  for (const [key, raw] of Object.entries(value)) {
    const favorite = parsePublicFavoriteInput(raw);
    const item = raw as Partial<PublicFavorite> | null;
    if (
      !parsePublicFavoriteKey(key) ||
      !favorite ||
      !item ||
      typeof item.addedBy !== 'string' ||
      !item.addedBy.trim() ||
      typeof item.save_time !== 'number' ||
      !Number.isFinite(item.save_time) ||
      item.save_time < 0
    )
      throw new Error('备份中的公共收藏条目无效');
    result[key] = {
      ...favorite,
      addedBy: item.addedBy,
      save_time: item.save_time,
    };
  }
  return result;
}
