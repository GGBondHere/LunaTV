import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from './auth';
import { getConfig } from './config';
import { db } from './db';
import type { ChatHistory, SocialUser } from './social';
import { conversationId, PRESENCE_GRACE_MS, PRESENCE_LEASE_MS } from './social';

export function socialResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function socialAuth(request: NextRequest) {
  if ((process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage') return socialResponse({ error: '站内私信需要服务端存储' }, 400);
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== request.headers.get('host') && new URL(origin).host !== request.nextUrl.host) return socialResponse({ error: '不允许跨站操作' }, 403);
  }
  // middleware 验证 Cookie 签名；接口和心跳再次检查用户存在、封禁状态。
  const username = getAuthInfoFromCookie(request)?.username;
  const config = await getConfig();
  const users = Array.from(new Set(config.UserConfig.Users.filter((user) => !user.banned).map((user) => user.username)));
  if (process.env.USERNAME && !users.includes(process.env.USERNAME)) users.push(process.env.USERNAME);
  if (!username || !users.includes(username)) return socialResponse({ error: '登录已失效' }, 401);
  return { username, users };
}

export function validPeer(peer: unknown, auth: { username: string; users: string[] }): peer is string {
  return typeof peer === 'string' && peer !== auth.username && auth.users.includes(peer);
}

interface PresenceChange { username: string; online: boolean; version: number }
type HubEvent = { type: 'update'; users?: string[] } | { type: 'presence'; change: PresenceChange };
interface Hub { listeners: Set<(event: HubEvent) => void>; timer?: ReturnType<typeof setInterval>; sweeping: boolean }
const symbol = Symbol.for('lunatv.social.hub');
const globalHub = globalThis as typeof globalThis & { [symbol]?: Hub };
const hub = globalHub[symbol] || (globalHub[symbol] = { listeners: new Set(), sweeping: false });

function publish(event: HubEvent) {
  hub.listeners.forEach((listener) => listener(event));
}

export function notifySocial(users?: string[]) {
  publish({ type: 'update', users });
}

export async function updatePresence(action: 'join' | 'heartbeat' | 'leave' | 'sweep', user = '', connection = '') {
  const result = await db.socialCommand<{ ok: boolean; changes: PresenceChange[] | Record<string, never> }>('presence', {
    action, user, connection, now: Date.now(), lease: PRESENCE_LEASE_MS, grace: PRESENCE_GRACE_MS,
  });
  if (Array.isArray(result.changes)) for (const change of result.changes) publish({ type: 'presence', change });
  return result.ok;
}

export function subscribeSocial(listener: (event: HubEvent) => void) {
  hub.listeners.add(listener);
  if (!hub.timer) {
    hub.timer = setInterval(() => {
      if (hub.sweeping) return;
      hub.sweeping = true;
      void updatePresence('sweep').catch(() => notifySocial()).finally(() => { hub.sweeping = false; });
    }, 5000);
    hub.timer.unref?.();
  }
  return () => {
    hub.listeners.delete(listener);
    if (!hub.listeners.size && hub.timer) { clearInterval(hub.timer); hub.timer = undefined; }
  };
}

export async function socialOverview(username: string, users: string[]) {
  const result = await db.socialCommand<SocialUser[]>('overview', {
    user: username, now: Date.now(),
    peers: users.filter((user) => user !== username).map((user) => ({ username: user, key: conversationId(username, user) })),
  });
  return Array.isArray(result) ? result : [];
}

export async function chatHistory(username: string, peer: string, after?: number, before?: number) {
  const result = await db.socialCommand<ChatHistory>('history', { user: username, key: conversationId(username, peer), after, before });
  return { ...result, messages: Array.isArray(result.messages) ? result.messages : [] };
}

export const newConnectionId = randomUUID;
