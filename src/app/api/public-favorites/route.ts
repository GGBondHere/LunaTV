/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  parsePublicFavoriteInput,
  parsePublicFavoriteKey,
} from '@/lib/public-favorites';
import type { PublicFavoriteView } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function respond(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

async function authenticate(request: NextRequest) {
  if (
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage'
  ) {
    return respond({ error: '公共收藏需要服务端存储' }, 400);
  }
  // Cookie 签名由 middleware 验证；角色和封禁状态以服务端配置为准。
  const username = getAuthInfoFromCookie(request)?.username;
  if (!username) return respond({ error: '未登录' }, 401);
  const config = await getConfig();
  const user = config.UserConfig.Users.find(
    (item) => item.username === username
  );
  if (username !== process.env.USERNAME && (!user || user.banned)) {
    return respond({ error: '用户不存在或已被封禁' }, 401);
  }
  return {
    username,
    isAdmin:
      username === process.env.USERNAME ||
      user?.role === 'admin' ||
      user?.role === 'owner',
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    if (auth instanceof NextResponse) return auth;
    const favorites = await db.getAllPublicFavorites();
    const result: Record<string, PublicFavoriteView> = {};
    for (const [key, favorite] of Object.entries(favorites)) {
      const metadata = parsePublicFavoriteInput(favorite);
      if (!metadata) continue;
      result[key] = {
        ...metadata,
        save_time: favorite.save_time,
        canDelete: auth.isAdmin || favorite.addedBy === auth.username,
      };
    }
    return respond(result);
  } catch (error) {
    console.error('获取公共收藏失败', error);
    return respond({ error: '获取公共收藏失败' }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    if (auth instanceof NextResponse) return auth;
    const body = await request.json().catch(() => null);
    const parsedKey = parsePublicFavoriteKey(body?.key);
    const favorite = parsePublicFavoriteInput(body?.favorite);
    if (!parsedKey || !favorite)
      return respond({ error: '公共收藏参数无效' }, 400);
    const sources = await getAvailableApiSites(auth.username);
    if (!sources.some((source) => source.key === parsedKey.source)) {
      return respond({ error: '无权使用该播放源或播放源已失效' }, 403);
    }
    const created = await db.addPublicFavorite(body.key, {
      ...favorite,
      addedBy: auth.username,
      save_time: Date.now(),
    });
    return respond({ created }, created ? 201 : 200);
  } catch (error) {
    console.error('添加公共收藏失败', error);
    return respond({ error: '添加公共收藏失败' }, 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await authenticate(request);
    if (auth instanceof NextResponse) return auth;
    const key = request.nextUrl.searchParams.get('key');
    if (!key || !parsePublicFavoriteKey(key)) {
      return respond({ error: '请指定有效的公共收藏条目' }, 400);
    }
    const result = await db.deletePublicFavorite(
      key,
      auth.username,
      auth.isAdmin
    );
    if (result === 'forbidden')
      return respond({ error: '只能移除本人添加的公共收藏' }, 403);
    return respond({ success: true });
  } catch (error) {
    console.error('移除公共收藏失败', error);
    return respond({ error: '移除公共收藏失败' }, 500);
  }
}
