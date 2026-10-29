import { NextRequest } from 'next/server';

import {
  mediaAdminPolicy,
  mediaAuth,
  mediaResponse,
  mediaRoute,
  requireMediaAdmin,
  saveMediaSettings,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return mediaRoute(async () => {
    requireMediaAdmin(await mediaAuth(request));
    return mediaResponse(
      await mediaAdminPolicy(
        request.nextUrl.searchParams.get('refresh') === '1'
      )
    );
  });
}
export function PUT(request: NextRequest) {
  return mediaRoute(async () => {
    requireMediaAdmin(await mediaAuth(request));
    await saveMediaSettings(await request.json());
    return mediaResponse(await mediaAdminPolicy());
  });
}
