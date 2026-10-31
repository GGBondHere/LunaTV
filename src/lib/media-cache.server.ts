import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'fs/promises';
import { freemem, totalmem } from 'os';
import { join, resolve } from 'path';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const GRACE = 60000;
const LEASE = 90000;
interface DiskEntry {
  id: string;
  asset: string;
  start: number;
  end: number;
  path: string;
  bytes: number;
  touched: number;
  readers: number;
  invalid: boolean;
}
interface CacheState {
  root: string;
  init?: Promise<void>;
  limits?: () => Promise<{ reserve: number; pending: number }>;
  disk: Map<string, DiskEntry>;
  writes: Set<string>;
  bytes: number;
  reserved: number;
  writers: number;
  generation: Map<string, number>;
  viewers: Map<
    string,
    { id: string; seq: number; until: number; closed: boolean }
  >;
  idle: Map<string, number>;
  timer?: ReturnType<typeof setInterval>;
  onIdle?: (id: string) => void;
  budgetAt: number;
  diskBudget: number;
}
const key = Symbol.for('lunatv.media.disk-cache.v1');
const shared = globalThis as typeof globalThis & { [key]?: CacheState };
const state: CacheState =
  shared[key] ||
  (shared[key] = {
    root: '',
    disk: new Map(),
    writes: new Set(),
    bytes: 0,
    reserved: 0,
    writers: 0,
    generation: new Map(),
    viewers: new Map(),
    idle: new Map(),
    budgetAt: 0,
    diskBudget: 0,
  });
