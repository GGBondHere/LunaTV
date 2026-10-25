import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
import type { ChatMessage } from '@/lib/social';
import { CHAT_ID, CHAT_TEXT_LIMIT, conversationId } from '@/lib/social';
import { chatHistory, notifySocial, socialAuth, socialResponse, validPeer } from '@/lib/social.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await socialAuth(request);
    if (auth instanceof NextResponse) return auth;
    const params = request.nextUrl.searchParams;
    const peer = params.get('peer');
    if (!validPeer(peer, auth)) return socialResponse({ error: '用户不存在或不可私信' }, 400);
    const after = params.has('after') ? Number(params.get('after')) : undefined;
    const before = params.has('before') ? Number(params.get('before')) : undefined;
    if ((after !== undefined && (!Number.isSafeInteger(after) || after < 0)) || (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) || (after !== undefined && before !== undefined)) return socialResponse({ error: '消息位置无效' }, 400);
    return socialResponse(await chatHistory(auth.username, peer, after, before));
  } catch { return socialResponse({ error: '获取私信失败，请重试' }, 500); }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await socialAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { peer, id, text } = await request.json();
    if (!validPeer(peer, auth) || typeof id !== 'string' || !CHAT_ID.test(id) || typeof text !== 'string' || !text.trim() || text.length > CHAT_TEXT_LIMIT) return socialResponse({ error: '消息无效，最多发送 2000 个字符' }, 400);
    const message = await db.socialCommand<ChatMessage>('send', { key: conversationId(auth.username, peer), user: auth.username, peer, id, text: text.trim(), now: Date.now() });
    // 先持久化再通知；网络重试仍使用原 ID，Lua 保证不会重复保存。
    notifySocial([auth.username, peer]);
    return socialResponse(message, 201);
  } catch { return socialResponse({ error: '发送失败，请重试' }, 500); }
}
