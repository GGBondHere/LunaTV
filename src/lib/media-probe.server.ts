import { randomBytes } from 'crypto';
import { createServer } from 'http';
import { Readable } from 'stream';

import type { MediaConnection } from './media';
import { createMediaCover, inspectMedia } from './media-processing.server';
import {
  boundedBytes,
  dav,
  RemoteMediaError,
  remoteStream,
} from './media-remote.server';

// FFmpeg only sees an ephemeral loopback URL; remote credentials never enter argv.
export async function probeRemote(
  c: MediaConnection,
  path: string,
  size: number,
  cover: string,
  signal: AbortSignal
) {
  const token = randomBytes(32).toString('hex');
  let bytes = 0,
    requests = 0;
  const limit = 128 * 1024 * 1024;
  const stop = new AbortController();
  const abort = () => {
    stop.abort();
    server.closeAllConnections();
  };
  const server = createServer(async (request, response) => {
    if (
      request.url !== '/' + token ||
      !['GET', 'HEAD'].includes(request.method || '') ||
      ++requests > 64 ||
      bytes >= limit
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    const client = new AbortController();
    const cancel = () => client.abort();
    stop.signal.addEventListener('abort', cancel, { once: true });
    response.on('close', cancel);
    try {
      const remote = await remoteStream(
        c,
        path,
        size,
        request.headers.range || null,
        client.signal,
        request.method === 'HEAD'
      );
      response.writeHead(remote.status, Object.fromEntries(remote.headers));
      if (!remote.body) {
        response.end();
        return;
      }
      const stream = Readable.fromWeb(
        remote.body as Parameters<typeof Readable.fromWeb>[0]
      );
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          stream.destroy();
          client.abort();
          response.destroy();
        }
      });
      stream.on('error', () => response.destroy());
      await new Promise<void>((resolve) => {
        response.once('close', resolve);
        response.once('finish', resolve);
        stream.pipe(response);
      });
    } catch {
      response.destroy();
    } finally {
      stop.signal.removeEventListener('abort', cancel);
      response.off('close', cancel);
      client.abort();
    }
  });
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 120000);
  try {
    if (signal.aborted)
      throw new RemoteMediaError('INTERRUPTED', '扫描已停止', 409);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('probe unavailable');
    const headerResponse = await dav(c, path, 'GET', {
      signal: stop.signal,
      headers: { Range: 'bytes=0-15' },
    });
    if (headerResponse.status !== 206) {
      await headerResponse.body?.cancel();
      throw new RemoteMediaError('SCAN_RANGE', '远端不支持分段检查');
    }
    const header = await boundedBytes(headerResponse, 16);
    if (
      header.toString('ascii', 4, 8) !== 'ftyp' ||
      header.toString('ascii', 8, 12) === 'qt  '
    )
      throw new RemoteMediaError(
        'UNSUPPORTED_FORMAT',
        '视频容器不支持，仅接受 MP4',
        400
      );
    const url = `http://127.0.0.1:${address.port}/${token}`;
    let info: Awaited<ReturnType<typeof inspectMedia>>;
    try {
      info = await inspectMedia(url, true);
    } catch (e) {
      if (/^视频编码不支持/.test((e as Error).message || ''))
        throw new RemoteMediaError(
          'UNSUPPORTED_FORMAT',
          '视频编码不支持，仅接受 8 位 H.264 及 AAC 或无音轨',
          400
        );
      throw new RemoteMediaError(
        'SCAN_PROBE',
        '视频检查未完成或超出读取限制，可在下次扫描重试'
      );
    }
    let hasCover = false;
    if (!stop.signal.aborted) {
      try {
        await createMediaCover(url, cover, info.duration, true);
        hasCover = true;
      } catch {
        /* Valid video can use the existing placeholder. */
      }
    }
    if (stop.signal.aborted)
      throw new RemoteMediaError(
        'SCAN_INTERRUPTED',
        '扫描已停止或检查超时',
        409
      );
    return { ...info, hasCover };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    stop.abort();
    server.closeAllConnections();
    server.close();
  }
}
