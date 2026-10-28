import { NextRequest } from 'next/server';

import {
  mediaAuth,
  mediaResponse,
  mediaRoute,
  putMediaCover,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  return mediaRoute(async () => {
    await putMediaCover(params.id, request, await mediaAuth(request), true);
    return mediaResponse({ ok: true });
  });
}
