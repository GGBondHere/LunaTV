import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { conversationId } from '@/lib/social';
import { notifySocial, socialAuth, socialResponse, validPeer } from '@/lib/social.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const auth = await socialAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { peer, seq } = await request.json();
    if (!validPeer(peer, auth) || !Number.isSafeInteger(seq) || seq < 0) return socialResponse({ error: '已读位置无效' }, 400);
    const result = await db.socialCommand('read', { user: auth.username, key: conversationId(auth.username, peer), seq });
    notifySocial([auth.username]);
    return socialResponse(result);
  } catch { return socialResponse({ error: '更新已读状态失败' }, 500); }
}
