import { NextRequest, NextResponse } from 'next/server';

import { newConnectionId, socialAuth, socialOverview, socialResponse, subscribeSocial, updatePresence } from '@/lib/social.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await socialAuth(request);
    if (auth instanceof NextResponse) return auth;
    const connection = newConnectionId();
    let closed = false;
    let ready = false;
    let joined = false;
    let dirty = false;
    let flushing = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: () => void = () => undefined;
    let close: () => void = () => undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          // 慢连接不积累无界消息；重连会重新同步快照和聊天记录。
          if ((controller.desiredSize ?? 0) < -64) { close(); return; }
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
          catch { close(); }
        };
        close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (timer) clearInterval(timer);
          request.signal.removeEventListener('abort', close);
          try { controller.close(); } catch { /* 已取消的流无需再次关闭 */ }
          void updatePresence('leave', auth.username, connection).catch(() => undefined);
        };
        const flush = async () => {
          dirty = true;
          if (flushing || closed) return;
          flushing = true;
          try {
            while (dirty && !closed) {
              dirty = false;
              const current = await socialAuth(request);
              if (current instanceof NextResponse || current.username !== auth.username) { send('auth-error', {}); close(); break; }
              const users = await socialOverview(auth.username, current.users);
              if (!closed) { send('snapshot', { users }); ready = true; }
            }
          } catch { close(); }
          finally { flushing = false; }
        };
        // 先订阅再取快照，快照期间发生的写入会触发下一次刷新，不留订阅空隙。
        unsubscribe = subscribeSocial((event) => {
          if (!joined) { dirty = true; return; }
          if (event.type === 'presence') {
            if (ready && event.change.username !== auth.username && auth.users.includes(event.change.username)) send('presence', event.change);
            void flush();
          } else if (!event.users || event.users.includes(auth.username)) void flush();
        });
        request.signal.addEventListener('abort', close, { once: true });
        try {
          if (request.signal.aborted) { close(); return; }
          await updatePresence('join', auth.username, connection);
          if (closed) { await updatePresence('leave', auth.username, connection); return; }
          joined = true;
          send('hello', { connection, username: auth.username });
          await flush();
          if (!closed) timer = setInterval(() => {
            send('heartbeat', {});
            void flush();
          }, 20000);
        } catch { close(); }
      },
      cancel() { close(); },
    });
    return new Response(stream, { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    } });
  } catch { return socialResponse({ error: '无法连接站内消息' }, 500); }
}
