'use client';

import Artplayer from 'artplayer';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { type PlayRecord, syncMediaProgressCache } from '@/lib/db.client';
import { type MediaView, mediaCover, mediaDuration } from '@/lib/media';
import {
  currentMediaAccount,
  MediaClientError,
  mediaRequest,
} from '@/lib/media.client';

import PageLayout from '@/components/PageLayout';

function MediaPlayer() {
  const { id } = useParams<{ id: string }>();
  const container = useRef<HTMLDivElement>(null);
  const [item, setItem] = useState<MediaView | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    let active = true;
    let art: Artplayer | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let playing = false;
    let contentRevision: string | undefined;
    let saving = false;
    let progressInvalid = false;
    let saveSequence = 0;
    const session = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    let finalPosition = -1;
    let finalAt = 0;
    const account = currentMediaAccount();
    const controller = new AbortController();
    const current = () => active && account === currentMediaAccount();
    setItem(null);
    setError('');
    setNote('');
    const save = async (leaving = false) => {
      if (
        !current() ||
        progressInvalid ||
        !art ||
        !playing ||
        (!leaving && saving)
      )
        return;
      const position = art.currentTime;
      if (!Number.isFinite(position)) return;
      if (leaving && finalPosition === position && Date.now() - finalAt < 1000)
        return;
      if (leaving) {
        finalPosition = position;
        finalAt = Date.now();
      } else saving = true;
      const sequence = ++saveSequence;
      try {
        const result = await mediaRequest<PlayRecord>(
          `/api/media/${id}/progress`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              play_time: position,
              media_session: session,
              media_seq: sequence,
              media_revision: contentRevision,
            }),
            keepalive: leaving,
            ...(leaving ? {} : { signal: controller.signal }),
          }
        );
        if (account === currentMediaAccount() && sequence === saveSequence) {
          syncMediaProgressCache(id, result, account);
          if (active) setNote('');
        }
      } catch (failure) {
        if (
          current() &&
          failure instanceof MediaClientError &&
          (failure.status === 404 ||
            failure.code === 'MEDIA_CHANGED' ||
            failure.code === 'SOURCE_UNAVAILABLE' ||
            failure.code === 'MEDIA_UNAVAILABLE')
        ) {
          progressInvalid = true;
          saveSequence++;
          if (interval) clearInterval(interval);
          syncMediaProgressCache(id, null, account);
          art?.pause();
          setError(
            failure.code === 'MEDIA_CHANGED'
              ? '视频内容已更新，请重新打开'
              : '视频已被移除或暂不可用，请返回共享视频'
          );
          return;
        }
        if (current() && sequence === saveSequence)
          setNote(`进度暂未保存：${(failure as Error).message}`);
      } finally {
        if (!leaving) saving = false;
      }
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') void save(true);
    };
    const pagehide = () => {
      void save(true);
    };
    const focus = () => {
      if (account !== currentMediaAccount()) {
        art?.destroy(false);
        art = undefined;
        setError('账号已切换，请返回共享视频重新打开');
      }
    };
    const load = async () => {
      try {
        const [metadata, progress] = await Promise.all([
          mediaRequest<MediaView>(`/api/media/${id}`, {
            signal: controller.signal,
          }),
          mediaRequest<PlayRecord | null>(`/api/media/${id}/progress`, {
            signal: controller.signal,
          }),
        ]);
        if (!current() || !container.current) return;
        contentRevision = metadata.contentRevision;
        setItem(metadata);
        Artplayer.FULLSCREEN_WEB_IN_BODY = true;
        art = new Artplayer({
          container: container.current,
          url: `/api/media/${id}/stream`,
          type: 'mp4',
          poster: mediaCover(metadata),
          theme: '#22c55e',
          volume: 0.7,
          autoplay: true,
          fullscreen: true,
          fullscreenWeb: true,
          playbackRate: true,
          aspectRatio: true,
          hotkey: true,
          pip: true,
          playsInline: true,
          autoSize: false,
        });
        let resumed = false;
        art.on('video:loadedmetadata', () => {
          if (!resumed && art) {
            resumed = true;
            const time = progress?.play_time || 0;
            if (time > 0 && time < metadata.duration - 5)
              art.currentTime = time;
          }
        });
        art.on('video:play', () => {
          playing = true;
        });
        art.on('video:pause', () => {
          void save();
        });
        art.on('video:seeked', () => {
          void save();
        });
        art.on('video:ended', () => {
          void save();
        });
        art.on('video:error', () => {
          if (current())
            setError(
              '视频暂时无法播放，请刷新页面重试；视频可能已被移除或连接中断'
            );
        });
        interval = setInterval(() => {
          if (art?.playing) void save();
        }, 10000);
      } catch (failure) {
        if (current() && !controller.signal.aborted) {
          if (failure instanceof MediaClientError && failure.status === 404)
            syncMediaProgressCache(id, null, account);
          setError((failure as Error).message);
        }
      }
    };
    void load();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('focus', focus);
    return () => {
      // 导航前保留一次进度；请求不依赖即将销毁的播放器。
      void save(true);
      active = false;
      controller.abort();
      if (interval) clearInterval(interval);
      art?.destroy(false);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('focus', focus);
    };
  }, [id]);
  return (
    <PageLayout activePath='/media/play'>
      <div className='mx-auto max-w-6xl px-3 py-6 sm:px-10 sm:py-12'>
        <Link
          href='/media'
          className='mb-4 inline-block text-sm text-gray-500 hover:text-green-600'
        >
          返回共享视频
        </Link>
        <h1 className='mb-4 break-words text-xl font-semibold'>
          {item?.title || '共享视频'}
        </h1>
        <div className='aspect-video w-full overflow-hidden rounded-xl bg-black'>
          <div ref={container} className='h-full w-full' />
        </div>
        {item && (
          <p className='mt-3 text-sm text-gray-500'>
            {mediaDuration(item.duration)} · {item.width} × {item.height}
          </p>
        )}
        {!item && !error && (
          <p className='mt-4 text-sm text-gray-500'>正在加载视频…</p>
        )}
        {error && (
          <p role='alert' className='mt-4 text-sm text-red-500'>
            {error}
          </p>
        )}
        {note && (
          <p role='status' className='mt-3 text-xs text-amber-600'>
            {note}
          </p>
        )}
      </div>
    </PageLayout>
  );
}
export default function MediaPlaybackPage() {
  return (
    <Suspense>
      <MediaPlayer />
    </Suspense>
  );
}
