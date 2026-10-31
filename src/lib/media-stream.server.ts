import { type MediaConnection } from './media';
import {
  invalidateMediaDisk,
  mediaCacheAsset,
  mediaDiskCapacity,
  mediaDiskHas,
  mediaHasViewers,
  mediaMemoryBudget,
  mediaReadAheadBytes,
  onMediaCacheIdle,
  readMediaDisk,
  storeMediaDisk,
  touchMediaCache,
} from './media-cache.server';
import {
  rangeBounds,
  RemoteMediaError,
  remoteStream,
} from './media-remote.server';

const SEGMENT = 4 * 1024 * 1024;
const TTL = 2 * 60 * 1000;
interface Segment {
  key: string;
  asset: string;
  id: string;
  start: number;
  end: number;
  buffer: Uint8Array;
  written: number;
  touched: number;
  owners: Set<symbol>;
  complete: boolean;
  invalid: boolean;
  etag: string;
}
interface StreamState {
  entries: Map<string, Segment>;
  streams: Map<string, Set<AbortController>>;
  bytes: number;
  preloaders: number;
  timer?: ReturnType<typeof setInterval>;
  etags?: Map<string, { id: string; value: string }>;
  prefetch?: Map<
    string,
    { start: number; end: number; stop: AbortController; asset: string }
  >;
}
const key = Symbol.for('lunatv.media.stream-cache.v2');
const globalCache = globalThis as typeof globalThis & { [key]?: StreamState };
const state: StreamState =
  globalCache[key] ||
  (globalCache[key] = {
    entries: new Map(),
    streams: new Map(),
    bytes: 0,
    preloaders: 0,
  });
