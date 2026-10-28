import { NextRequest } from 'next/server';

import {
  mediaAuth,
  mediaList,
  mediaResponse,
  mediaRoute,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return mediaRoute(async () => {
    const auth = await mediaAuth(request);
    return mediaResponse(
      await mediaList(auth, request.nextUrl.searchParams.get('mine') === '1')
    );
  });
}
