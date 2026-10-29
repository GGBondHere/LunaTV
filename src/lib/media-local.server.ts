import { createHash } from 'crypto';
import { type BigIntStats, constants } from 'fs';
import { lstat, open, realpath, unlink } from 'fs/promises';
import { isAbsolute, join, relative, sep } from 'path';

import { mediaRelativePath } from './media';

export interface LocalMediaRef {
  path: string;
  identity: string;
  fingerprint: string;
}
export class LocalMediaError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}
export function localIdentity(value: BigIntStats) {
  if (value.ino === BigInt(0) || value.birthtimeNs <= BigInt(0))
    throw new LocalMediaError(
      'LOCAL_ID',
      '文件系统未提供可靠文件标识，跳过导入'
    );
  return createHash('sha256')
    .update([value.dev, value.ino, value.birthtimeNs].map(String).join(':'))
    .digest('hex');
}
function fingerprint(value: BigIntStats) {
  return createHash('sha256')
    .update([value.size, value.mtimeNs].map(String).join(':'))
    .digest('hex');
}
export async function localPath(root: string, path: string) {
  const normalized = mediaRelativePath(path);
  if (normalized.includes(':'))
    throw new LocalMediaError(
      'LOCAL_PATH',
      '本地扫描仅接受媒体目录内的相对路径'
    );
  if (['items', 'uploads'].includes(normalized.split('/')[1]))
    throw new LocalMediaError(
      'LOCAL_INTERNAL',
      '内部上传和清单目录不参与外部文件扫描'
    );
  const base = await realpath(root);
  const resolved = await realpath(
    join(base, ...normalized.split('/').filter(Boolean))
  );
  const inside = relative(base, resolved);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep))
    throw new LocalMediaError('LOCAL_PATH', '文件超出本地媒体目录');
  return resolved;
}
export async function localObject(root: string, path: string) {
  try {
    const normalized = mediaRelativePath(path);
    const requested = join(root, ...normalized.split('/').filter(Boolean));
    const info = await lstat(requested, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== BigInt(1))
      throw new LocalMediaError(
        'LOCAL_LINK',
        '跳过非普通文件、符号链接或多重硬链接'
      );
    const absolute = await localPath(root, normalized);
    const after = await lstat(absolute, { bigint: true });
    if (after.isSymbolicLink() || localIdentity(after) !== localIdentity(info))
      throw new LocalMediaError('LOCAL_CHANGED', '文件位置已变化，请重新扫描');
    const bytes = Number(after.size);
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new LocalMediaError('LOCAL_EMPTY', '跳过空文件或无效文件大小');
    return {
      path: normalized,
      absolute,
      identity: localIdentity(after),
      fingerprint: fingerprint(after),
      bytes,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export async function openLocalMedia(root: string, ref: LocalMediaRef) {
  const current = await localObject(root, ref.path);
  if (!current)
    throw new LocalMediaError(
      'LOCAL_MISSING',
      '本地源文件不存在，请管理员重新扫描',
      404
    );
  if (
    current.identity !== ref.identity ||
    current.fingerprint !== ref.fingerprint
  )
    throw new LocalMediaError(
      'LOCAL_CHANGED',
      '本地源文件已变化，请管理员重新扫描'
    );
  const handle = await open(
    current.absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== BigInt(1) ||
      localIdentity(info) !== ref.identity ||
      fingerprint(info) !== ref.fingerprint
    )
      throw new LocalMediaError(
        'LOCAL_CHANGED',
        '本地源文件已变化，请管理员重新扫描'
      );
    return handle;
  } catch (e) {
    await handle.close();
    throw e;
  }
}
export async function deleteLocalMedia(root: string, ref: LocalMediaRef) {
  const current = await localObject(root, ref.path);
  if (!current) return;
  if (
    current.identity !== ref.identity ||
    current.fingerprint !== ref.fingerprint
  )
    throw new LocalMediaError(
      'LOCAL_CHANGED',
      '源文件已变化，未删除文件；请重新扫描确认'
    );
  await unlink(current.absolute);
}
