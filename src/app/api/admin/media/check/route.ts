import { NextRequest } from 'next/server';

import {
  checkMediaConnection,
  mediaAuth,
  mediaResponse,
  mediaRoute,
  requireMediaAdmin,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: NextRequest) {
  return mediaRoute(async () => {
    requireMediaAdmin(await mediaAuth(request));
    const { connectionId, connection } = await request.json();
    if (typeof connectionId !== 'string')
      return mediaResponse({ error: '请选择连接' }, 400);
    return mediaResponse(
      await checkMediaConnection(connectionId, connection, request.signal)
    );
  });
}