function drop(entry: Segment) {
  if (entry.owners.size || state.entries.get(entry.key) !== entry) return;
  state.entries.delete(entry.key);
  state.bytes -= entry.buffer.length;
}
function collect() {
  const budget = mediaMemoryBudget();
  for (const entry of Array.from(state.entries.values()))
    if (
      !entry.owners.size &&
      (entry.invalid ||
        Date.now() - entry.touched > TTL ||
        state.bytes > budget)
    )
      drop(entry);
  if (!state.entries.size && state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}
function release(entry: Segment, owner: symbol) {
  entry.owners.delete(owner);
  entry.touched = Date.now();
  if (!entry.complete || entry.invalid) drop(entry);
}
function allocate(
  id: string,
  asset: string,
  start: number,
  end: number,
  owner: symbol,
  etag: string
) {
  const entryKey = `${asset}:${start}:${end}`;
  if (state.entries.has(entryKey)) return undefined;
  collect();
  const bytes = end - start + 1;
  const budget = mediaMemoryBudget();
  const countLimit = Math.max(16, Math.ceil(budget / SEGMENT) + 16);
  for (const candidate of Array.from(state.entries.values())
    .filter((entry) => !entry.owners.size)
    .sort((a, b) => a.touched - b.touched)) {
    if (state.bytes + bytes <= budget && state.entries.size < countLimit) break;
    drop(candidate);
  }
  if (state.bytes + bytes > budget || state.entries.size >= countLimit)
    return undefined;
  const entry: Segment = {
    key: entryKey,
    id,
    asset,
    start,
    end,
    buffer: new Uint8Array(bytes),
    written: 0,
    touched: Date.now(),
    owners: new Set([owner]),
    complete: false,
    invalid: false,
    etag,
  };
  state.entries.set(entryKey, entry);
  state.bytes += bytes;
  if (!state.timer) {
    state.timer = setInterval(collect, 30000);
    state.timer.unref();
  }
  return entry;
}
export function createMediaStreamLease(id: string, parent: AbortSignal) {
  const stop = new AbortController();
  const abort = () => stop.abort();
  const streams = state.streams.get(id) || new Set<AbortController>();
  streams.add(stop);
  state.streams.set(id, streams);
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) stop.abort();
  return {
    signal: stop.signal,
    release() {
      stop.abort();
      parent.removeEventListener('abort', abort);
      streams.delete(stop);
      if (!streams.size && state.streams.get(id) === streams)
        state.streams.delete(id);
    },
  };
}
function clearMediaCache(id: string) {
  const job = state.prefetch?.get(id);
  job?.stop.abort();
  for (const [asset, value] of Array.from(state.etags || []))
    if (value.id === id) state.etags?.delete(asset);
  for (const entry of Array.from(state.entries.values()))
    if (entry.id === id) {
      entry.invalid = true;
      drop(entry);
    }
  collect();
}
onMediaCacheIdle(clearMediaCache);
export function invalidateMediaStreams(id: string) {
  invalidateMediaDisk(id);
  for (const stream of Array.from(state.streams.get(id) || [])) stream.abort();
  for (const entry of Array.from(state.entries.values()))
    if (entry.id === id) {
      entry.invalid = true;
      drop(entry);
    }
  collect();
}
export function measuredMediaResponse(
  response: Response,
  lease: ReturnType<typeof createMediaStreamLease>,
  id: string,
  storage: 'local' | 'webdav',
  started: number
) {
  response.headers.set('X-Accel-Buffering', 'no');
  response.headers.append(
    'Server-Timing',
    `storage;desc="${storage}", prepare;dur=${(
      performance.now() - started
    ).toFixed(1)}`
  );
  if (!response.body) {
    lease.release();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let bytes = 0;
  let firstByteMs: number | undefined;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finish = (reason: 'done' | 'cancelled' | 'error') => {
    if (finished) return;
    finished = true;
    lease.signal.removeEventListener('abort', abort);
    lease.release();
    if (
      bytes >= 1024 * 1024 ||
      reason === 'error' ||
      (firstByteMs || 0) >= 1000
    )
      // eslint-disable-next-line no-console
      console.info('[media-stream]', {
        id,
        storage,
        bytes,
        firstByteMs: firstByteMs === undefined ? null : Math.round(firstByteMs),
        milliseconds: Math.round(performance.now() - started),
        reason,
        cache: response.headers.get('X-Media-Cache') || 'bypass',
      });
  };
  const abort = () => {
    if (finished) return;
    void reader.cancel().catch(() => undefined);
    output.error(new DOMException('已停止播放', 'AbortError'));
    finish('cancelled');
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(out) {
        output = out;
        lease.signal.addEventListener('abort', abort, { once: true });
        if (lease.signal.aborted) abort();
      },
      async pull(out) {
        try {
          const part = await reader.read();
          if (finished) return;
          if (part.done) {
            finish('done');
            out.close();
            return;
          }
          firstByteMs ??= performance.now() - started;
          bytes += part.value.length;
          out.enqueue(part.value);
        } catch (error) {
          if (finished) return;
          void reader.cancel().catch(() => undefined);
          finish('error');
          out.error(error);
        }
      },
      async cancel() {
        finish('cancelled');
        await reader.cancel().catch(() => undefined);
      },
    }),
    { status: response.status, headers: response.headers }
  );
}
export async function cachedRemoteStream(
  id: string,
  revision: string,
  c: MediaConnection,
  path: string,
  size: number,
  range: string | null,
  signal: AbortSignal,
  head: boolean
) {
  const bounds = rangeBounds(head ? null : range, size);
  if (!bounds) return remoteStream(c, path, size, range, signal, head);
  const asset = mediaCacheAsset(
    id,
    revision,
    [c.url, c.root, c.username, c.password],
    path,
    size
  );
  const owner = Symbol();
  const stop = new AbortController();
  let position = bounds.start;
  let cached: Segment | undefined;
  let capture: Segment | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let etag = '';
  let closed = false;
  let preloading = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', cleanup);
    stop.abort();
    if (cached) release(cached, owner);
    if (capture) release(capture, owner);
    cached = capture = undefined;
    void reader?.cancel().catch(() => undefined);
    if (preloading) state.preloaders--;
    preloading = false;
    collect();
  };
  signal.addEventListener('abort', cleanup, { once: true });
  const check = () => {
    if (closed || signal.aborted)
      throw new DOMException('已停止读取', 'AbortError');
  };
  const acquire = () => {
    collect();
    const entry = Array.from(state.entries.values())
      .filter(
        (part) =>
          part.asset === asset &&
          !part.invalid &&
          part.complete &&
          part.start <= position &&
          part.end >= position
      )
      .sort((a, b) => b.end - a.end)[0];
    if (entry) {
      entry.owners.add(owner);
      entry.touched = Date.now();
    }
    return entry;
  };
  const openSource = async () => {
    // Keep a cold read continuous; do not turn the movie into serial remote GETs.
    const response = await remoteStream(
      c,
      path,
      size,
      bounds.partial || position !== 0
        ? `bytes=${position}-${bounds.end}`
        : null,
      stop.signal
    );
    reader = response.body?.getReader();
    check();
    if (!reader) throw new RemoteMediaError('REMOTE_EMPTY', '没有收到视频内容');
    etag = response.headers.get('etag') || '';
    verifyETag(id, asset, etag);
  };
  const cacheBytes = (value: Uint8Array) => {
    let offset = 0;
    while (offset < value.length) {
      const at = position + offset;
      const end = Math.min(
        Math.floor(at / SEGMENT) * SEGMENT + SEGMENT - 1,
        bounds.end
      );
      capture ||= allocate(id, asset, at, end, owner, etag);
      const count = Math.min(value.length - offset, end - at + 1);
      if (capture) {
        capture.buffer.set(
          value.subarray(offset, offset + count),
          capture.written
        );
        capture.written += count;
        if (capture.written === capture.buffer.length) {
          capture.complete = true;
          storeMediaDisk(id, asset, capture.start, capture.buffer);
          release(capture, owner);
          capture = undefined;
        }
      }
      offset += count;
    }
  };
  try {
    check();
    cached = acquire();
    const diskHit = mediaDiskHas(asset, position);
    const hit = !!cached || diskHit;
    if (!hit && (head || bounds.end - bounds.start < 64 * 1024)) {
      cleanup();
      return remoteStream(c, path, size, range, signal, head);
    }
    const previous = state.prefetch?.get(id);
    if (
      bounds.end - bounds.start >= 64 * 1024 &&
      previous &&
      (previous.asset !== asset ||
        position < previous.start - SEGMENT ||
        position > previous.end)
    )
      previous.stop.abort();
    if (!cached && !diskHit) await openSource();
    check();
    // At most two responses read one segment ahead; others use normal backpressure.
    preloading = state.preloaders < 2;
    if (preloading) state.preloaders++;
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Content-Length': String(bounds.end - bounds.start + 1),
      'X-Media-Cache': hit ? 'hit' : 'stream',
    });
    if (bounds.partial)
      headers.set(
        'Content-Range',
        `bytes ${bounds.start}-${bounds.end}/${size}`
      );
    if (head) {
      cleanup();
      return new Response(null, { status: 200, headers });
    }
    const warm = () => {
      if (bounds.end - bounds.start >= 64 * 1024)
        scheduleReadAhead(id, asset, c, path, size, position);
    };
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(out) {
            try {
              check();
              if (position > bounds.end) {
                cleanup();
                out.close();
                return;
              }
              if (
                reader &&
                !capture &&
                (mediaDiskHas(asset, position) ||
                  Array.from(state.entries.values()).some(
                    (e) =>
                      e.asset === asset &&
                      e.complete &&
                      !e.invalid &&
                      e.start <= position &&
                      e.end >= position
                  ))
              ) {
                const upstream = reader;
                reader = undefined;
                void upstream.cancel().catch(() => undefined);
              }
              if (!reader) {
                cached ||= acquire();
                if (cached) {
                  const offset = position - cached.start;
                  const count = Math.min(
                    64 * 1024,
                    cached.end - position + 1,
                    bounds.end - position + 1
                  );
                  warm();
                  out.enqueue(cached.buffer.slice(offset, offset + count));
                  position += count;
                  if (position > cached.end || position > bounds.end) {
                    release(cached, owner);
                    cached = undefined;
                  }
                  return;
                }
                const data = await readMediaDisk(
                  asset,
                  position,
                  bounds.end,
                  stop.signal
                );
                check();
                if (data) {
                  cacheBytes(data);
                  warm();
                  position += data.length;
                  out.enqueue(data);
                  return;
                }
                await openSource();
              }
              const part = await reader?.read();
              check();
              if (!part || part.done)
                throw new RemoteMediaError(
                  'REMOTE_INTERRUPTED',
                  '视频读取中断，请重试'
                );
              if (position + part.value.length > bounds.end + 1)
                throw new RemoteMediaError('REMOTE_LENGTH', '视频长度不符');
              cacheBytes(part.value);
              warm();
              position += part.value.length;
              out.enqueue(part.value);
            } catch (error) {
              cleanup();
              out.error(error);
            }
          },
          cancel() {
            cleanup();
          },
        },
        {
          highWaterMark: preloading ? SEGMENT : 64 * 1024,
          size: (chunk) => chunk.byteLength,
        }
      ),
      { status: bounds.partial ? 206 : 200, headers }
    );
  } catch (error) {
    cleanup();
    throw error;
  }
}

