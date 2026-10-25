import { NextRequest, NextResponse } from 'next/server';

import { CHAT_ID } from '@/lib/social';
import { socialAuth, socialResponse, updatePresence } from '@/lib/social.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const auth = await socialAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { connection } = await request.json();
    if (typeof connection !== 'string' || !CHAT_ID.test(connection)) return socialResponse({ error: '连接无效' }, 400);
    const ok = await updatePresence('heartbeat', auth.username, connection);
    return socialResponse({ ok }, ok ? 200 : 409);
  } catch { return socialResponse({ error: '在线状态同步失败' }, 500); }
}
