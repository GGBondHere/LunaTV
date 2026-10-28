import { NextRequest } from 'next/server';

import { mediaAuth, mediaRoute, serveMedia } from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  return mediaRoute(async () => {
    await mediaAuth(request);
    return serveMedia(params.id, request, false);
  });
}
export const HEAD = GET;
