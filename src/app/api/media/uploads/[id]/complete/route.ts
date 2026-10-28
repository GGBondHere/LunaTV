import { NextRequest } from 'next/server';

import {
  completeUpload,
  mediaAuth,
  mediaResponse,
  mediaRoute,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  return mediaRoute(async () =>
    mediaResponse(
      await completeUpload(params.id, await mediaAuth(request)),
      202
    )
  );
}
