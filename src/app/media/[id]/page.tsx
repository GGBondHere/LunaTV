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
  const [playbackNote, setPlaybackNote] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const retryPlayback = useRef<() => void>(() => undefined);
  useEffect(() => {
    let active = true;
    let art: Artplayer | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let playing = false;
    let contentRevision: string | undefined;
    let videoCodec: MediaView['videoCodec'];
    let saving = false;
    let progressInvalid = false;
    let saveSequence = 0;
    const openedAt = performance.now();
    let metadataMs = 0;
    let firstFrame = false;
    let lastPosition = 0;
    let resumePosition = 0;
    let wantsPlay = true;
    let recovering = false;
    let playbackFailed = false;
    let attempts = 0;
    let generation = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveryProbe: AbortController | undefined;
    let video: HTMLVideoElement | undefined;
    let stallAt = 0;
    let seekAt = 0;
    let stableAt = 0;
    let loading = false;
    let playAttempt: Promise<void> | undefined;
    const session = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    let finalPosition = -1;
    let finalAt = 0;
    const account = currentMediaAccount();
    const controller = new AbortController();
    const current = () =>
      active && !controller.signal.aborted && account === currentMediaAccount();
    setItem(null);
    setError('');
    setNote('');
    setPlaybackNote('');
    setCanRetry(false);
    const clearRecovery = () => {
      generation++;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      if (stallTimer) clearTimeout(stallTimer);
      recoveryTimer = undefined;
      stallTimer = undefined;
      recoveryProbe?.abort();
      recoveryProbe = undefined;
    };
    const probeStream = async (parent: AbortSignal) => {
      const stop = new AbortController();
      const abort = () => stop.abort();
      parent.addEventListener('abort', abort, { once: true });
      if (parent.aborted) stop.abort();
      const timer = setTimeout(abort, 10000);
      try {
        const response = await fetch(`/api/media/${id}/stream`, {
          headers: { Range: 'bytes=0-0' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: stop.signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new MediaClientError(
            data.error || '视频文件暂不可读取',
            response.status,
            data.code
          );
        }
        await response.body?.cancel();
        if (response.status !== 206)
          throw new MediaClientError('视频存储未正确响应分段读取', 502);
      } catch (failure) {
        if (stop.signal.aborted && !parent.aborted)
          throw new MediaClientError('视频存储响应超时，请稍后重试');
        throw failure;
      } finally {
        clearTimeout(timer);
        parent.removeEventListener('abort', abort);
      }
    };
    const tryPlay = () => {
      if (!current() || !art || !wantsPlay || progressInvalid || playAttempt)
        return;
      art.loading.show = true;
      art.mask.show = false;
      const ticket = generation;
      const attempt: Promise<void> = art
        .play()
        .catch((failure) => {
          if (!current() || !wantsPlay || ticket !== generation || video?.error)
            return;
          if ((failure as Error).name === 'AbortError') return;
          clearRecovery();
          wantsPlay = false;
          if (art) {
            art.loading.show = false;
            art.mask.show = true;
            art.controls.show = true;
          }
          setPlaybackNote('请点击播放继续');
        })
        .finally(() => {
          if (playAttempt === attempt) playAttempt = undefined;
        });
      playAttempt = attempt;
    };
    const stopPlayback = (message: string, invalid = false) => {
      if (!recovering) resumePosition = lastPosition;
      playbackFailed = true;
      clearRecovery();
      recovering = false;
      if (invalid) progressInvalid = true;
      wantsPlay = false;
      art?.pause();
      if (video) {
        video.removeAttribute('src');
        video.load();
      }
      if (current()) {
        setPlaybackNote('');
        setError(message);
        setCanRetry(!invalid);
      }
    };
    const scheduleRecovery = () => {
      if (
        !current() ||
        !wantsPlay ||
        progressInvalid ||
        recoveryTimer ||
        recoveryProbe ||
        !art
      )
        return;
      if (!recovering) {
        resumePosition = lastPosition;
        recovering = true;
        stableAt = 0;
      }
      if (!navigator.onLine) {
        setPlaybackNote('网络已断开，恢复后继续重试');
        return;
      }
      if (attempts >= 3) {
        stopPlayback('连接暂未恢复，可稍后重试播放');
        return;
      }
      attempts++;
      const ticket = ++generation;
      setError('');
      setCanRetry(false);
      setPlaybackNote(`正在恢复播放连接（${attempts}/3）`);
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (!current() || ticket !== generation || !art) return;
        const probe = new AbortController();
        recoveryProbe = probe;
        const abort = () => probe.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, 10000);
        let retry = false;
        void (async () => {
          try {
            const metadata = await mediaRequest<MediaView>(`/api/media/${id}`, {
              signal: probe.signal,
              timeoutMs: 10000,
            });
            if (!current() || ticket !== generation || !art) return;
            if (metadata.contentRevision !== contentRevision) {
              syncMediaProgressCache(id, null, account);
              stopPlayback('视频内容已更新，请重新打开', true);
              return;
            }
            await probeStream(probe.signal);
            if (!current() || ticket !== generation || !art) return;
            art.option.autoplay = false;
            art.video.src = `/api/media/${id}/stream`;
            art.video.load();
            recoveryTimer = setTimeout(() => {
              recoveryTimer = undefined;
              if (current() && ticket === generation && recovering)
                scheduleRecovery();
            }, 15000);
          } catch (failure) {
            if (!current() || ticket !== generation) return;
            if (
              failure instanceof MediaClientError &&
              [401, 403, 404, 409].includes(failure.status)
            ) {
              if (failure.status === 404 || failure.code === 'MEDIA_CHANGED')
                syncMediaProgressCache(id, null, account);
              stopPlayback(failure.message, true);
            } else retry = true;
          } finally {
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', abort);
            if (recoveryProbe === probe) recoveryProbe = undefined;
            if (retry && current() && ticket === generation) scheduleRecovery();
          }
        })();
      }, 1000 * 2 ** (attempts - 1));
    };
    const nativeError = (event: Event) => {
      // This instance owns reconnection; do not race Artplayer's built-in URL resets.
      event.stopImmediatePropagation();
      if (!current() || !video || progressInvalid || video.error?.code === 1)
        return;
      if (videoCodec === 'hevc' && [3, 4].includes(video.error?.code || 0)) {
        stopPlayback('此 H.265 视频解码失败，请换用支持 H.265 的浏览器或设备');
        return;
      }
      scheduleRecovery();
    };
    const online = () => {
      if (current() && recovering && wantsPlay) {
        attempts = 0;
        scheduleRecovery();
      }
    };
    const offline = () => {
      if (current() && wantsPlay)
        setPlaybackNote('网络已断开，已缓冲的内容仍可播放');
    };
    retryPlayback.current = () => {
      if (!current() || progressInvalid) return;
      if (!art) {
        void load();
        return;
      }
      attempts = 0;
      wantsPlay = true;
      scheduleRecovery();
    };
    const save = async (leaving = false) => {
      if (
        !current() ||
        progressInvalid ||
        !art ||
        !playing ||
        (!leaving && saving)
      )
        return;
      const position =
        recovering || playbackFailed ? resumePosition : art.currentTime;
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
          saveSequence++;
          if (interval) clearInterval(interval);
          syncMediaProgressCache(id, null, account);
          stopPlayback(
            failure.code === 'MEDIA_CHANGED'
              ? '视频内容已更新，请重新打开'
              : '视频已被移除或暂不可用，请返回共享视频',
            true
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
        clearRecovery();
        controller.abort();
        art?.destroy(false);
        art = undefined;
        setError('账号已切换，请返回共享视频重新打开');
      }
    };
    const load = async () => {
      if (loading || art || !current()) return;
      loading = true;
      setError('');
      setCanRetry(false);
      const boot = new AbortController();
      const abort = () => boot.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        const [metadata, progress] = await Promise.all([
          mediaRequest<MediaView>(`/api/media/${id}`, {
            signal: boot.signal,
          }),
          mediaRequest<PlayRecord | null>(`/api/media/${id}/progress`, {
            signal: boot.signal,
          }),
          probeStream(boot.signal),
        ]);
        if (!current() || !container.current) return;
        contentRevision = metadata.contentRevision;
        videoCodec = metadata.videoCodec;
        metadataMs = performance.now() - openedAt;
        setItem(metadata);
        Artplayer.FULLSCREEN_WEB_IN_BODY = true;
        art = new Artplayer({
          container: container.current,
          url: `/api/media/${id}/stream`,
          type: 'mp4',
          poster: mediaCover(metadata),
          theme: '#22c55e',
          volume: 0.7,
          autoplay: false,
          fullscreen: true,
          fullscreenWeb: true,
          playbackRate: true,
          aspectRatio: true,
          hotkey: true,
          pip: true,
          playsInline: true,
          autoSize: false,
          moreVideoAttr: { preload: 'auto' },
        });
        video = art.video;
        video.addEventListener('error', nativeError, true);
        let resumed = false;
        art.on('video:loadedmetadata', () => {
          if (
            current() &&
            (!resumed || recovering) &&
            art &&
            !progressInvalid
          ) {
            resumed = true;
            const time = recovering ? resumePosition : progress?.play_time || 0;
            if (time > 0 && (recovering || time < metadata.duration - 5)) {
              art.currentTime = Math.min(
                time,
                Math.max(0, metadata.duration - 0.25)
              );
              lastPosition = art.currentTime;
            }
            tryPlay();
          }
        });
        art.on('ready', () => {
          if (current() && wantsPlay && !firstFrame && art) {
            art.mask.show = false;
            art.loading.show = true;
            tryPlay();
          }
        });
        art.on('video:play', () => {
          if (!current() || progressInvalid) {
            art?.pause();
            return;
          }
          playing = true;
          wantsPlay = true;
        });
        art.on('video:pause', () => {
          if (firstFrame && !recovering && !art?.video.error) wantsPlay = false;
          void save();
        });
        art.on('pause', () => {
          wantsPlay = false;
          if (recovering) {
            clearRecovery();
            setPlaybackNote('已暂停连接恢复');
            setCanRetry(true);
          }
        });
        art.on('video:timeupdate', () => {
          if (
            current() &&
            art &&
            !recovering &&
            !playbackFailed &&
            Number.isFinite(art.currentTime)
          )
            lastPosition = art.currentTime;
          if (
            current() &&
            !recovering &&
            !playbackFailed &&
            art?.playing &&
            stableAt &&
            performance.now() - stableAt > 30000
          )
            attempts = 0;
        });
        art.on('video:seeking', () => {
          if (!current() || !art) return;
          seekAt = performance.now();
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = undefined;
          if (Number.isFinite(art.currentTime) && art.video.readyState >= 1) {
            lastPosition = art.currentTime;
            if (recovering) resumePosition = lastPosition;
          }
          if (wantsPlay && !recovering)
            stallTimer = setTimeout(() => {
              stallTimer = undefined;
              if (current() && wantsPlay && art?.video.seeking)
                scheduleRecovery();
            }, 15000);
        });
        art.on('video:seeked', () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = undefined;
          if (current() && wantsPlay && art) {
            art.mask.show = false;
            if (!firstFrame || recovering) tryPlay();
          }
          if (current() && seekAt) {
            // eslint-disable-next-line no-console
            console.info('[media-playback]', {
              id,
              phase: 'seek',
              milliseconds: Math.round(performance.now() - seekAt),
            });
            seekAt = 0;
          }
          void save();
        });
        art.on('video:ended', () => {
          void save();
        });
        art.on('video:playing', () => {
          if (!current() || progressInvalid) return;
          if (art) art.loading.show = false;
          if (!firstFrame) {
            firstFrame = true;
            // eslint-disable-next-line no-console
            console.info('[media-playback]', {
              id,
              phase: 'first-frame',
              metadataMs: Math.round(metadataMs),
              milliseconds: Math.round(performance.now() - openedAt),
            });
          }
          if (stallAt) {
            // eslint-disable-next-line no-console
            console.info('[media-playback]', {
              id,
              phase: 'stall',
              milliseconds: Math.round(performance.now() - stallAt),
            });
            stallAt = 0;
          }
          recovering = false;
          playbackFailed = false;
          clearRecovery();
          stableAt = performance.now();
          if (art && Number.isFinite(art.currentTime))
            lastPosition = art.currentTime;
          setPlaybackNote('');
          setError('');
          setCanRetry(false);
        });
        const waiting = () => {
          if (
            !current() ||
            !art ||
            !wantsPlay ||
            art.video.seeking ||
            recovering
          )
            return;
          if (!stallAt) stallAt = performance.now();
          if (stallTimer) return;
          stallTimer = setTimeout(() => {
            stallTimer = undefined;
            if (
              current() &&
              wantsPlay &&
              art &&
              !art.video.seeking &&
              art.video.readyState < 3
            )
              scheduleRecovery();
          }, 8000);
        };
        art.on('video:waiting', waiting);
        art.on('video:stalled', waiting);
        interval = setInterval(() => {
          if (art?.playing) void save();
        }, 10000);
      } catch (failure) {
        if (current() && !controller.signal.aborted) {
          if (failure instanceof MediaClientError && failure.status === 404)
            syncMediaProgressCache(id, null, account);
          setError((failure as Error).message);
          setCanRetry(
            !(
              failure instanceof MediaClientError &&
              [401, 403, 404, 409].includes(failure.status)
            )
          );
        }
      } finally {
        loading = false;
        controller.signal.removeEventListener('abort', abort);
        boot.abort();
      }
    };
    void load();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('focus', focus);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      // 导航前保留一次进度；请求不依赖即将销毁的播放器。
      void save(true);
      active = false;
      clearRecovery();
      controller.abort();
      if (interval) clearInterval(interval);
      art?.destroy(false);
      video?.removeEventListener('error', nativeError, true);
      retryPlayback.current = () => undefined;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
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
        {(error || canRetry) && (
          <p role='alert' className='mt-4 text-sm text-red-500'>
            {error}
            {canRetry && (
              <button
                type='button'
                onClick={() => retryPlayback.current()}
                className='ml-3 text-green-600 hover:text-green-500'
              >
                重试播放
              </button>
            )}
          </p>
        )}
        <p role='status' className='mt-3 min-h-5 text-xs text-amber-600'>
          {playbackNote || note || '\u00a0'}
        </p>
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
