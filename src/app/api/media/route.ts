import { NextRequest } from 'next/server';

import {
  mediaAuth,
  mediaItems,
  mediaList,
  mediaResponse,
  mediaRoute,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return mediaRoute(async () => {
    const auth = await mediaAuth(request);
    if (request.nextUrl.searchParams.get('items') === '1')
      return mediaResponse({
        items: await mediaItems(
          auth,
          request.nextUrl.searchParams.get('mine') === '1'
        ),
      });
    return mediaResponse(
      await mediaList(auth, request.nextUrl.searchParams.get('mine') === '1')
    );
  });
}
