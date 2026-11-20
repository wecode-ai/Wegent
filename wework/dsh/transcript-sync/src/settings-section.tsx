import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { getDshExtensionHost } from '@/features/dsh-runtime/dshExtensions'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import type { WeworkLocalizationService } from '../../app-wework/client'

interface SyncStatus {
  pendingTurns: number
  transcripts: number
  syncing: boolean
  lastError: string | null
  lastSuccessAt: string | null
}

interface SyncSettingsSnapshot {
  enabled: boolean
  error: string | null
  pending: boolean
  status: SyncStatus | null
  statusPending: boolean
  statusRefreshing: boolean
}

interface SyncSettingsStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): SyncSettingsSnapshot
  setEnabled(enabled: boolean): Promise<void>
  retry(): Promise<void>
}

export default function TranscriptSyncSettingsSection() {
  const host = getDshExtensionHost()
  const entry = host?.contributions.get(WEWORK_DSH_SLOTS.settingsSection, 'wework-transcript-sync')
  const store = entry?.store as SyncSettingsStore | undefined
  return host && store ? (
    <SyncSettingsSection store={store} localization={host.localization} />
  ) : null
}

function SyncSettingsSection({
  localization,
  store,
}: {
  localization: WeworkLocalizationService
  store: SyncSettingsStore
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const { status } = snapshot
  const { translate } = localization
  const label = translate({
    en: 'Synchronize conversations and settings across devices',
    'zh-CN': '跨设备同步会话和配置',
  })
  const syncStatus = synchronizationStatus(snapshot, localization)

  return (
    <section
      data-testid="transcript-sync-settings-section"
      className="rounded-lg border border-border bg-background p-5 text-foreground"
    >
      <label className="flex items-start gap-3">
        <Checkbox
          aria-label={label}
          checked={snapshot.enabled}
          data-testid="transcript-sync-enabled-checkbox"
          disabled={snapshot.pending}
          onCheckedChange={checked => void store.setEnabled(checked === true)}
        />
        <span className="flex flex-col gap-1">
          <span className="font-semibold">{label}</span>
          <span className="text-muted-foreground">
            {translate({
              en: 'When disabled, Wework keeps working locally and does not upload or download cloud data.',
              'zh-CN': '关闭后 Wework 仍可在本机正常工作，但不会上传或下载云端数据。',
            })}
          </span>
          <span
            aria-live="polite"
            data-testid="transcript-sync-enabled-status"
            className="text-muted-foreground"
          >
            {snapshot.pending || snapshot.statusPending
              ? translate({ en: 'Updating…', 'zh-CN': '正在更新…' })
              : syncStatus}
          </span>
        </span>
      </label>
      <div className="ml-7 mt-2 flex flex-col gap-1">
        {status ? (
          <SyncStatusDetails
            failed={snapshot.enabled && !status.syncing && Boolean(status.lastError)}
            status={status}
            localization={localization}
          />
        ) : null}
        {status?.lastError ? (
          <span
            data-testid="transcript-sync-runtime-error"
            role="alert"
            className="text-destructive"
          >
            {status.lastError}
          </span>
        ) : null}
        {snapshot.enabled ? (
          <Button
            className="self-start"
            data-testid="transcript-sync-retry-button"
            disabled={snapshot.statusRefreshing}
            onClick={() => void store.retry()}
            size="sm"
            type="button"
            variant="outline"
          >
            {translate({ en: 'Retry now', 'zh-CN': '立即重试' })}
          </Button>
        ) : null}
        {snapshot.error ? (
          <span
            data-testid="transcript-sync-settings-error"
            role="alert"
            className="text-destructive"
          >
            {snapshot.error}
          </span>
        ) : null}
      </div>
    </section>
  )
}

function SyncStatusDetails({
  failed,
  localization,
  status,
}: {
  failed: boolean
  localization: WeworkLocalizationService
  status: SyncStatus
}) {
  const { translate } = localization
  return (
    <span
      data-testid="transcript-sync-runtime-status"
      className={`flex flex-col gap-0.5 ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      <span>
        {translate({
          en: `${status.pendingTurns} turns waiting to upload`,
          'zh-CN': `待上传 ${status.pendingTurns} 轮`,
        })}
      </span>
      <span>
        {translate({
          en: `${status.transcripts} cloud conversations discovered`,
          'zh-CN': `已发现 ${status.transcripts} 个云端会话`,
        })}
      </span>
      <span>
        {translate({
          en: `Last successful sync: ${formatTimestamp(status.lastSuccessAt, 'Never')}`,
          'zh-CN': `最近成功：${formatTimestamp(status.lastSuccessAt, '暂无')}`,
        })}
      </span>
    </span>
  )
}

function synchronizationStatus(
  { enabled, status }: SyncSettingsSnapshot,
  { translate }: WeworkLocalizationService
) {
  if (!enabled) {
    return translate({ en: 'Synchronization disabled', 'zh-CN': '同步已关闭' })
  }
  if (status?.syncing) {
    return translate({ en: 'Synchronizing…', 'zh-CN': '正在同步…' })
  }
  if (status?.lastError) {
    return translate({ en: 'Synchronization failed', 'zh-CN': '同步失败' })
  }
  if (status && status.pendingTurns > 0) {
    return translate({ en: 'Waiting to synchronize', 'zh-CN': '等待同步' })
  }
  return translate({ en: 'Synchronization is up to date', 'zh-CN': '同步正常' })
}

function formatTimestamp(value: string | null, fallback: string) {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString()
}
