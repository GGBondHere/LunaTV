import { NextRequest } from 'next/server';

import {
  beginUpload,
  mediaAuth,
  mediaResponse,
  mediaRoute,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: NextRequest) {
  return mediaRoute(async () => {
    const auth = await mediaAuth(request);
    return mediaResponse(await beginUpload(await request.json(), auth), 201);
  });
}
