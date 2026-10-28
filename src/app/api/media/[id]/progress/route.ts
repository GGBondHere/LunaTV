import { NextRequest } from 'next/server';

import { db } from '@/lib/db';
import { MEDIA_SOURCE } from '@/lib/media';
import {
  getMedia,
  mediaAuth,
  mediaResponse,
  mediaRoute,
  saveMediaProgress,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: { id: string } };
export function GET(request: NextRequest, { params }: Context) {
  return mediaRoute(async () => {
    const auth = await mediaAuth(request);
    await getMedia(params.id, auth);
    return mediaResponse(
      await db.getPlayRecord(auth.username, MEDIA_SOURCE, params.id)
    );
  });
}
export function POST(request: NextRequest, { params }: Context) {
  return mediaRoute(async () => {
    const auth = await mediaAuth(request);
    return mediaResponse(
      await saveMediaProgress(params.id, auth.username, await request.json())
    );
  });
}
