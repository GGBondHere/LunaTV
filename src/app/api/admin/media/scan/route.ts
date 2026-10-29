import { NextRequest } from 'next/server';

import {
  beginMediaScan,
  mediaAdminPolicy,
  mediaAuth,
  mediaResponse,
  mediaRoute,
  requireMediaAdmin,
  stopMediaScan,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return mediaRoute(async () => {
    requireMediaAdmin(await mediaAuth(request));
    return mediaResponse((await mediaAdminPolicy()).scans);
  });
}
export function POST(request: NextRequest) {
  return mediaRoute(async () => {
    requireMediaAdmin(await mediaAuth(request));
    const { connectionId } = await request.json();
    if (typeof connectionId !== 'string')
      return mediaResponse({ error: '请选择连接' }, 400);
    return mediaResponse(await beginMediaScan(connectionId), 202);
  });
}
export function DELETE(request: NextRequest) {
  return mediaRoute(async () => {
    requireMediaAdmin(await mediaAuth(request));
    const { connectionId } = await request.json();
    if (typeof connectionId !== 'string')
      return mediaResponse({ error: '请选择连接' }, 400);
    return mediaResponse(await stopMediaScan(connectionId));
  });
}