function scheduleReadAhead(
  id: string,
  asset: string,
  c: MediaConnection,
  path: string,
  size: number,
  position: number
) {
  const ahead = mediaReadAheadBytes();
  if (ahead < SEGMENT * 2 || !mediaHasViewers(id)) return;
  const jobs = state.prefetch || (state.prefetch = new Map());
  const previous = jobs.get(id);
  if (previous) return;
  const maxJobs = mediaMemoryBudget() >= 128 * 1024 * 1024 ? 2 : 1;
  if (jobs.size >= maxJobs) return;
  // Leave a short lead to the demand stream. Cache consumers share this one fill.
  const base = Math.floor(position / SEGMENT) * SEGMENT;
  let start = base + 2 * SEGMENT;
  const horizon = Math.min(size - 1, base + ahead - 1);
  while (
    start <= horizon &&
    (mediaDiskHas(asset, start) ||
      Array.from(state.entries.values()).some(
        (e) =>
          e.asset === asset &&
          e.complete &&
          !e.invalid &&
          e.start <= start &&
          e.end >= start
      ))
  )
    start += SEGMENT;
  if (start > horizon) return;
  const end = horizon;
  const job = { start, end, stop: new AbortController(), asset };
  jobs.set(id, job);
  const owner = Symbol();
  let capture: Segment | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timeout = setTimeout(() => job.stop.abort(), 120000);
  void (async () => {
    try {
      const disk = await mediaDiskCapacity();
      if (job.stop.signal.aborted || !mediaHasViewers(id)) return;
      job.end = Math.floor(
        Math.min(
          end,
          base +
            Math.max(SEGMENT, Math.min(ahead, disk + mediaMemoryBudget() / 2)) -
            1
        )
      );
      if (job.end < start) return;
      const response = await remoteStream(
        c,
        path,
        size,
        `bytes=${start}-${job.end}`,
        job.stop.signal
      );
      reader = response.body?.getReader();
      const etag = response.headers.get('etag') || '';
      verifyETag(id, asset, etag);
      let at = start;
      while (reader && !job.stop.signal.aborted && mediaHasViewers(id)) {
        const part = await reader.read();
        if (part.done) break;
        if (job.stop.signal.aborted || at + part.value.length > job.end + 1)
          break;
        let offset = 0;
        while (offset < part.value.length) {
          const target = at + offset;
          const segmentEnd = Math.min(
            Math.floor(target / SEGMENT) * SEGMENT + SEGMENT - 1,
            job.end
          );
          if (!capture && !mediaDiskHas(asset, target))
            capture = allocate(id, asset, target, segmentEnd, owner, etag);
          const count = Math.min(
            part.value.length - offset,
            segmentEnd - target + 1
          );
          if (capture) {
            capture.buffer.set(
              part.value.subarray(offset, offset + count),
              capture.written
            );
            capture.written += count;
            if (capture.written === capture.buffer.length) {
              capture.complete = true;
              storeMediaDisk(id, asset, capture.start, capture.buffer);
              release(capture, owner);
              capture = undefined;
            }
          }
          offset += count;
        }
        at += part.value.length;
        if (at > job.end) break;
      }
    } catch {
      /* Prefetch failure leaves foreground streaming unchanged. */
    } finally {
      clearTimeout(timeout);
      job.stop.abort();
      await reader?.cancel().catch(() => undefined);
      if (capture) release(capture, owner);
      if (jobs.get(id) === job) jobs.delete(id);
    }
  })();
}

function verifyETag(id: string, asset: string, etag: string) {
  if (!etag || etag.startsWith('W/')) return;
  touchMediaCache(id);
  const versions = state.etags || (state.etags = new Map());
  const previous = versions.get(asset);
  if (previous && previous.value !== etag) {
    invalidateMediaStreams(id);
    throw new RemoteMediaError(
      'REMOTE_CHANGED',
      '源视频已变化，请重新扫描后播放',
      409
    );
  }
  versions.set(asset, { id, value: etag });
}
