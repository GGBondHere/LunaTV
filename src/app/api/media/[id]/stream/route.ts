import { NextRequest } from 'next/server';

import { mediaAuth, mediaRoute, serveMedia } from '@/lib/media.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const started = performance.now();
  let authMs = 0;
  const response = await mediaRoute(async () => {
    await mediaAuth(request);
    authMs = performance.now() - started;
    return serveMedia(params.id, request, false);
  });
  response.headers.append(
    'Server-Timing',
    `auth;dur=${authMs.toFixed(1)}, headers;dur=${(
      performance.now() - started
    ).toFixed(1)}`
  );
  return response;
}
export const HEAD = GET;
