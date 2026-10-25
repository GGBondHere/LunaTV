'use client';

import { ArrowLeft, MessageCircle, Send, Users, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getAuthInfoFromBrowserCookie } from '@/lib/auth';
import { supportsPublicFavorites } from '@/lib/public-favorites.client';
import { type ChatHistory, type ChatMessage, type SocialUser,CHAT_TEXT_LIMIT } from '@/lib/social';

type Status = 'connecting' | 'connected' | 'reconnecting';
interface SocialButtonState { unread: number; open: () => void }
const SocialContext = createContext<SocialButtonState | null>(null);
interface Notice { id: string; username: string; kind: 'online' | 'message'; expires: number; error?: string }
interface Attempt { id: string; text: string }
interface FullscreenDocument extends Document {
  readonly webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

function getFullscreenElement() {
  const fullscreenDocument = document as FullscreenDocument;
  return fullscreenDocument.fullscreenElement || fullscreenDocument.webkitFullscreenElement || null;
}

function UnreadBadge({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return <span className={`inline-flex h-4 min-w-[1rem] flex-shrink-0 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium leading-none tabular-nums text-white ${className}`}>{count > 99 ? '99+' : count}</span>;
}

function messageId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues 也可用于普通 HTTP 页面，不要求启用系统通知或 HTTPS。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function SocialButton() {
  const social = useContext(SocialContext);
  if (!social) return null;
  return (
    <button type='button' title='站内消息' aria-label={`站内消息${social.unread ? `，${social.unread} 条未读` : ''}`} onClick={social.open}
      className='flex h-10 w-10 items-center justify-center rounded-full text-gray-600 transition-colors hover:bg-gray-200/50 dark:text-gray-300 dark:hover:bg-gray-700/50'>
      <span className='relative inline-flex h-6 w-6'>
        <MessageCircle className='h-6 w-6' />
        <UnreadBadge count={social.unread} className='absolute right-0 top-0 translate-x-1/3 -translate-y-1/3 ring-2 ring-white dark:ring-gray-900' />
      </span>
    </button>
  );
}

export default function SocialProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [account, setAccount] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [users, setUsers] = useState<SocialUser[]>([]);
  const [open, setOpen] = useState(false);
  const [peer, setPeer] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [notices, setNotices] = useState<Notice[]>([]);
  const [noticeHost, setNoticeHost] = useState<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [focused, setFocused] = useState(true);
  const accountRef = useRef(account);
  accountRef.current = account;
  const epoch = useRef(0);
  const connectionRef = useRef('');
  const usersRef = useRef<SocialUser[]>([]);
  const cache = useRef<Record<string, ChatMessage[]>>({});
  // 只由历史接口推进；发送响应可能越过尚未收到的对方消息。
  const historyCursors = useRef(new Map<string, number>());
  const peerRef = useRef(peer);
  peerRef.current = open ? peer : null;
  const attempts = useRef(new Map<string, Attempt>());
  const sendingRef = useRef(new Map<string, string>());
  const requests = useRef(new Set<AbortController>());
  const loads = useRef(new Set<string>());
  const loadCounts = useRef(new Map<string, number>());
  const readAcks = useRef(new Map<string, number>());
  const readPending = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ user: string; version: number; seq: string; offset: number } | null>(null);
  const loadRef = useRef<(user: string, older?: boolean) => Promise<void>>();

  useEffect(() => {
    // 保留同一个 Portal 容器，切换全屏或播放器销毁时不会重建提醒。
    const host = document.createElement('div');
    const moveNotices = () => {
      const fullscreen = getFullscreenElement();
      // 系统原生视频全屏不能展示网页子元素。
      const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
      if (host.parentElement !== parent) parent.appendChild(host);
    };
    moveNotices();
    setNoticeHost(host);
    document.addEventListener('fullscreenchange', moveNotices);
    document.addEventListener('webkitfullscreenchange', moveNotices);
    return () => {
      document.removeEventListener('fullscreenchange', moveNotices);
      document.removeEventListener('webkitfullscreenchange', moveNotices);
      host.remove();
    };
  }, []);

  const syncAccount = useCallback(() => {
    const username = supportsPublicFavorites() && !['/login', '/warning'].includes(window.location.pathname)
      ? getAuthInfoFromBrowserCookie()?.username || null : null;
    setAccount(username);
  }, []);

