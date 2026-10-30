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
export async function PATCH(request: NextRequest, { params }: Context) {
  const started = performance.now();
  const timing: Record<string, number> = {};
  const response = await mediaRoute(async () => {
    const auth = await mediaAuth(request);
    timing.auth = performance.now() - started;
    return mediaResponse(await appendUpload(params.id, request, auth, timing));
  });
  timing.total = performance.now() - started;
  response.headers.set(
    'Server-Timing',
    Object.entries(timing)
      .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`)
      .join(', ')
  );
  const overhead = timing.total - (timing.receive || 0);
  if (timing.receive !== undefined && overhead >= 1000)
    // eslint-disable-next-line no-console
    console.warn('[media-upload] slow confirmation', {
      id: params.id,
      offset: request.headers.get('Upload-Offset'),
      status: response.status,
      milliseconds: Object.fromEntries(
        Object.entries(timing).map(([name, duration]) => [
          name,
          Math.round(duration),
        ])
      ),
    });
  return response;
}
export function DELETE(request: NextRequest, { params }: Context) {
  return mediaRoute(async () => {
    await cancelUpload(params.id, await mediaAuth(request));
    return mediaResponse({ ok: true });
  });
}
