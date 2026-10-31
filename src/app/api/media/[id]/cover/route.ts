import { NextRequest } from 'next/server';

import {
  mediaAuth,
  mediaResponse,
  mediaRoute,
  putMediaCover,
  serveMedia,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: { id: string } };
export function GET(request: NextRequest, { params }: Context) {
  return mediaRoute(async () => {
    const auth = await mediaAuth(request);
    return serveMedia(params.id, request, true, auth);
  });
}
export const HEAD = GET;
export function PUT(request: NextRequest, { params }: Context) {
  return mediaRoute(async () => {
    await putMediaCover(params.id, request, await mediaAuth(request), false);
    return mediaResponse({ ok: true });
  });
}
