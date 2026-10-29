import { mediaRelativePath } from './media';

export interface DavObject {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  modified: string;
  etag: string;
}
function xmlText(value: string) {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      };
      if (named[entity]) return named[entity];
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      if (
        !Number.isInteger(code) ||
        code < 32 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        throw new Error('目录响应包含无效字符');
      return String.fromCodePoint(code);
    }
  );
}
export function davXmlValue(xml: string, tag: string) {
  const match = new RegExp(
    '<(?:[\\w.-]+:)?' +
      tag +
      '\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?' +
      tag +
      '\\s*>',
    'i'
  ).exec(xml);
  return match ? xmlText(match[1].trim()) : undefined;
}
function hrefPath(baseAddress: string, href: string, requested: string) {
  const base = new URL(baseAddress);
  const requestURL =
    baseAddress + requested.split('/').map(encodeURIComponent).join('/');
  const url = new URL(href, requestURL + '/');
  if (
    url.origin !== base.origin ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('目录返回了连接范围外的地址');
  const parts = (value: string) =>
    value
      .split('/')
      .filter(Boolean)
      .map((part) => {
        const decoded = decodeURIComponent(part);
        if (
          decoded.includes('/') ||
          decoded.includes('\\') ||
          decoded === '.' ||
          decoded === '..'
        )
          throw new Error('目录返回了不安全的文件名');
        return decoded;
      });
  const prefix = parts(base.pathname),
    full = parts(url.pathname);
  if (prefix.some((part, i) => part !== full[i]))
    throw new Error('目录返回了连接范围外的路径');
  return mediaRelativePath('/' + full.slice(prefix.length).join('/'));
}
// Parse only bounded DAV responses; external entities and DTDs are never accepted.
export function parseDavObjects(
  xml: string,
  base: string,
  path: string,
  depth: '0' | '1'
) {
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    !/<(?:[\w.-]+:)?multistatus\b/i.test(xml) ||
    !/<\/(?:[\w.-]+:)?multistatus\s*>/i.test(xml)
  )
    throw new Error('远端未返回完整有效的 WebDAV 目录');
  const blocks =
    xml.match(
      /<(?:[\w.-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?response\s*>/gi
    ) || [];
  if (
    !blocks.length ||
    blocks.length > 20001 ||
    blocks.length !==
      (xml.match(/<(?:[\w.-]+:)?response\b[^>]*>/gi) || []).length
  )
    throw new Error('目录响应不完整或超过 20000 条限制');
  const objects = new Map<string, DavObject>();
  for (const block of blocks) {
    const href = davXmlValue(block, 'href');
    if (href === undefined) throw new Error('目录响应缺少文件路径');
    const current = hrefPath(base, href, path);
    if (
      current !== path &&
      (depth === '0' ||
        !current.startsWith(path.replace(/\/$/, '') + '/') ||
        current.slice(path === '/' ? 1 : path.length + 1).includes('/'))
    )
      throw new Error('目录返回了非直接子项');
    const stats =
      block.match(
        /<(?:[\w.-]+:)?propstat\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?propstat\s*>/gi
      ) || [];
    if (
      depth === '0' &&
      blocks.length === 1 &&
      current === path &&
      !stats.length &&
      /^HTTP\/\S+\s+404\b/i.test(davXmlValue(block, 'status') || '')
    )
      return null;
    const props = stats
      .filter((part) =>
        /^HTTP\/\S+\s+200\b/i.test(davXmlValue(part, 'status') || '')
      )
      .join('\n');
    if (!props) throw new Error('目录包含无权访问或不完整的条目，保留原片库');
    const resource = davXmlValue(props, 'resourcetype');
    const is_dir =
      resource !== undefined && /<(?:[\w.-]+:)?collection\b/i.test(resource);
    if (
      resource === undefined &&
      !/<(?:[\w.-]+:)?resourcetype\b[^>]*\/\s*>/i.test(props)
    )
      throw new Error('目录缺少文件类型信息');
    const rawSize = davXmlValue(props, 'getcontentlength');
    const size = is_dir
      ? 0
      : rawSize !== undefined && /^\d+$/.test(rawSize)
      ? Number(rawSize)
      : NaN;
    if (!is_dir && (!Number.isSafeInteger(size) || size < 0))
      throw new Error('目录缺少有效文件大小');
    if (objects.has(current))
      throw new Error('同目录存在重名或重复路径，请先处理后再扫描');
    objects.set(current, {
      path: current,
      name: current.split('/').pop() || '',
      is_dir,
      size,
      etag: davXmlValue(props, 'getetag') || '',
      modified: davXmlValue(props, 'getlastmodified') || '',
    });
  }
  if (!objects.has(path)) throw new Error('目录响应不完整，未确认请求路径');
  return objects;
}