function cgroupNumber(path: string) {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
let memoryAt = 0;
let memoryBudget = 0;
export function mediaMemoryBudget() {
  if (Date.now() - memoryAt < 3000) return memoryBudget;
  memoryAt = Date.now();
  const runtime = process as typeof process & {
    constrainedMemory?: () => number;
    availableMemory?: () => number;
  };
  const constraint = runtime.constrainedMemory?.() || 0;
  const limit =
    cgroupNumber('/sys/fs/cgroup/memory.max') ??
    cgroupNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const used =
    cgroupNumber('/sys/fs/cgroup/memory.current') ??
    cgroupNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const effective = Math.min(
    totalmem(),
    constraint || Infinity,
    limit || Infinity
  );
  const availableMemory = runtime.availableMemory?.();
  const available = Math.min(
    freemem(),
    availableMemory === undefined ? Infinity : availableMemory,
    limit !== undefined && used !== undefined
      ? Math.max(0, limit - used)
      : Infinity
  );
  // Keep headroom for the application and other processes, including on small containers.
  memoryBudget = Math.floor(
    Math.max(
      0,
      Math.min(
        effective / 16,
        GiB,
        available - Math.max(64 * MiB, effective / 10)
      )
    )
  );
  return memoryBudget;
}
export function mediaReadAheadBytes() {
  return Math.min(512 * MiB, Math.floor(mediaMemoryBudget() * 2));
}
export function mediaCacheAsset(
  id: string,
  revision: string,
  connection: unknown,
  path: string,
  size: number
) {
  return createHash('sha256')
    .update(JSON.stringify([id, revision, connection, path, size]))
    .digest('hex');
}
function entryKey(asset: string, start: number) {
  return `${asset}:${start}`;
}
function startTimer() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void collect().catch(() => undefined);
  }, 10000);
  state.timer.unref();
}
async function remove(entry: DiskEntry) {
  entry.invalid = true;
  if (entry.readers) return;
  try {
    await unlink(entry.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  const key = entryKey(entry.asset, entry.start);
  if (state.disk.get(key) !== entry) return;
  state.disk.delete(key);
  state.bytes -= entry.bytes;
  state.budgetAt = 0;
}
export async function initializeMediaCache(
  root: string,
  limits: CacheState['limits']
) {
  state.limits = limits;
  if (state.init) return state.init;
  state.root = join(resolve(root), '.playback-cache');
  state.init = (async () => {
    await mkdir(state.root, { recursive: true });
    const directory = await lstat(state.root);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('Unsafe cache directory');
    // Cache is disposable after restart. Never traverse other media directories or links.
    for (const name of await readdir(state.root)) {
      if (!/^[a-f0-9]{64}-[a-f0-9-]{36}\.(cache|part)$/.test(name)) continue;
      const path = join(state.root, name);
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink()) await unlink(path);
    }
  })().catch(() => {
    state.root = '';
  });
  return state.init;
}
async function diskBudget(force = false) {
  if (!state.root || !state.limits) return 0;
  if (!force && Date.now() - state.budgetAt < 5000) return state.diskBudget;
  try {
    const [disk, limits] = await Promise.all([
      statfs(state.root, { bigint: true }),
      state.limits(),
    ]);
    const free = Number(disk.bavail * disk.bsize);
    const total = Number(disk.blocks * disk.bsize);
    state.diskBudget = Math.floor(
      Math.max(
        0,
        Math.min(
          32 * GiB,
          total / 10,
          free +
            state.bytes -
            limits.reserve -
            limits.pending -
            state.reserved -
            16 * MiB
        )
      )
    );
    state.budgetAt = Date.now();
    return state.diskBudget;
  } catch {
    return 0;
  }
}
export async function mediaDiskCapacity() {
  return diskBudget();
}
export function touchMediaCache(id: string) {
  state.idle.set(id, Date.now());
  startTimer();
}
export function mediaHasViewers(id: string) {
  return Array.from(state.viewers.values()).some(
    (v) => v.id === id && !v.closed && v.until > Date.now()
  );
}
export function onMediaCacheIdle(callback: (id: string) => void) {
  state.onIdle = callback;
}
export function touchMediaViewer(
  id: string,
  owner: string,
  session: string,
  seq: number,
  close: boolean
) {
  const key = `${owner}:${session}`;
  const previous = state.viewers.get(key);
  if (previous && (previous.id !== id || previous.seq >= seq)) return;
  if (!previous && state.viewers.size >= 4096) return;
  state.viewers.set(key, {
    id,
    seq,
    until: Date.now() + (close ? 5 * 60000 : LEASE),
    closed: close,
  });
  state.idle.set(id, Date.now());
  startTimer();
}
export function invalidateMediaDisk(id: string) {
  state.generation.set(id, (state.generation.get(id) || 0) + 1);
  for (const entry of Array.from(state.disk.values()))
    if (entry.id === id) void remove(entry).catch(() => undefined);
  state.onIdle?.(id);
}
async function collect() {
  const now = Date.now();
  for (const [key, viewer] of Array.from(state.viewers)) {
    if (viewer.until <= now) {
      state.viewers.delete(key);
      if (!mediaHasViewers(viewer.id)) state.idle.set(viewer.id, viewer.until);
    }
  }
  for (const [id, at] of Array.from(state.idle)) {
    if (mediaHasViewers(id)) {
      state.idle.set(id, now);
      continue;
    }
    if (now - at < GRACE) continue;
    invalidateMediaDisk(id);
    state.idle.delete(id);
  }
  const budget = await diskBudget();
  for (const entry of Array.from(state.disk.values()).sort(
    (a, b) => a.touched - b.touched
  )) {
    if (
      entry.invalid ||
      state.bytes + state.reserved > budget ||
      now - entry.touched > 10 * 60000
    )
      await remove(entry);
  }
  // Generations only guard writes already in flight; release unused identifiers.
  for (const id of Array.from(state.generation.keys()))
    if (
      !state.writers &&
      !state.idle.has(id) &&
      !mediaHasViewers(id) &&
      !Array.from(state.disk.values()).some((e) => e.id === id)
    )
      state.generation.delete(id);
  if (
    !state.disk.size &&
    !state.viewers.size &&
    !state.writers &&
    !state.idle.size &&
    state.timer
  ) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}
export async function reclaimMediaCache(requiredFree = 0) {
  if (!state.root) return;
  const disk = await statfs(state.root, { bigint: true }).catch(() => null);
  if (!disk) return;
  let needed = requiredFree - Number(disk.bavail * disk.bsize);
  for (const entry of Array.from(state.disk.values()).sort(
    (a, b) => a.touched - b.touched
  )) {
    if (needed <= 0 && !entry.invalid) continue;
    const before = state.bytes;
    await remove(entry);
    needed -= before - state.bytes;
  }
  state.budgetAt = 0;
}
async function reserve(bytes: number) {
  const budget = await diskBudget();
  if (bytes > budget) return false;
  for (const entry of Array.from(state.disk.values()).sort(
    (a, b) => a.touched - b.touched
  )) {
    if (
      state.bytes + state.reserved + bytes <= budget &&
      state.disk.size < 8192
    )
      break;
    if (!entry.readers) await remove(entry);
  }
  if (state.bytes + state.reserved + bytes > budget || state.disk.size >= 8192)
    return false;
  state.reserved += bytes;
  return true;
}
export function storeMediaDisk(
  id: string,
  asset: string,
  start: number,
  data: Uint8Array
) {
  const key = entryKey(asset, start);
  if (
    !state.root ||
    state.writes.has(key) ||
    state.disk.has(key) ||
    Array.from(state.disk.values()).some(
      (e) =>
        e.asset === asset &&
        !e.invalid &&
        e.start <= start &&
        e.end >= start + data.length - 1
    ) ||
    state.writers >= 2
  )
    return;
  const generation = state.generation.get(id) || 0;
  state.writes.add(key);
  state.writers++;
  startTimer();
  void (async () => {
    let reserved = false;
    let temporary = '';
    try {
      if (!(reserved = await reserve(data.length))) return;
      temporary = join(state.root, `${asset}-${randomUUID()}.part`);
      await writeFile(temporary, data, { flag: 'wx' });
      if (generation !== (state.generation.get(id) || 0)) return;
      const path = temporary.replace(/\.part$/, '.cache');
      await rename(temporary, path);
      temporary = '';
      const entry: DiskEntry = {
        id,
        asset,
        start,
        end: start + data.length - 1,
        bytes: data.length,
        path,
        touched: Date.now(),
        readers: 0,
        invalid: generation !== (state.generation.get(id) || 0),
      };
      state.disk.set(key, entry);
      state.bytes += entry.bytes;
      if (entry.invalid) await remove(entry);
      if (!state.idle.has(id)) state.idle.set(id, Date.now());
    } catch {
      /* Optional cache never blocks playback. */
    } finally {
      if (temporary) {
        await unlink(temporary).catch(() => {
          // Retain failed cache cleanup in the in-memory GC index for retry.
          if (!state.disk.has(key)) {
            state.disk.set(key, {
              id,
              asset,
              start,
              end: start + data.length - 1,
              bytes: data.length,
              path: temporary,
              touched: 0,
              readers: 0,
              invalid: true,
            });
            state.bytes += data.length;
          }
        });
      }
      if (reserved) state.reserved -= data.length;
      state.writes.delete(key);
      state.writers--;
    }
  })();
}
export async function adoptMediaDisk(
  id: string,
  asset: string,
  source: string,
  bytes: number
) {
  const key = entryKey(asset, 0);
  if (!state.root || state.disk.has(key) || state.writes.has(key)) return false;
  state.writes.add(key);
  state.writers++;
  if (!(await reserve(bytes))) {
    state.writes.delete(key);
    state.writers--;
    return false;
  }
  const generation = state.generation.get(id) || 0;
  const path = join(state.root, `${asset}-${randomUUID()}.cache`);
  try {
    // Only the caller's confirmed cloud staging file may be moved into disposable cache.
    await rename(source, path);
    const entry: DiskEntry = {
      id,
      asset,
      start: 0,
      end: bytes - 1,
      bytes,
      path,
      touched: Date.now(),
      readers: 0,
      invalid: generation !== (state.generation.get(id) || 0),
    };
    state.disk.set(key, entry);
    state.bytes += bytes;
    if (entry.invalid) await remove(entry);
    state.idle.set(id, Date.now());
    startTimer();
    return true;
  } catch {
    return false;
  } finally {
    state.reserved -= bytes;
    state.writes.delete(key);
    state.writers--;
  }
}
export async function readMediaDisk(
  asset: string,
  at: number,
  end: number,
  signal: AbortSignal
) {
  const entry = Array.from(state.disk.values()).find(
    (e) => e.asset === asset && !e.invalid && e.start <= at && e.end >= at
  );
  if (!entry || signal.aborted) return null;
  entry.readers++;
  entry.touched = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(entry.path, 'r');
    const data = Buffer.allocUnsafe(
      Math.min(256 * 1024, end - at + 1, entry.end - at + 1)
    );
    const { bytesRead } = await handle.read(
      data,
      0,
      data.length,
      at - entry.start
    );
    if (entry.invalid || signal.aborted || bytesRead !== data.length)
      return null;
    return data;
  } catch {
    entry.invalid = true;
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
    entry.readers--;
    if (entry.invalid) void remove(entry).catch(() => undefined);
  }
}
export function mediaDiskHas(asset: string, at: number) {
  return Array.from(state.disk.values()).some(
    (e) => e.asset === asset && !e.invalid && e.start <= at && e.end >= at
  );
}