  useEffect(syncAccount, [pathname, syncAccount]);
  useEffect(() => {
    const focus = () => { syncAccount(); setFocused(document.visibilityState === 'visible' && document.hasFocus()); };
    const blur = () => setFocused(false);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', focus);
    focus();
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', focus); };
  }, [syncAccount]);

  const api = useCallback(async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const user = accountRef.current;
    const version = epoch.current;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    const assertCurrent = () => {
      if (version !== epoch.current || user !== accountRef.current || user !== getAuthInfoFromBrowserCookie()?.username) throw new DOMException('旧会话请求已忽略', 'AbortError');
    };
    requests.current.add(controller);
    try {
      const response = await fetch(path, { ...options, cache: 'no-store', signal: controller.signal });
      assertCurrent();
      const body = await response.json();
      assertCurrent();
      if (!response.ok) {
        if (response.status === 401) setAccount(null);
        throw new Error(body.error || '站内消息请求失败');
      }
      return body as T;
    } catch (error) {
      assertCurrent();
      if (timedOut) throw new Error('请求超时，请重试');
      throw error;
    } finally { clearTimeout(timer); requests.current.delete(controller); }
  }, []);

  const post = useCallback(<T,>(path: string, body: object) => api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), [api]);

  const mergeMessages = useCallback((user: string, messages: ChatMessage[]) => {
    const merged = new Map((cache.current[user] || []).map((message) => [message.seq, message]));
    messages.forEach((message) => merged.set(message.seq, message));
    cache.current = { ...cache.current, [user]: Array.from(merged.values()).sort((a, b) => a.seq - b.seq) };
    setThreads(cache.current);
  }, []);

  const loadHistory = useCallback(async (user: string, older = false) => {
    const messages = cache.current[user] || [];
    const cursor = older ? messages[0]?.seq : historyCursors.current.get(user);
    const key = `${user}:${older}:${cursor ?? 'initial'}`;
    if (loads.current.has(key)) return;
    loads.current.add(key);
    loadCounts.current.set(user, (loadCounts.current.get(user) || 0) + 1);
    const version = epoch.current;
    setLoading((state) => ({ ...state, [user]: true }));
    try {
      const params = new URLSearchParams({ peer: user });
      if (cursor !== undefined) params.set(older ? 'before' : 'after', String(cursor));
      const history = await api<ChatHistory>(`/api/social/messages?${params}`);
      if (version !== epoch.current) return;
      if (older && peerRef.current === user && scrollRef.current) {
        const viewport = scrollRef.current;
        const top = viewport.getBoundingClientRect().top;
        const firstVisible = Array.from(viewport.querySelectorAll<HTMLElement>('[data-chat-seq]')).find((element) => element.getBoundingClientRect().bottom > top);
        if (firstVisible?.dataset.chatSeq) scrollAnchor.current = { user, version, seq: firstVisible.dataset.chatSeq, offset: firstVisible.getBoundingClientRect().top - top };
      }
      mergeMessages(user, history.messages);
      if (!older && history.messages.length) {
        const last = history.messages[history.messages.length - 1].seq;
        historyCursors.current.set(user, Math.max(historyCursors.current.get(user) || 0, last));
      } else if (!older && history.latest === 0) {
        historyCursors.current.set(user, 0);
      }
      readAcks.current.set(user, Math.max(readAcks.current.get(user) || 0, history.read));
      setErrors((state) => ({ ...state, [user]: '' }));
      const latest = Math.max(history.latest, usersRef.current.find((item) => item.username === user)?.latest || 0);
      if (!older && (historyCursors.current.get(user) || 0) < latest) void loadRef.current?.(user);
    } catch (error) {
      if (version === epoch.current && !(error instanceof DOMException && error.name === 'AbortError')) setErrors((state) => ({ ...state, [user]: error instanceof Error ? error.message : '获取私信失败' }));
    } finally {
      if (version === epoch.current) {
        loads.current.delete(key);
        const count = Math.max(0, (loadCounts.current.get(user) || 1) - 1);
        loadCounts.current.set(user, count);
        setLoading((state) => ({ ...state, [user]: count > 0 }));
      }
    }
  }, [api, mergeMessages]);
  loadRef.current = loadHistory;

  useEffect(() => {
    const pendingRequests = requests.current;
    const invalidateRequests = () => {
      epoch.current++;
      pendingRequests.forEach((request) => request.abort());
      pendingRequests.clear();
    };
    invalidateRequests();
    cache.current = {}; historyCursors.current.clear(); usersRef.current = []; loads.current.clear(); loadCounts.current.clear(); readAcks.current.clear(); readPending.current.clear();
    attempts.current.clear(); sendingRef.current.clear();
    setThreads({}); setUsers([]); setDrafts({}); setErrors({}); setLoading({}); setSending({}); setNotices([]); setPeer(null); setOpen(false);
    if (!account) return;
    let active = true;
    let source: EventSource;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionGeneration = 0;
    let retryDelay = 1000;
    let heartbeatPending = false;
    let firstSnapshot = true;
    const noticeIds = new Set<string>();
    const presenceVersions = new Map<string, number>();
    const current = () => active && account === getAuthInfoFromBrowserCookie()?.username;
    const notice = (item: Omit<Notice, 'expires'>) => {
      if (!current() || document.visibilityState !== 'visible' || !document.hasFocus() || noticeIds.has(item.id)) return;
      noticeIds.add(item.id);
      setNotices((state) => [...state.slice(-2), { ...item, expires: Date.now() + 7000 }]);
    };
    const heartbeat = async () => {
      if (!current() || !connectionRef.current || heartbeatPending) return;
      heartbeatPending = true;
      const version = epoch.current;
      try { await post('/api/social/presence', { connection: connectionRef.current }); }
      catch (error) { if (current() && version === epoch.current && !(error instanceof DOMException && error.name === 'AbortError')) restart(); }
      finally { if (version === epoch.current) heartbeatPending = false; }
    };
    const restart = () => {
      if (!current()) { syncAccount(); return; }
      if (restartTimer) return;
      connectionGeneration++;
      invalidateRequests();
      source?.close();
      loads.current.clear(); loadCounts.current.clear(); readPending.current.clear(); sendingRef.current.clear();
      setLoading({}); setSending({});
      heartbeatPending = false;
      connectionRef.current = '';
      setStatus('reconnecting');
      retryDelay = Math.min(retryDelay * 2, 30000);
      restartTimer = setTimeout(() => { restartTimer = undefined; connect(); }, retryDelay);
    };
    const connect = () => {
      if (!current()) return;
      const generation = ++connectionGeneration;
      const stream = new EventSource('/api/social/stream');
      source = stream;
      const listen = (event: string, callback: (data: unknown) => void) => stream.addEventListener(event, (message) => {
        if (!current() || source !== stream || generation !== connectionGeneration) return;
        try { callback(JSON.parse((message as MessageEvent).data)); } catch { restart(); }
      });
      listen('hello', (value) => {
        const data = value as { connection: string; username: string };
        if (data.username !== account) { restart(); return; }
        invalidateRequests();
        cache.current = {}; historyCursors.current.clear(); loads.current.clear(); loadCounts.current.clear(); readAcks.current.clear(); readPending.current.clear();
        setThreads({}); setLoading({}); setErrors({});
        sendingRef.current.clear(); setSending({});
        connectionRef.current = data.connection;
        firstSnapshot = true;
        presenceVersions.clear();
        heartbeatPending = false;
        void heartbeat();
      });
      listen('snapshot', (value) => {
        const data = value as { users: SocialUser[] };
        if (!Array.isArray(data.users)) return;
        data.users.forEach((user) => presenceVersions.set(user.username, Math.max(presenceVersions.get(user.username) || 0, user.version)));
        const previous = new Map(usersRef.current.map((user) => [user.username, user]));
        if (!firstSnapshot) data.users.forEach((user) => {
          const before = previous.get(user.username);
          if (before && user.unread > before.unread && user.lastMessage?.sender !== account) notice({ id: `message:${user.username}:${user.latest}`, username: user.username, kind: 'message' });
        });
        firstSnapshot = false;
        usersRef.current = data.users;
        setUsers(data.users);
        retryDelay = 1000;
        setStatus('connected');
        const selected = peerRef.current;
        if (selected) {
          const user = data.users.find((item) => item.username === selected);
          if (!user) { setPeer(null); return; }
          const cursor = historyCursors.current.get(selected);
          if (cursor === undefined || cursor < user.latest) void loadRef.current?.(selected);
        }
      });
      listen('presence', (value) => {
        const user = value as { username: string; online: boolean; version: number };
        if ((presenceVersions.get(user.username) || 0) > user.version) return;
        presenceVersions.set(user.username, user.version);
        if (!firstSnapshot && user.online && user.username !== account) notice({ id: `online:${user.username}:${user.version}`, username: user.username, kind: 'online' });
      });
      listen('heartbeat', () => { void heartbeat(); });
      listen('auth-error', () => { stream.close(); setAccount(null); });
      stream.onerror = () => {
        if (!current()) syncAccount();
        else if (source === stream && generation === connectionGeneration) restart();
      };
    };
    const regainFocus = () => { if (current()) void heartbeat(); else syncAccount(); };
    setStatus('connecting');
    connect();
    window.addEventListener('focus', regainFocus);
    window.addEventListener('online', restart);
    return () => {
      active = false; invalidateRequests(); source?.close(); connectionRef.current = '';
      if (restartTimer) clearTimeout(restartTimer);
      window.removeEventListener('focus', regainFocus); window.removeEventListener('online', restart);
    };
  }, [account, post, syncAccount]);

  useEffect(() => {
    const expiring = notices.filter((item) => item.kind !== 'online' || !sending[item.username]);
    if (!expiring.length) return;
    const timer = setTimeout(() => setNotices((state) => state.filter((item) => item.expires > Date.now() || (item.kind === 'online' && sending[item.username]))), Math.max(1, Math.min(...expiring.map((item) => item.expires)) - Date.now()));
    return () => clearTimeout(timer);
  }, [notices, sending]);

  const selectPeer = (username: string) => { setPeer(username); setOpen(true); setAtBottom(true); };
  useEffect(() => { if (open && peer && status === 'connected') void loadHistory(peer); }, [open, peer, status, loadHistory]);
  const messages = useMemo(() => peer ? threads[peer] || [] : [], [peer, threads]);
  const lastSeq = messages[messages.length - 1]?.seq || 0;
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!open || !viewport) return;
    const anchor = scrollAnchor.current;
    scrollAnchor.current = null;
    if (anchor && anchor.user === peer && anchor.version === epoch.current) {
      const element = viewport.querySelector<HTMLElement>(`[data-chat-seq="${anchor.seq}"]`);
      if (element) viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
    } else if (atBottom) viewport.scrollTop = viewport.scrollHeight;
  }, [open, peer, messages, atBottom]);

  useEffect(() => {
    const readSeq = peer ? Math.min(lastSeq, historyCursors.current.get(peer) || 0) : 0;
    if (!account || !open || !peer || !focused || !atBottom || status !== 'connected' || loading[peer] || loadCounts.current.get(peer) || !readSeq || (readAcks.current.get(peer) || 0) >= readSeq || readPending.current.has(peer)) return;
    const version = epoch.current;
    readPending.current.add(peer);
    let succeeded = false;
    void post<{ read: number }>('/api/social/read', { peer, seq: readSeq }).then((result) => {
      if (version === epoch.current) { readAcks.current.set(peer, Math.max(readAcks.current.get(peer) || 0, result.read)); succeeded = true; }
    }).catch(() => undefined).finally(() => {
      if (version === epoch.current) { readPending.current.delete(peer); if (succeeded) setUsers((state) => [...state]); }
    });
  }, [account, open, peer, focused, atBottom, status, lastSeq, users, loading, post]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', close); };
  }, [open]);

  const sendMessage = async (username: string, text: string) => {
    const value = text.trim();
    if (!account || status !== 'connected' || !value || value.length > CHAT_TEXT_LIMIT || sendingRef.current.has(username)) return false;
    const version = epoch.current;
    let requestId: string | undefined;
    try {
      const previous = attempts.current.get(username);
      const attempt = previous?.text === value ? previous : { id: messageId(), text: value };
      requestId = attempt.id;
      attempts.current.set(username, attempt); sendingRef.current.set(username, attempt.id);
      setSending((state) => ({ ...state, [username]: true }));
      const message = await post<ChatMessage>('/api/social/messages', { peer: username, ...attempt });
      if (version !== epoch.current) return false;
      mergeMessages(username, [message]);
      attempts.current.delete(username);
      setDrafts((state) => state[username]?.trim() === value ? { ...state, [username]: '' } : state);
      setErrors((state) => ({ ...state, [username]: '' }));
      return true;
    } catch (error) {
      if (version === epoch.current && !(error instanceof DOMException && error.name === 'AbortError')) setErrors((state) => ({ ...state, [username]: error instanceof Error ? error.message : '发送失败，可重试' }));
      return false;
    } finally {
      if (version === epoch.current && requestId && sendingRef.current.get(username) === requestId) {
        sendingRef.current.delete(username);
        setSending((state) => ({ ...state, [username]: false }));
      }
    }
  };

  const unread = users.reduce((sum, user) => sum + user.unread, 0);
  const selected = users.find((user) => user.username === peer);
  const statusLabel = status === 'connected' ? '已连接' : status === 'connecting' ? '连接中…' : '正在重连，状态待同步…';
  const openNotice = async (notice: Notice) => {
    const version = epoch.current;
    if (notice.kind === 'online') {
      if (status !== 'connected' || sendingRef.current.has(notice.username)) return;
      setNotices((state) => state.map((item) => item.id === notice.id ? { ...item, error: undefined } : item));
      const sent = await sendMessage(notice.username, '👋');
      if (version !== epoch.current || accountRef.current !== getAuthInfoFromBrowserCookie()?.username) return;
      setNotices((state) => sent ? state.filter((item) => item.id !== notice.id) : state.map((item) => item.id === notice.id ? { ...item, error: '发送失败，请重试', expires: Date.now() + 7000 } : item));
      return;
    }
    if (getFullscreenElement()) {
      const fullscreenDocument = document as FullscreenDocument;
      const exit = fullscreenDocument.exitFullscreen || fullscreenDocument.webkitExitFullscreen;
      if (!exit) return;
      try { await exit.call(document); } catch { return; }
    }
    if (version !== epoch.current || accountRef.current !== getAuthInfoFromBrowserCookie()?.username) return;
    selectPeer(notice.username);
    setNotices((state) => state.filter((item) => item.id !== notice.id));
  };
  return (
    <SocialContext.Provider value={account ? { unread, open: () => setOpen(true) } : null}>
      {children}
      {account && noticeHost && createPortal(<div className='fixed right-4 top-16 z-[10020] flex max-w-[calc(100vw-2rem)] cursor-auto flex-col gap-2 text-gray-900 [text-shadow:none] dark:text-gray-100' aria-live='polite' onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        {notices.map((notice) => <div key={notice.id} className='flex items-center gap-3 rounded-xl border border-gray-300 bg-white px-4 py-3 shadow-xl shadow-black/20 dark:border-gray-600 dark:bg-gray-800'>
          <div className='min-w-0 flex-1'>
            <p className='text-base font-medium leading-6 [overflow-wrap:anywhere]'><span className='font-semibold'>{notice.username}</span>{notice.kind === 'online' ? ' 上线了' : ' 发来了私信'}</p>
            {notice.error && <p role='alert' className='mt-1 text-xs text-red-600 dark:text-red-400'>{notice.error}</p>}
          </div>
          <button type='button' disabled={notice.kind === 'online' && (status !== 'connected' || sending[notice.username])} className='flex-shrink-0 whitespace-nowrap rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50 dark:bg-blue-500/20 dark:text-blue-300 dark:hover:bg-blue-500/30' onClick={() => void openNotice(notice)}>{notice.kind === 'online' ? sending[notice.username] ? '发送中…' : '打个招呼' : '查看'}</button>
          <button type='button' aria-label='关闭提醒' className='flex-shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100' onClick={() => setNotices((state) => state.filter((item) => item.id !== notice.id))}><X size={17} /></button>
        </div>)}
      </div>, noticeHost)}
      {account && open && <div className='fixed inset-0 z-[10010] flex items-center justify-center bg-black/40 p-3 backdrop-blur-sm' onClick={() => setOpen(false)}>
        <section role='dialog' aria-modal='true' aria-label='站内消息' className='flex h-[min(680px,85dvh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900' onClick={(event) => event.stopPropagation()}>
          <header className='flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700'>
            <div><h2 className='flex items-center gap-2 font-semibold'><Users size={19} />站内消息</h2><p className={`mt-1 text-xs ${status === 'connected' ? 'text-green-600' : 'text-amber-500'}`}>{statusLabel}</p></div>
            <button type='button' aria-label='关闭站内消息' onClick={() => setOpen(false)} className='rounded-full p-2 hover:bg-gray-100 dark:hover:bg-gray-800'><X size={20} /></button>
          </header>
          <div className='flex min-h-0 flex-1'>
            <aside className={`${peer ? 'hidden sm:block' : 'block'} w-full overflow-y-auto border-r border-gray-200 sm:w-56 sm:flex-shrink-0 dark:border-gray-700`}>
              {!users.length && <p className='p-5 text-sm text-gray-500'>{status === 'connected' ? '暂无其他用户' : '正在获取用户…'}</p>}
              {[...users].sort((a, b) => Number(b.online) - Number(a.online) || (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0) || a.username.localeCompare(b.username)).map((user) => <button type='button' key={user.username} onClick={() => selectPeer(user.username)} className={`w-full px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-800 ${peer === user.username ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}>
                <span className='flex min-w-0 items-center gap-2'><span className={`h-2 w-2 flex-shrink-0 rounded-full ${status !== 'connected' ? 'bg-amber-400' : user.online ? 'bg-green-500' : 'bg-gray-400'}`} /><span className='min-w-0 truncate font-medium'>{user.username}</span><UnreadBadge count={user.unread} /></span>
                <span className='mt-1 block truncate text-xs text-gray-500'>{user.lastMessage?.text || (status !== 'connected' ? '状态待同步' : user.online ? '在线，可以打个招呼' : '离线，可以留言')}</span>
              </button>)}
            </aside>
            <div className={`${peer ? 'flex' : 'hidden sm:flex'} min-w-0 flex-1 flex-col`}>
              {!peer ? <div className='flex flex-1 items-center justify-center p-5 text-sm text-gray-500'>选择一位朋友开始聊天</div> : <>
                <div className='flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-800'><div className='flex min-w-0 items-center gap-2'><button type='button' aria-label='返回用户列表' className='p-1 sm:hidden' onClick={() => setPeer(null)}><ArrowLeft size={19} /></button><span className='truncate font-medium'>{peer}</span><span className='whitespace-nowrap text-xs text-gray-500'>{status !== 'connected' ? '状态待同步' : selected?.online ? '在线' : '离线'}</span><span role='status' className='w-12 flex-shrink-0 whitespace-nowrap text-xs text-gray-400'>{loading[peer] ? '同步中…' : ''}</span></div><button type='button' disabled={status !== 'connected' || sending[peer]} className='whitespace-nowrap px-2 text-sm text-blue-500 disabled:opacity-50' onClick={() => void sendMessage(peer, '👋')}>打招呼 👋</button></div>
                <div ref={scrollRef} className='min-h-0 flex-1 space-y-3 overflow-y-auto p-4 [overflow-anchor:none]' onScroll={(event) => { const element = event.currentTarget; setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 60); }}>
                  {messages[0]?.seq > 1 && <button type='button' disabled={loading[peer]} className='block w-full text-center text-xs text-blue-500' onClick={() => { setAtBottom(false); void loadHistory(peer, true); }}>加载更早的消息</button>}
                  {!messages.length && <p className='py-8 text-center text-sm text-gray-500'>{loading[peer] ? '正在加载消息…' : '还没有消息，打个招呼吧'}</p>}
                  {messages.map((message) => <div key={message.seq} data-chat-seq={message.seq} className={`flex ${message.sender === account ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] rounded-xl px-3 py-2 ${message.sender === account ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-800'}`}><p className='whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]'>{message.text}</p><time className='mt-1 block text-right text-[10px] opacity-60' dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div></div>)}
                </div>
                {!atBottom && <button type='button' className='py-1 text-center text-xs text-blue-500' onClick={() => setAtBottom(true)}>回到最新消息</button>}
                {errors[peer] && <div role='alert' className='flex items-center justify-between gap-2 px-3 py-2 text-xs text-red-500'><span>{errors[peer]}</span><button type='button' className='flex-shrink-0' onClick={() => { const attempt = attempts.current.get(peer); if (attempt) void sendMessage(peer, attempt.text); else void loadHistory(peer); }}>重试</button></div>}
                <form className='flex items-end gap-2 border-t border-gray-200 p-3 dark:border-gray-700' onSubmit={(event) => { event.preventDefault(); void sendMessage(peer, drafts[peer] || ''); }}>
                  <textarea aria-label={`给 ${peer} 发私信`} value={drafts[peer] || ''} maxLength={CHAT_TEXT_LIMIT} rows={2} placeholder='输入消息，Enter 发送，Shift+Enter 换行' className='min-w-0 flex-1 resize-none rounded-lg border border-gray-300 bg-transparent p-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600' onChange={(event) => setDrafts((state) => ({ ...state, [peer]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(peer, drafts[peer] || ''); } }} />
                  <button type='submit' aria-label='发送私信' disabled={status !== 'connected' || sending[peer] || !(drafts[peer] || '').trim()} className='flex h-10 w-24 flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg bg-blue-500 px-3 text-sm text-white hover:bg-blue-600 disabled:opacity-50'><Send size={16} />{sending[peer] ? '发送中' : '发送'}</button>
                </form>
              </>}
            </div>
          </div>
        </section>
      </div>}
    </SocialContext.Provider>
  );
}
