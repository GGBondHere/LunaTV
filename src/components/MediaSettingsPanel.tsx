'use client';

import { Cloud, FolderSearch, HardDrive, Upload } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  type MediaAdminPolicy,
  type MediaConnectionCheck,
  type MediaConnectionView,
  type MediaScanSettings,
  type MediaScanStatus,
  DEFAULT_LOCAL_SCAN,
  formatMediaBytes,
} from '@/lib/media';
import {
  currentMediaAccount,
  mediaChanged,
  mediaJSON,
  mediaRequest,
} from '@/lib/media.client';

type ConnectionDraft = MediaConnectionView & {
  password: string;
  clearPassword?: boolean;
};
const inputClass =
  'mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';
const buttonClass =
  'rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';
const checkClass =
  'h-4 w-4 rounded border-gray-300 text-blue-600 focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:checked:border-transparent dark:checked:bg-blue-600';
const hintClass = 'text-xs leading-5 text-gray-500 dark:text-gray-400';
const stateNames = {
  running: '正在扫描',
  stopping: '正在停止',
  completed: '已完成',
  cancelled: '已停止',
  interrupted: '未完成',
  failed: '失败',
};
const bytes = (value: number | null | undefined) =>
  value == null ? '未知' : formatMediaBytes(value);
const connectionDraft = (c: MediaConnectionView): ConnectionDraft => ({
  ...c,
  password: '',
});
function signature(c: ConnectionDraft) {
  return JSON.stringify([
    c.id,
    c.url,
    c.root,
    c.username,
    c.password,
    !!c.clearPassword,
    c.scan,
  ]);
}
function newConnection(id: string = crypto.randomUUID()): ConnectionDraft {
  return {
    id,
    url: '',
    root: '/',
    username: '',
    password: '',
    hasPassword: false,
    scan: { ...DEFAULT_LOCAL_SCAN },
  };
}
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className='space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40'>
      <h3 className='flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100'>
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}
function ScanEditor({
  config,
  status,
  onChange,
  onStart,
  onStop,
  disabled,
  dirty,
  allowed = true,
}: {
  config: MediaScanSettings;
  status?: MediaScanStatus;
  onChange: (value: MediaScanSettings) => void;
  onStart: () => void;
  onStop: () => void;
  disabled: boolean;
  dirty: boolean;
  allowed?: boolean;
}) {
  return (
    <div className='space-y-3'>
      <label className='block text-sm'>
        扫描目录
        <input
          className={inputClass}
          value={config.root}
          onChange={(e) => onChange({ ...config, root: e.target.value })}
        />
      </label>
      <div className='grid items-end gap-3 sm:grid-cols-3'>
        <label className='flex items-center gap-2 py-2 text-sm'>
          <input
            className={checkClass}
            type='checkbox'
            checked={config.recursive}
            onChange={(e) =>
              onChange({ ...config, recursive: e.target.checked })
            }
          />
          包含子目录
        </label>
        <label className='flex items-center gap-2 py-2 text-sm'>
          <input
            className={checkClass}
            type='checkbox'
            checked={config.automatic}
            disabled={!allowed && !config.automatic}
            onChange={(e) =>
              onChange({ ...config, automatic: e.target.checked })
            }
          />
          自动扫描
        </label>
        <label className='text-sm'>
          间隔（分钟）
          <input
            className={inputClass}
            type='number'
            min='5'
            max='10080'
            value={config.intervalMinutes}
            onChange={(e) =>
              onChange({ ...config, intervalMinutes: Number(e.target.value) })
            }
          />
        </label>
      </div>
      {dirty && <p className={hintClass}>修改后请先保存，再开始扫描。</p>}
      <div className='flex flex-wrap gap-2'>
        <button
          type='button'
          className={buttonClass}
          disabled={
            disabled ||
            dirty ||
            !allowed ||
            status?.state === 'running' ||
            status?.state === 'stopping'
          }
          onClick={onStart}
        >
          立即扫描
        </button>
        <button
          type='button'
          className={buttonClass}
          disabled={disabled || status?.state !== 'running'}
          onClick={onStop}
        >
          停止扫描
        </button>
      </div>
      {status && (
        <div className='space-y-2 border-t border-gray-200 pt-3 text-sm dark:border-gray-700'>
          <p>
            {stateNames[status.state]} · 新增 {status.added} · 更新{' '}
            {status.updated} · 跳过 {status.skipped} · 失败 {status.failed} ·
            移除 {status.removed || 0}
          </p>
          <p className={hintClass}>
            已检查 {status.visited} 项 · 上次成功：
            {status.lastSuccessAt
              ? new Date(status.lastSuccessAt).toLocaleString()
              : '尚无'}
            {status.error ? ` · ${status.error}` : ''}
          </p>
          {!!status.details.length && (
            <details>
              <summary className='cursor-pointer text-xs text-gray-500'>
                查看扫描详情
              </summary>
              <ul className='mt-2 max-h-60 space-y-2 overflow-y-auto break-all text-xs'>
                {status.details.map((d, i) => (
                  <li key={i}>
                    {d.path}：{d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function MediaSettingsPanel() {
  const [policy, setPolicy] = useState<MediaAdminPolicy | null>(null);
  const [draft, setDraft] = useState({
    allowUploads: true,
    quotaGiB: '70',
    maxFileGiB: '4',
    minFreeGiB: '10',
    uploadStorage: 'local',
    remoteQuotaGiB: '',
    activeConnectionId: '',
  });
  const [connections, setConnections] = useState<ConnectionDraft[]>([]);
  const [localScan, setLocalScan] = useState({ ...DEFAULT_LOCAL_SCAN });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const connectionCheck = useRef<AbortController | null>(null);
  useEffect(() => () => connectionCheck.current?.abort(), []);
  const [checked, setChecked] = useState<{
    signature: string;
    result: MediaConnectionCheck;
  } | null>(null);
  const apply = useCallback((value: MediaAdminPolicy) => {
    setPolicy(value);
    setLocalScan(value.settings.localScan || { ...DEFAULT_LOCAL_SCAN });
    setDraft({
      allowUploads: value.settings.allowUploads,
      quotaGiB: String(value.settings.quotaGiB),
      maxFileGiB: String(value.settings.maxFileGiB),
      minFreeGiB: String(value.settings.minFreeGiB),
      uploadStorage: value.settings.uploadStorage || 'local',
      remoteQuotaGiB:
        value.settings.remoteQuotaGiB == null
          ? ''
          : String(value.settings.remoteQuotaGiB),
      activeConnectionId:
        value.settings.activeConnectionId ||
        value.settings.connections[0]?.id ||
        '',
    });
    setConnections(value.settings.connections.map(connectionDraft));
    setChecked(null);
  }, []);
  useEffect(() => {
    const stop = new AbortController();
    const account = currentMediaAccount();
    void mediaRequest<MediaAdminPolicy>('/api/admin/media', {
      signal: stop.signal,
    })
      .then((value) => {
        if (!stop.signal.aborted && currentMediaAccount() === account)
          apply(value);
      })
      .catch((e) => {
        if (!stop.signal.aborted && currentMediaAccount() === account)
          setError(e.message);
      });
    return () => stop.abort();
  }, [apply]);
  const watch =
    policy?.settings.localScan?.automatic ||
    policy?.settings.connections.some((c) => c.scan.automatic) ||
    policy?.scans.some((s) => s.state === 'running' || s.state === 'stopping');
  useEffect(() => {
    if (!watch) return;
    const stop = new AbortController();
    const account = currentMediaAccount();
    let pending = false;
    const timer = setInterval(() => {
      if (document.hidden || pending || account !== currentMediaAccount())
        return;
      pending = true;
      void mediaRequest<MediaScanStatus[]>('/api/admin/media/scan', {
        signal: stop.signal,
      })
        .then((scans) => {
          if (!stop.signal.aborted && account === currentMediaAccount())
            setPolicy((p) => (p ? { ...p, scans } : p));
        })
        .catch(() => undefined)
        .finally(() => {
          pending = false;
        });
    }, 3000);
    return () => {
      clearInterval(timer);
      stop.abort();
    };
  }, [watch]);
  const selected = connections.find((c) => c.id === draft.activeConnectionId);
  const savedConnection = policy?.settings.connections.find(
    (c) => c.id === selected?.id
  );
  const selectedSignature = selected ? signature(selected) : '';
  const unchanged =
    !!savedConnection &&
    selectedSignature === signature(connectionDraft(savedConnection));
  const check =
    checked?.signature === selectedSignature ? checked.result : null;
  const service =
    check?.service ||
    (policy?.settings.activeConnectionId === selected?.id
      ? policy?.remoteService
      : undefined);
  const cloudCapacity =
    check?.capacity ||
    (unchanged && policy?.settings.activeConnectionId === selected?.id
      ? policy?.capacity
      : undefined);
  const scan = policy?.scans.find((s) => s.connectionId === selected?.id);
  const localStatus = policy?.scans.find((s) => s.connectionId === 'local');
  const localDirty =
    JSON.stringify(localScan) !==
    JSON.stringify(policy?.settings.localScan || DEFAULT_LOCAL_SCAN);
  const update = (value: Partial<ConnectionDraft>) =>
    setConnections((all) =>
      all.map((c) =>
        c.id === draft.activeConnectionId ? { ...c, ...value } : c
      )
    );
  const addConnection = () => {
    const c = newConnection();
    setConnections((all) => [...all, c]);
    setDraft((value) => ({ ...value, activeConnectionId: c.id }));
    setChecked(null);
  };
  const action = async (
    kind: 'save' | 'check' | 'scan' | 'stop' | 'refresh',
    deletion?: MediaAdminPolicy['pendingDeletes'][number],
    scanTarget = draft.activeConnectionId
  ) => {
    if (busy || (kind === 'check' && connectionCheck.current)) return;
    if (
      deletion &&
      !window.confirm(
        `重试删除“${deletion.title}”？${
          deletion.path
            ? `同时删除${
                deletion.location === 'local' ? '本地' : '云盘'
              }原文件：${deletion.path}`
            : '只清理该视频剩余文件。'
        }`
      )
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    const account = currentMediaAccount();
    try {
      let value: MediaAdminPolicy | null = null;
      if (deletion) {
        await mediaJSON(`/api/media/${deletion.id}`, 'DELETE');
        value = await mediaRequest<MediaAdminPolicy>('/api/admin/media');
      } else if (kind === 'save') {
        if (
          [draft.quotaGiB, draft.maxFileGiB, draft.minFreeGiB].some(
            (v) => !v.trim()
          )
        )
          throw new Error('容量设置不能为空');
        value = await mediaJSON<MediaAdminPolicy>('/api/admin/media', 'PUT', {
          ...draft,
          quotaGiB: Number(draft.quotaGiB),
          maxFileGiB: Number(draft.maxFileGiB),
          minFreeGiB: Number(draft.minFreeGiB),
          remoteQuotaGiB: draft.remoteQuotaGiB.trim()
            ? Number(draft.remoteQuotaGiB)
            : null,
          connections,
          localScan,
        });
      } else if (kind === 'check') {
        if (!selected) throw new Error('请先填写 WebDAV 连接');
        const stop = new AbortController();
        connectionCheck.current = stop;
        const result = await mediaJSON<MediaConnectionCheck>(
          '/api/admin/media/check',
          'POST',
          { connectionId: selected.id, connection: selected },
          stop.signal,
          20000
        );
        if (account !== currentMediaAccount()) return;
        const normalized = { ...selected, url: result.url };
        update({ url: result.url });
        setChecked({ signature: signature(normalized), result });
      } else if (kind === 'scan' || kind === 'stop') {
        await mediaJSON(
          '/api/admin/media/scan',
          kind === 'scan' ? 'POST' : 'DELETE',
          { connectionId: scanTarget }
        );
        const scans = await mediaRequest<MediaScanStatus[]>(
          '/api/admin/media/scan'
        );
        if (account === currentMediaAccount())
          setPolicy((p) => (p ? { ...p, scans } : p));
      } else
        value = await mediaRequest<MediaAdminPolicy>(
          '/api/admin/media?refresh=1'
        );
      if (account !== currentMediaAccount()) return;
      if (value) {
        if (kind === 'refresh') {
          setPolicy(value);
          setChecked(null);
        } else apply(value);
      }
      if (kind === 'save') {
        setNotice('设置已生效');
        mediaChanged();
      }
      if (deletion) {
        setNotice('已安排后台清理，可刷新查看结果');
        mediaChanged();
      }
    } catch (e) {
      if (account === currentMediaAccount()) setError((e as Error).message);
    } finally {
      if (kind === 'check') connectionCheck.current = null;
      setBusy(false);
    }
  };
  const retryProcessing = async (id: string) => {
    if (busy) return;
    const account = currentMediaAccount();
    setBusy(true);
    setError('');
    try {
      await mediaJSON(`/api/media/uploads/${id}/complete`, 'POST');
      const value = await mediaRequest<MediaAdminPolicy>('/api/admin/media');
      if (account !== currentMediaAccount()) return;
      setPolicy(value);
      setNotice('已安排后台处理');
    } catch (failure) {
      if (account === currentMediaAccount())
        setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const passwordInput = selected && (
    <div>
      <label className='block text-sm'>
        密码
        <input
          type='password'
          autoComplete='new-password'
          className={inputClass}
          value={selected.password}
          placeholder={selected.hasPassword ? '已设置，留空保留' : '请输入密码'}
          onChange={(e) =>
            update({ password: e.target.value, clearPassword: false })
          }
        />
      </label>
      {selected.hasPassword && (
        <label className='mt-2 flex items-center gap-2 text-xs text-gray-500'>
          <input
            className={checkClass}
            type='checkbox'
            checked={!!selected.clearPassword}
            onChange={(e) => update({ clearPassword: e.target.checked })}
          />
          清除已存密码
        </label>
      )}
    </div>
  );
  return (
    <form
      className='space-y-4'
      onSubmit={(e) => {
        e.preventDefault();
        void action('save');
      }}
    >
      {!policy && !error && (
        <p className='text-sm text-gray-500'>正在读取设置…</p>
      )}
      {policy?.reason && (
        <p
          role='status'
          className='rounded-lg bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
        >
          {policy.reason}
        </p>
      )}
      {!!policy?.missingConnections.length && (
        <div className='space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'>
          {policy.missingConnections.map((m) => (
            <p key={m.id}>
              有 {m.references} 个视频或任务的存储连接待补配
              <button
                type='button'
                disabled={busy}
                className='ml-3 underline'
                onClick={() => {
                  if (!connections.some((c) => c.id === m.id))
                    setConnections((all) => [...all, newConnection(m.id)]);
                  setDraft((d) => ({ ...d, activeConnectionId: m.id }));
                }}
              >
                补配原连接
              </button>
            </p>
          ))}
        </div>
      )}
      <fieldset
        disabled={busy || !policy}
        className='space-y-4 disabled:opacity-70'
      >
        <Section
          title='上传设置'
          icon={<Upload className='h-4 w-4 text-gray-500' />}
        >
          <label className='flex items-center gap-2 text-sm'>
            <input
              type='checkbox'
              className={checkClass}
              checked={draft.allowUploads}
              onChange={(e) =>
                setDraft({ ...draft, allowUploads: e.target.checked })
              }
            />
            允许用户上传视频
          </label>
          <div className='grid gap-4 sm:grid-cols-2'>
            <label className='text-sm'>
              新上传保存到
              <select
                className={inputClass}
                value={draft.uploadStorage}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, uploadStorage: e.target.value }));
                  if (e.target.value === 'webdav' && !selected) addConnection();
                }}
              >
                <option value='local'>本地存储</option>
                <option value='webdav'>WebDAV</option>
              </select>
            </label>
            <label className='text-sm'>
              单文件上限（GiB）
              <input
                type='number'
                step='any'
                min='0.001'
                className={inputClass}
                value={draft.maxFileGiB}
                onChange={(e) =>
                  setDraft({ ...draft, maxFileGiB: e.target.value })
                }
              />
            </label>
          </div>
          <p className={hintClass}>
            只决定新任务的上传位置，已有视频和未完成任务继续使用原存储。
          </p>
          {draft.uploadStorage === 'webdav' && (
            <label className='block text-sm'>
              本站网盘额度（GiB，可选）
              <input
                type='number'
                step='any'
                min='0.001'
                className={inputClass}
                placeholder='留空不设本站额度'
                value={draft.remoteQuotaGiB}
                onChange={(e) =>
                  setDraft({ ...draft, remoteQuotaGiB: e.target.value })
                }
              />
              <span className={'mt-1 block ' + hintClass}>
                容量未知也可上传，已设置的额度和可查询的剩余空间仍生效。
              </span>
            </label>
          )}
          {policy && (
            <div className='grid gap-3 rounded-lg bg-white p-3 text-sm dark:bg-gray-800 sm:grid-cols-3'>
              <p className='space-y-1'>
                <span className={hintClass}>
                  {policy.settings.uploadStorage === 'webdav'
                    ? 'WebDAV 媒体库已用'
                    : '本地媒体库已用'}
                </span>
                <span className='block font-medium'>
                  {bytes(policy.usedBytes)}
                </span>
              </p>
              <p className='space-y-1'>
                <span className={hintClass}>上传预留</span>
                <span className='block font-medium'>
                  {bytes(policy.reservedBytes)}
                </span>
              </p>
              <p className='space-y-1'>
                <span className={hintClass}>剩余可上传</span>
                <span className='block font-medium'>
                  {policy.availableBytesKnown === false
                    ? '未知'
                    : bytes(
                        policy.storageAvailableBytes ?? policy.availableBytes
                      )}
                </span>
              </p>
            </div>
          )}
        </Section>
        <Section
          title='本地存储'
          icon={<HardDrive className='h-4 w-4 text-gray-500' />}
        >
          <p className='break-all text-sm text-gray-600 dark:text-gray-400'>
            媒体目录：{policy?.localDirectory || '尚未初始化'}
          </p>
          <div className='grid gap-4 sm:grid-cols-2'>
            {(
              [
                ['quotaGiB', '本地媒体库额度（GiB）'],
                ['minFreeGiB', '磁盘最低保留空间（GiB）'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className='text-sm'>
                {label}
                <input
                  type='number'
                  min={key === 'minFreeGiB' ? 1 : 0.001}
                  step='any'
                  className={inputClass}
                  value={draft[key]}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
          {policy && (
            <div className='flex flex-wrap gap-x-6 gap-y-2 text-xs text-gray-500'>
              <span>实际占用 {bytes(policy.localUsedBytes)}</span>
              <span>磁盘空闲 {bytes(policy.freeBytes)}</span>
              <span>暂存预留 {bytes(policy.localReservedBytes)}</span>
            </div>
          )}
          <p className={hintClass}>
            云端上传也使用此目录暂存视频，并保存封面与清单。Docker
            部署需保留该目录的持久化挂载。
          </p>
        </Section>
        <Section
          title='WebDAV 存储'
          icon={<Cloud className='h-4 w-4 text-gray-500' />}
        >
          <div className='flex flex-wrap items-end justify-between gap-3'>
            {connections.length > 1 ? (
              <label className='min-w-0 flex-1 text-sm'>
                当前连接
                <select
                  className={inputClass}
                  value={draft.activeConnectionId}
                  onChange={(e) => {
                    setDraft({ ...draft, activeConnectionId: e.target.value });
                    setChecked(null);
                  }}
                >
                  {connections.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      {c.url ? `${c.url} · ${c.root}` : `新连接 ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className={hintClass}>
                {selected
                  ? '只需填写地址、账号、密码和目录。'
                  : '尚未配置，可随时添加。'}
              </p>
            )}
            <button
              type='button'
              className={buttonClass}
              onClick={addConnection}
            >
              {selected ? '新增连接' : '配置 WebDAV'}
            </button>
          </div>
          {selected && (
            <div className='space-y-4'>
              <label className='block text-sm'>
                地址
                <input
                  className={inputClass}
                  autoComplete='off'
                  placeholder='https://你的服务地址/dav'
                  value={selected.url}
                  onChange={(e) =>
                    update({
                      url: e.target.value,
                    })
                  }
                />
                <span className={'mt-1 block ' + hintClass}>
                  填写服务提供的 WebDAV 地址。
                </span>
              </label>
              <div className='grid items-start gap-4 sm:grid-cols-2'>
                <label className='text-sm'>
                  账号
                  <input
                    className={inputClass}
                    autoComplete='off'
                    value={selected.username}
                    onChange={(e) => update({ username: e.target.value })}
                  />
                </label>
                {passwordInput}
              </div>
              <label className='block text-sm'>
                目录
                <input
                  className={inputClass}
                  placeholder='/'
                  value={selected.root}
                  onChange={(e) =>
                    update({
                      root: e.target.value,
                      ...(selected.scan.root === selected.root
                        ? { scan: { ...selected.scan, root: e.target.value } }
                        : {}),
                    })
                  }
                />
              </label>
              <div className='flex flex-wrap items-center gap-3'>
                <button
                  type='button'
                  disabled={!selected.url.trim()}
                  className={buttonClass}
                  onClick={() => void action('check')}
                >
                  检查连接
                </button>
                {!unchanged && !check && (
                  <span className={hintClass}>
                    配置有修改，请重新检查或保存。
                  </span>
                )}
              </div>
              {check && (
                <ul className='space-y-1 rounded-lg bg-white p-3 text-xs dark:bg-gray-800'>
                  {check.results.map((c, i) => (
                    <li
                      key={i}
                      className={
                        c.ok === true
                          ? 'text-green-600 dark:text-green-400'
                          : c.ok === false
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-gray-500 dark:text-gray-400'
                      }
                    >
                      {c.name}：{c.message}
                    </li>
                  ))}
                </ul>
              )}
              {cloudCapacity && (
                <div className='space-y-2 text-xs text-gray-500'>
                  <div className='flex flex-wrap gap-x-6 gap-y-2'>
                    <span>存储总量 {bytes(cloudCapacity.total)}</span>
                    <span>已用 {bytes(cloudCapacity.used)}</span>
                    <span>剩余 {bytes(cloudCapacity.free)}</span>
                  </div>
                  {cloudCapacity.error && <p>{cloudCapacity.error}</p>}
                  {cloudCapacity.stale && (
                    <p>
                      上次成功查询：
                      {new Date(cloudCapacity.checkedAt).toLocaleString(
                        'zh-CN'
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </Section>
        <Section
          title='扫描与维护'
          icon={<FolderSearch className='h-4 w-4 text-gray-500' />}
        >
          <p className={hintClass}>
            扫描原地导入已有视频，不移动原文件。与新上传的存储选择无关，修改扫描设置后先保存。
          </p>
          <details className='rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800/50'>
            <summary className='cursor-pointer text-sm font-medium'>
              本地目录扫描
              {localStatus?.state === 'running' ? ' · 正在扫描' : ''}
            </summary>
            <div className='mt-4 space-y-3'>
              <p className={hintClass}>
                目录相对于本地媒体目录，/ 表示整个目录，自动跳过 items、uploads
                和链接文件。
              </p>
              <ScanEditor
                config={localScan}
                status={localStatus}
                onChange={setLocalScan}
                onStart={() => void action('scan', undefined, 'local')}
                onStop={() => void action('stop', undefined, 'local')}
                disabled={busy || !policy?.enabled}
                dirty={localDirty}
              />
            </div>
          </details>
          {selected && (
            <details className='rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800/50'>
              <summary className='cursor-pointer text-sm font-medium'>
                云盘目录扫描{scan?.state === 'running' ? ' · 正在扫描' : ''}
              </summary>
              <div className='mt-4 space-y-3'>
                <p className={hintClass}>
                  目录相对于 WebDAV
                  账号可见根目录，范围限于配置的存储目录，自动跳过
                  .lunatv-media。
                </p>
                {service && !service.canScan && (
                  <p className={hintClass}>{service.message}</p>
                )}
                <ScanEditor
                  config={selected.scan}
                  status={scan}
                  onChange={(value) => update({ scan: value })}
                  onStart={() => void action('scan')}
                  onStop={() => void action('stop')}
                  disabled={busy || !policy?.enabled}
                  dirty={!unchanged}
                  allowed={service?.canScan !== false}
                />
              </div>
            </details>
          )}
          {!!policy?.pendingProcessing?.length && (
            <div className='space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700'>
              <h4 className='text-sm font-medium'>后台存储任务</h4>
              {policy.pendingProcessing.map((task) => (
                <div
                  key={task.id}
                  className='flex items-center justify-between gap-3 text-sm'
                >
                  <div className='min-w-0 break-all'>
                    <p>
                      {task.title} ·{' '}
                      {task.location === 'webdav' ? 'WebDAV' : '本地'}
                    </p>
                    <p className={hintClass}>
                      {task.error ||
                        (task.running
                          ? '正在后台处理'
                          : task.status === 'uploading'
                          ? '等待上传者继续上传'
                          : task.status === 'processing'
                          ? '等待后台处理'
                          : '等待重试')}
                      {task.sentBytes !== undefined
                        ? ` · ${formatMediaBytes(
                            task.sentBytes
                          )} / ${formatMediaBytes(task.totalBytes)}`
                        : ''}
                    </p>
                  </div>
                  {!task.running && task.retryable !== false && (
                    <button
                      type='button'
                      className={buttonClass}
                      onClick={() => void retryProcessing(task.id)}
                    >
                      重试
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {policy && (
            <div className='space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700'>
              <h4 className='text-sm font-medium'>待清理的视频</h4>
              {!policy.pendingDeletes?.length && (
                <p className={hintClass}>暂无待清理视频</p>
              )}
              {policy.pendingDeletes?.map((d) => (
                <div
                  key={d.id}
                  className='flex items-center justify-between gap-3 text-sm'
                >
                  <div className='min-w-0 break-all'>
                    <p>
                      {d.title}
                      {d.path ? ` · ${d.path}` : ''}
                    </p>
                    <p className={hintClass}>
                      {d.error || (d.running ? '已安排后台清理' : '等待重试')}
                    </p>
                  </div>
                  <button
                    type='button'
                    className={buttonClass}
                    onClick={() => void action('refresh', d)}
                  >
                    重试清理
                  </button>
                </div>
              ))}
            </div>
          )}
          {policy && (
            <div className='space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700'>
              <h4 className='text-sm font-medium'>源文件保留记录</h4>
              {policy.retainedSources?.length ? (
                <p className={hintClass}>
                  这些视频已从片库移除，以下源文件未确认删除，请核对。
                </p>
              ) : (
                <p className={hintClass}>暂无保留记录</p>
              )}
              {policy.retainedSources?.map((item) => (
                <div key={item.id} className='space-y-1 break-all text-sm'>
                  <p>
                    {item.title} ·{' '}
                    {item.location === 'local' ? '本地' : 'WebDAV'}
                  </p>
                  <p className={hintClass}>{item.path}</p>
                  <p className='text-xs text-amber-600 dark:text-amber-400'>
                    {item.reason}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </fieldset>
      {error && (
        <p role='alert' className='text-sm text-red-500'>
          {error}
        </p>
      )}
      {notice && (
        <p role='status' className='text-sm text-green-600'>
          {notice}
        </p>
      )}
      <div className='flex flex-wrap gap-3'>
        <button
          type='submit'
          disabled={busy || !policy}
          className='rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'
        >
          {busy ? '处理中…' : '保存设置'}
        </button>
        <button
          type='button'
          className={buttonClass}
          disabled={busy}
          onClick={() => void action('refresh')}
        >
          刷新状态
        </button>
      </div>
    </form>
  );
}
