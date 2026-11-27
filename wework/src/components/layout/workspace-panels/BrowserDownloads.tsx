import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import {
  deleteEmbeddedBrowserDownload,
  openEmbeddedBrowserDownload,
  openEmbeddedBrowserDownloadsFolder,
  pauseEmbeddedBrowserDownload,
  removeEmbeddedBrowserDownloadRecord,
  resumeEmbeddedBrowserDownload,
  revealEmbeddedBrowserDownload,
} from '@/lib/embedded-browser'
import { fileManagerRevealLabel } from '@/lib/file-manager'
import { cn } from '@/lib/utils'
import { IconButton } from '@wegent/collaboration/controls/IconButton'
import { Tooltip } from '@wegent/collaboration/controls/Tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import { Button } from '@wegent/collaboration/markdown/Button'
import {
  CheckCircle2,
  CircleAlert,
  Download,
  File,
  FolderOpen,
  Pause,
  Play,
  Trash2,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  formatDownloadBytes,
  type BrowserDownload,
  type BrowserSessionState,
} from './workspaceBrowserSessionTypes'

interface DownloadsProps {
  active: boolean
  hideTrigger: boolean
  downloads: BrowserDownload[]
  open: boolean
  loading: boolean
  loadError: boolean
  onRetry: () => void
  unreadCount: number
  peek: BrowserSessionState['downloadPeek']
  onOpenChange: (open: boolean) => void
  onDismissPeek: () => void
  onAcknowledge: (id: string) => void
  onActionError: () => void
}

function DownloadRow({
  download,
  run,
  formatTime,
}: {
  download: BrowserDownload
  run: (action: () => Promise<void>) => void
  formatTime: (timestamp: number) => string
}) {
  const { t } = useTranslation('common')
  const { id, status, receivedBytes, totalBytes, fileName } = download
  const active = status === 'started' || status === 'progress'
  const missing = status === 'finished' && download.fileExists === false
  const canOpen = status === 'finished' && Boolean(download.path) && !missing
  const progress =
    totalBytes && receivedBytes !== null
      ? Math.min(100, Math.round((receivedBytes * 100) / totalBytes))
      : null
  const size =
    active && totalBytes && receivedBytes !== null
      ? `${formatDownloadBytes(receivedBytes)} / ${formatDownloadBytes(totalBytes)}`
      : formatDownloadBytes(receivedBytes ?? totalBytes)
  const statusLabel = missing
    ? t('workbench.browser_download_missing')
    : status === 'finished'
      ? t('workbench.browser_download_saved')
      : active
        ? t('workbench.browser_download_started')
        : t(`workbench.browser_download_${status}`)
  const openLabel = t('workbench.browser_download_peek_open')
  return (
    <li
      data-testid="workspace-browser-download-item"
      data-file-name={fileName}
      data-file-missing={missing}
      className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-2"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary">
        <File aria-hidden className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <Button
          variant="unstyled"
          type="button"
          data-testid="workspace-browser-download-open"
          disabled={!canOpen}
          onClick={() => run(() => openEmbeddedBrowserDownload(id))}
          title={fileName}
          className="block max-w-full truncate text-left text-sm font-medium hover:enabled:underline"
        >
          {fileName}
        </Button>
        <div
          data-testid="workspace-browser-download-status"
          className="truncate text-xs text-text-muted"
        >
          {[statusLabel, size, formatTime(download.updatedAtMs)].filter(Boolean).join(' · ')}
        </div>
        {active ? (
          <div
            data-testid="workspace-browser-download-progress"
            role="progressbar"
            aria-label={statusLabel}
            aria-valuenow={progress ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                'h-full rounded-full bg-primary',
                progress === null && 'w-1/3 animate-pulse'
              )}
              style={progress === null ? undefined : { width: progress + '%' }}
            />
          </div>
        ) : null}
      </div>
      {status === 'finished' ? (
        <IconButton
          density="compact"
          data-testid="workspace-browser-download-reveal-button"
          aria-label={fileManagerRevealLabel(t)}
          disabled={!canOpen}
          onClick={() => run(() => revealEmbeddedBrowserDownload(id))}
        >
          <FolderOpen className="h-4 w-4" />
        </IconButton>
      ) : null}
      {active ? (
        <IconButton
          density="compact"
          data-testid="workspace-browser-download-pause-button"
          aria-label={t('workbench.browser_download_pause')}
          onClick={() => run(() => pauseEmbeddedBrowserDownload(id))}
        >
          <Pause className="h-4 w-4" />
        </IconButton>
      ) : null}
      {status === 'paused' ? (
        <>
          <IconButton
            density="compact"
            data-testid="workspace-browser-download-resume-button"
            aria-label={t('workbench.browser_download_resume')}
            onClick={() => run(() => resumeEmbeddedBrowserDownload(id))}
          >
            <Play className="h-4 w-4" />
          </IconButton>
          <IconButton
            density="compact"
            data-testid="workspace-browser-download-delete-button"
            aria-label={t('workbench.browser_download_delete')}
            onClick={() => run(() => deleteEmbeddedBrowserDownload(id))}
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </>
      ) : null}
      {status === 'finished' || status === 'failed' ? (
        <ActionMenu
          ariaLabel={t('workbench.browser_more_actions')}
          testId="workspace-browser-download-more-button"
          density="compact"
          placement="bottom-end"
          items={[
            ...(status === 'finished'
              ? [
                  {
                    label: openLabel,
                    testId: 'workspace-browser-download-menu-open',
                    disabled: !canOpen,
                    onSelect: () => run(() => openEmbeddedBrowserDownload(id)),
                  },
                ]
              : []),
            {
              label: t('workbench.browser_download_remove_record'),
              testId: 'workspace-browser-download-remove-record',
              onSelect: () => run(() => removeEmbeddedBrowserDownloadRecord(id)),
            },
          ]}
        />
      ) : null}
    </li>
  )
}

