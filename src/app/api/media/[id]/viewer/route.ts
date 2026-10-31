import { NextRequest } from 'next/server';

import {
  mediaAuth,
  mediaResponse,
  mediaRoute,
  mediaViewer,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  return mediaRoute(async () => {
    const auth = await mediaAuth(request);
    await mediaViewer(params.id, await request.json(), auth);
    return mediaResponse({ ok: true });
  });
}
