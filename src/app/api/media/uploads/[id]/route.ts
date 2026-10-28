import { NextRequest } from 'next/server';

import {
  appendUpload,
  cancelUpload,
  mediaAuth,
  mediaResponse,
  mediaRoute,
  uploadStatus,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: { id: string } };
export function GET(request: NextRequest, { params }: Context) {
  return mediaRoute(async () =>
    mediaResponse(await uploadStatus(params.id, await mediaAuth(request)))
  );
}
export function PATCH(request: NextRequest, { params }: Context) {
  return mediaRoute(async () =>
    mediaResponse(
      await appendUpload(params.id, request, await mediaAuth(request))
    )
  );
}
export function DELETE(request: NextRequest, { params }: Context) {
  return mediaRoute(async () => {
    await cancelUpload(params.id, await mediaAuth(request));
    return mediaResponse({ ok: true });
  });
}
