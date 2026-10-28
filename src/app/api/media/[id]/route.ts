import { NextRequest } from 'next/server';

import {
  deleteMedia,
  editMedia,
  getMedia,
  mediaAuth,
  mediaResponse,
  mediaRoute,
} from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: { id: string } };
export function GET(request: NextRequest, { params }: Context) {
  return mediaRoute(async () =>
    mediaResponse(await getMedia(params.id, await mediaAuth(request)))
  );
}
export function PATCH(request: NextRequest, { params }: Context) {
  return mediaRoute(async () => {
    const auth = await mediaAuth(request);
    return mediaResponse(
      await editMedia(params.id, (await request.json()).title, auth)
    );
  });
}
export function DELETE(request: NextRequest, { params }: Context) {
  return mediaRoute(async () => {
    await deleteMedia(params.id, await mediaAuth(request));
    return mediaResponse({ ok: true });
  });
}
