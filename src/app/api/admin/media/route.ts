import { NextRequest } from 'next/server';

import {
  mediaAuth,
  mediaPolicy,
  mediaResponse,
  mediaRoute,
  requireMediaAdmin,
  retryMediaDeletes,
  saveMediaSettings,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  return mediaRoute(async () => {
    requireMediaAdmin(await mediaAuth(request));
    return mediaResponse(await mediaPolicy());
  });
}
export function PUT(request: NextRequest) {
  return mediaRoute(async () => {
    requireMediaAdmin(await mediaAuth(request));
    await saveMediaSettings(await request.json());
    return mediaResponse(await mediaPolicy());
  });
}
export function DELETE(request: NextRequest) {
  return mediaRoute(async () => {
    await retryMediaDeletes(await mediaAuth(request));
    return mediaResponse(await mediaPolicy());
  });
}