export function BrowserDownloads({
  active,
  hideTrigger,
  downloads,
  open,
  loading,
  loadError,
  onRetry,
  unreadCount,
  peek,
  onOpenChange,
  onActionError,
  onDismissPeek,
  onAcknowledge,
}: DownloadsProps) {
  const { t, i18n } = useTranslation('common')
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const title = t('workbench.browser_downloads')
  const readyLabel = unreadCount
    ? t('workbench.browser_downloads_ready', { count: unreadCount })
    : title
  const downloading = downloads.some(
    item => item.status === 'started' || item.status === 'progress'
  )
  const run = (action: () => Promise<void>) => {
    void action().catch(onActionError)
  }
  const runPeekAction = (id: string, action: (id: string) => Promise<void>) => {
    void action(id).then(() => onAcknowledge(id), onActionError)
    onDismissPeek()
  }
  const clocks = useMemo(
    () => ({
      today: new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }),
      earlier: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    }),
    [i18n.language]
  )
  const today = new Date().toDateString()
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return (date.toDateString() === today ? clocks.today : clocks.earlier).format(date)
  }
  return (
    <>
      <Popover open={active && open} onOpenChange={onOpenChange}>
        <Tooltip label={readyLabel} disabled={hideTrigger} side="top">
          <PopoverTrigger
            ref={setAnchor}
            type="button"
            aria-label={readyLabel}
            disabled={hideTrigger}
            data-testid={hideTrigger ? undefined : 'workspace-browser-downloads-button'}
            tabIndex={hideTrigger ? -1 : undefined}
            aria-hidden={hideTrigger || undefined}
            className={
              hideTrigger
                ? 'pointer-events-none absolute right-2 top-0 h-px w-px opacity-0'
                : cn(
                    'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary',
                    open && 'bg-muted',
                    unreadCount > 0 && 'text-primary'
                  )
            }
          >
            <Download className="h-4 w-4" />
            {downloading ? (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
            ) : null}
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          data-embedded-browser-occlusion
          aria-label={title}
          align="end"
          side="bottom"
          initialFocus="content"
          finalFocus={hideTrigger ? 'none' : 'trigger'}
          style={{ maxHeight: 'min(var(--available-height),32rem)' }}
          className="flex w-[360px] flex-col overflow-hidden"
        >
          <div data-testid="workspace-browser-downloads-panel" className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-1 px-2 py-1">
              <h2 className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>
              <IconButton
                density="compact"
                data-testid="workspace-browser-downloads-open-folder"
                aria-label={t('workbench.browser_downloads_open_folder')}
                onClick={() => run(openEmbeddedBrowserDownloadsFolder)}
              >
                <FolderOpen className="h-4 w-4" />
              </IconButton>
              <IconButton
                density="compact"
                data-testid="workspace-browser-downloads-close"
                aria-label={t('workbench.browser_downloads_close')}
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </div>
            {loadError && (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 px-2 py-1 text-sm text-text-secondary"
              >
                {t('workbench.browser_downloads_load_failed')}
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="workspace-browser-downloads-retry"
                  disabled={loading}
                  onClick={onRetry}
                >
                  {t('workbench.retry')}
                </Button>
              </div>
            )}
            {downloads.length ? (
              <ul className="min-h-0 overflow-y-auto overscroll-contain px-1">
                {downloads.map(download => (
                  <DownloadRow
                    key={download.id}
                    download={download}
                    run={run}
                    formatTime={formatTime}
                  />
                ))}
              </ul>
            ) : (
              !loadError && (
                <p role="status" className="px-3 py-4 text-sm text-text-muted">
                  {t(loading ? 'common.loading' : 'workbench.browser_downloads_empty')}
                </p>
              )
            )}
          </div>
        </PopoverContent>
      </Popover>
      {peek && active && !open && anchor ? (
        <Popover
          open
          onOpenChange={next => {
            if (!next) onDismissPeek()
          }}
        >
          <PopoverContent
            anchor={anchor}
            data-embedded-browser-occlusion
            aria-label={title}
            align="end"
            side="bottom"
            initialFocus="none"
            finalFocus="none"
            className="flex w-72 flex-col overflow-hidden"
          >
            <div key={peek.id} data-testid="workspace-browser-download-peek" className="p-2">
              <div className="flex items-start gap-2">
                {peek.status === 'finished' ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success wework:text-green-600" />
                ) : (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                )}
                <div role="status" className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {t(`workbench.browser_download_${peek.status}`)}
                  </p>
                  <Button
                    variant="unstyled"
                    type="button"
                    data-testid="workspace-browser-download-peek-view-downloads"
                    title={t('workbench.browser_download_peek_view_downloads')}
                    aria-label={t('workbench.browser_download_peek_view_downloads')}
                    className="block max-w-full truncate text-left text-xs text-text-muted hover:underline"
                    onClick={() => onOpenChange(true)}
                  >
                    {peek.fileName}
                  </Button>
                </div>
                <IconButton
                  density="compact"
                  data-testid="workspace-browser-download-peek-dismiss"
                  aria-label={t('workbench.browser_download_peek_dismiss')}
                  onClick={onDismissPeek}
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              </div>
              {peek.status === 'finished' && peek.path ? (
                <div className="mt-2 flex justify-end gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    data-testid="workspace-browser-download-peek-show-in-folder"
                    className="rounded-full"
                    onClick={() => runPeekAction(peek.id, revealEmbeddedBrowserDownload)}
                  >
                    {fileManagerRevealLabel(t)}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    type="button"
                    data-testid="workspace-browser-download-peek-open"
                    className="rounded-full"
                    onClick={() => runPeekAction(peek.id, openEmbeddedBrowserDownload)}
                  >
                    {t('workbench.browser_download_peek_open')}
                  </Button>
                </div>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  )
}
