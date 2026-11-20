import { useFocusRequest, useDOMEvent } from '@wegent/collaboration/dom-events'
import { useRef } from 'react'
import {
  Box,
  Boxes,
  CalendarDays,
  CheckCircle2,
  Download,
  Globe2,
  Loader2,
  LockKeyhole,
  PackageOpen,
  Puzzle,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { SmartAppMarketplaceItem } from '@/api/smartApps'
import { type HarnessAppInstallation } from '@/api/local/harnessApps'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { formatBytes } from './smartAppsMarketplaceHelpers'
export function SmartAppCard({
  actions,
  description,
  iconUrl,
  onDetails,
  sourceLabel,
  stateLabel,
  stateTone,
  supplementary,
  tags,
  testId,
  title,
  version,
  visibility,
}: {
  actions: React.ReactNode
  description: string
  iconUrl?: string
  onDetails?: () => void
  sourceLabel?: string
  stateLabel: string
  stateTone: 'accent' | 'danger' | 'muted' | 'success'
  supplementary?: React.ReactNode
  tags: string[]
  testId?: string
  title: string
  version: string
  visibility: {
    kind: 'private' | 'public' | 'restricted'
    label: string
    onClick?: () => void
    testId?: string
  }
}) {
  const stateClassName =
    stateTone === 'success'
      ? 'text-success'
      : stateTone === 'danger'
        ? 'text-red-500'
        : stateTone === 'accent'
          ? 'text-blue-600'
          : 'text-text-muted'
  const VisibilityIcon =
    visibility.kind === 'public' ? Globe2 : visibility.kind === 'restricted' ? Users : LockKeyhole
  const visibilityContent = (
    <>
      <VisibilityIcon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{visibility.label}</span>
    </>
  )
  const identity = (
    <>
      {iconUrl ? (
        <img src={iconUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
      ) : (
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-surface/30 text-text-secondary">
          <Box className="h-6 w-6" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base font-medium text-text-primary">{title}</span>
          {sourceLabel ? (
            <span className="shrink-0 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-text-muted">
              {sourceLabel}
            </span>
          ) : null}
        </span>
        <span className="mt-1 line-clamp-2 text-sm leading-5 text-text-secondary">
          {description}
        </span>
        {tags.length > 0 ? (
          <span className="mt-2 flex flex-wrap gap-1">
            {tags.slice(0, 3).map(tag => (
              <span
                key={tag}
                className="rounded-md bg-muted/45 px-2 py-0.5 text-xs text-text-muted"
              >
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </>
  )

  return (
    <article
      data-testid={testId}
      className="flex min-h-52 flex-col rounded-2xl border border-border/45 bg-background p-5 transition-colors hover:border-border/70 hover:bg-surface/20"
    >
      {onDetails ? (
        <button
          type="button"
          className="flex items-start gap-4 text-left focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
          onClick={onDetails}
        >
          {identity}
        </button>
      ) : (
        <div className="flex items-start gap-4">{identity}</div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-4 text-xs">
        {visibility.onClick ? (
          <button
            type="button"
            data-testid={visibility.testId}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/50 bg-background px-2 text-text-primary hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
            onClick={visibility.onClick}
          >
            {visibilityContent}
          </button>
        ) : (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/50 px-2 text-text-primary">
            {visibilityContent}
          </span>
        )}
        <span
          data-testid={testId ? `${testId}-state` : undefined}
          className={`inline-flex items-center gap-1.5 ${stateClassName}`}
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {stateLabel}
        </span>
        <span className="inline-flex items-center gap-1.5 text-text-muted">
          <Puzzle className="h-3.5 w-3.5" aria-hidden="true" />v{version}
        </span>
      </div>
      <div className="mt-4 flex min-h-9 flex-wrap items-end justify-between gap-3 border-t border-border/40 pt-4">
        <div className="min-w-0 flex-1">{supplementary}</div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      </div>
    </article>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="mt-5 flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-border/45 bg-background px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/30 bg-background text-text-secondary">
        {icon}
      </div>
      <strong className="mt-5 font-medium">{title}</strong>
      <p className="mt-2 max-w-md text-sm leading-6 text-text-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function SmartAppDetails({
  item,
  state,
  installDisabled,
  busy,
  onClose,
  onInstall,
}: {
  item: SmartAppMarketplaceItem
  state: { installation: HarnessAppInstallation; update: boolean } | null
  installDisabled: boolean
  busy: boolean
  onClose: () => void
  onInstall: () => void
}) {
  const { t } = useTranslation('common')
  const closeRef = useRef<HTMLButtonElement>(null)
  const rawDescription = (item.descriptionMd || item.summary).trim()
  const descriptionLines = rawDescription.split(/\r?\n/)
  const firstHeading = descriptionLines[0]?.trim().replace(/^#+\s*/, '')
  const description =
    firstHeading === item.displayName
      ? descriptionLines.slice(1).join('\n').trim() || item.summary
      : rawDescription

  useFocusRequest(closeRef)
  useDOMEvent<KeyboardEvent>('document', 'keydown', event => {
    if (event.key === 'Escape') onClose()
  })

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-app-details-title"
        data-testid="smart-app-details"
        className="plugin-dialog-surface flex max-h-[min(760px,92dvh)] w-full max-w-[720px] flex-col overflow-hidden rounded-b-none sm:rounded-b-[20px]"
        onClick={event => event.stopPropagation()}
      >
        <header
          className="plugin-dialog-divider flex shrink-0 items-start gap-4 border-b px-5 py-4 sm:px-6 sm:py-5"
          data-testid="smart-app-details-header"
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/30 bg-surface">
            {item.iconUrl ? (
              <img src={item.iconUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <Boxes className="h-6 w-6 text-text-muted" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="smart-app-details-title" className="heading-subsection truncate">
              {item.displayName}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {item.sourceType === 'official'
                ? t('workbench.smart_apps_wework_official', 'Wework 官方')
                : t('workbench.smart_apps_publisher', '发布者：{{name}}').replace(
                    '{{name}}',
                    item.ownerDisplayName
                  )}{' '}
              · v{item.version}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label={t('common.close', '关闭')}
            data-testid="smart-app-details-close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface hover:text-text-primary"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div
          className="scrollbar-soft min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6"
          data-testid="smart-app-details-content"
        >
          <div className="grid overflow-hidden rounded-xl border border-border/30 bg-surface/35 text-sm sm:grid-cols-3 sm:divide-x sm:divide-border/30">
            <div className="flex min-h-14 items-center gap-2.5 px-4 py-3">
              <ShieldCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <span className="font-medium text-text-primary">
                {t('workbench.smart_apps_scan_passed', '安全扫描通过')}
              </span>
            </div>
            <div className="flex min-h-14 items-center gap-2.5 border-t border-border/30 px-4 py-3 sm:border-t-0">
              <PackageOpen className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="text-text-secondary">{formatBytes(item.sizeBytes)}</span>
            </div>
            <div className="flex min-h-14 items-center gap-2.5 border-t border-border/30 px-4 py-3 sm:border-t-0">
              <CalendarDays className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="text-text-secondary">
                {t('workbench.smart_apps_updated_at', '更新于 {{date}}').replace(
                  '{{date}}',
                  new Date(item.updatedAt).toLocaleDateString()
                )}
              </span>
            </div>
          </div>

          {item.screenshotUrls.length ? (
            <div className="mt-5 flex snap-x gap-3 overflow-x-auto pb-1">
              {item.screenshotUrls.map(url => (
                <img
                  key={url}
                  src={url}
                  alt={t('workbench.smart_apps_screenshot', '工作台截图')}
                  className="h-44 shrink-0 snap-start rounded-xl border border-border/40 object-cover"
                />
              ))}
            </div>
          ) : null}

          <article
            className="mt-5 text-sm leading-6 text-text-secondary"
            data-testid="smart-app-details-description"
          >
            <ReactMarkdown
              components={{
                h1: ({ children }) => (
                  <h3 className="mb-2 mt-5 text-base font-medium text-text-primary first:mt-0">
                    {children}
                  </h3>
                ),
                h2: ({ children }) => (
                  <h3 className="mb-2 mt-5 text-base font-medium text-text-primary first:mt-0">
                    {children}
                  </h3>
                ),
                h3: ({ children }) => (
                  <h4 className="mb-2 mt-4 text-sm font-medium text-text-primary first:mt-0">
                    {children}
                  </h4>
                ),
                p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                ul: ({ children }) => (
                  <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0">{children}</ul>
                ),
                ol: ({ children, start }) => (
                  <ol start={start} className="mb-3 list-decimal space-y-1.5 pl-5 last:mb-0">
                    {children}
                  </ol>
                ),
                li: ({ children }) => <li className="pl-0.5">{children}</li>,
                strong: ({ children }) => (
                  <strong className="font-medium text-text-primary">{children}</strong>
                ),
                code: ({ children }) => (
                  <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs text-text-primary">
                    {children}
                  </code>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="my-3 border-l-2 border-border pl-3 text-text-muted">
                    {children}
                  </blockquote>
                ),
              }}
            >
              {description}
            </ReactMarkdown>
          </article>

          {item.releaseNotes ? (
            <section className="plugin-dialog-divider mt-5 border-t pt-4">
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.smart_apps_release_notes', '版本说明')}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
                {item.releaseNotes}
              </p>
            </section>
          ) : null}
        </div>
        <footer
          className="plugin-dialog-divider flex shrink-0 justify-end border-t px-5 py-4 sm:px-6"
          data-testid="smart-app-details-footer"
        >
          <Button
            size="sm"
            className="min-w-28"
            disabled={installDisabled || busy || Boolean(state && !state.update)}
            onClick={onInstall}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : state && !state.update ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            {state
              ? state.update
                ? t('workbench.smart_apps_update', '更新')
                : t('workbench.smart_apps_installed', '已安装')
              : t('workbench.smart_apps_download_install', '下载并安装')}
          </Button>
        </footer>
      </section>
    </div>
  )
}
