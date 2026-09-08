import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Code2,
  Copy,
  ExternalLink,
  Globe2,
  Loader2,
  QrCode,
  Smartphone,
  Upload,
  X,
} from 'lucide-react'
import type { ApplicationCapability, MiniProgram, Site } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/external-links'
import { createQrCodeModules, qrCodeOffset, qrCodeViewBox } from './qrCodeSvg'
import { SiteActionsMenu } from './SiteActionsMenu'

export interface ApplicationRowContext {
  capabilities: ReadonlySet<ApplicationCapability>
  publishingIds: ReadonlySet<string>
  deletingSiteId: string | null
  continuingSiteId?: string | null
  onPublish: (site: Site) => void
  onContinueDevelopment: (site: Site) => void
  onEdit: (site: Site) => void
  onConfigureEnvironment: (site: Site) => void
  onDelete: (site: Site) => void
  onManageCollaborators: (site: Site) => void
  onManageAccess: (site: Site) => void
}

function SiteThumbnail({ site }: { site: Site }) {
  const [imageFailed, setImageFailed] = useState(false)

  return (
    <div className="flex h-[50px] w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface">
      {site.thumbnail_url && !imageFailed ? (
        <img
          src={site.thumbnail_url}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <Globe2 className="h-5 w-5 text-text-muted" aria-hidden="true" />
      )}
    </div>
  )
}

function getSiteNetwork(site: Site): 'inner' | 'outer' {
  return site.network ?? (site.external_url ? 'outer' : 'inner')
}

export function SiteApplicationRow({
  site,
  context,
}: {
  site: Site
  context: ApplicationRowContext
}) {
  const { t } = useTranslation('sites')
  const publishing = context.publishingIds.has(site.siteid)
  const deleting = context.deletingSiteId === site.siteid
  const continuing = context.continuingSiteId === site.siteid
  const network = getSiteNetwork(site)
  const isPublishing = publishing || site.publish_status === 'publishing'
  const isFailed = site.publish_status === 'failed'
  const isSecurityChecking = site.publish_status === 'scanning'
  const publishLabel = isPublishing
    ? t('publishing', '发布中')
    : isSecurityChecking
      ? t('security_checking', '安全检查中')
      : isFailed
        ? t('retry_publish', '重试发布')
        : network === 'outer'
          ? t('publish_inner', '发布到内网')
          : t('publish', '发布到外网')
  const PublishIcon = isPublishing || isSecurityChecking ? Loader2 : Upload

  const openUrl = (url: string) => {
    void openExternalUrl(url, { target: 'system' }).catch(error => {
      console.error('Failed to open site URL:', error)
    })
  }

  return (
    <article
      data-testid={`site-row-${site.siteid}`}
      className="grid gap-4 border-b border-border py-4 md:grid-cols-[minmax(0,1fr)_minmax(240px,0.55fr)] md:items-center md:gap-8"
    >
      <div className="flex min-w-0 items-center gap-4">
        <SiteThumbnail site={site} />
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium leading-5 text-text-primary">
            {site.name}
          </h2>
          <button
            type="button"
            data-testid={`site-internal-url-${site.siteid}`}
            aria-label={t('open_internal', { name: site.name })}
            onClick={() => openUrl(site.internal_url)}
            className="mt-1 flex max-w-full items-center gap-1 text-left text-sm leading-5 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
          >
            <span className="truncate">{site.internal_url}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-4 pl-24 md:pl-0">
        <div className="min-w-0 flex-1" aria-live="polite">
          <span data-testid={`site-network-${site.siteid}`} className="text-sm text-text-secondary">
            {network === 'outer' ? t('network_outer', '外网') : t('network_inner', '内网')}
          </span>
          {isFailed ? (
            <span className="flex items-center gap-1.5 text-sm text-danger">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {site.last_publish_error || t('publish_failed', '发布失败')}
              </span>
            </span>
          ) : null}
        </div>
        <button
          type="button"
          data-testid={`site-continue-development-${site.siteid}`}
          disabled={deleting || continuing}
          onClick={() => context.onContinueDevelopment(site)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-default disabled:text-text-secondary disabled:opacity-70"
        >
          {continuing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t('continue_development', '继续开发')}
        </button>
        {context.capabilities.has('publish') ||
        context.capabilities.has('edit') ||
        context.capabilities.has('configure_environment') ||
        context.capabilities.has('manage_access') ||
        context.capabilities.has('delete') ||
        site.access_role === 'owner' ? (
          <SiteActionsMenu
            site={site}
            disabled={deleting || continuing}
            canPublish={context.capabilities.has('publish')}
            publishDisabled={isPublishing || isSecurityChecking}
            publishLabel={publishLabel}
            publishIcon={PublishIcon}
            canEdit={context.capabilities.has('edit')}
            canConfigureEnvironment={context.capabilities.has('configure_environment')}
            canDelete={context.capabilities.has('delete')}
            canManageCollaborators={site.access_role === 'owner'}
            canManageAccess={context.capabilities.has('manage_access') && network === 'inner'}
            onPublish={context.onPublish}
            onEdit={context.onEdit}
            onConfigureEnvironment={context.onConfigureEnvironment}
            onDelete={context.onDelete}
            onManageCollaborators={context.onManageCollaborators}
            onManageAccess={context.onManageAccess}
          />
        ) : null}
      </div>
    </article>
  )
}

function QrCodeDialog({
  title,
  url,
  onClose,
}: {
  title: string
  url: string
  onClose: () => void
}) {
  const { t } = useTranslation('sites')
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const modules = useMemo(() => {
    try {
      return createQrCodeModules(url)
    } catch (error) {
      console.error('Failed to generate mini program QR code:', error)
      return null
    }
  }, [url])
  const offset = qrCodeOffset()

  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 px-4"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mini-program-qrcode-title"
        data-testid="mini-program-qrcode-dialog"
        className="w-full max-w-[360px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="mini-program-qrcode-title"
              className="truncate text-sm font-semibold text-text-primary"
            >
              {title}
            </h2>
            <p className="mt-1 truncate text-xs leading-5 text-text-secondary">{url}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="mini-program-qrcode-close"
            onClick={onClose}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('close', '关闭')}
          </button>
        </div>
        <div className="mt-5 flex justify-center">
          {modules ? (
            <svg
              data-testid="mini-program-qrcode-svg"
              viewBox={qrCodeViewBox()}
              role="img"
              aria-label={t('qrcode_title', '小程序二维码')}
              className="h-60 w-60 rounded-md bg-white p-2"
              shapeRendering="crispEdges"
            >
              <rect width="100%" height="100%" fill="white" />
              {modules.flatMap((row, y) =>
                row.map((dark, x) =>
                  dark ? (
                    <rect key={`${x}-${y}`} x={x + offset} y={y + offset} width="1" height="1" />
                  ) : null
                )
              )}
            </svg>
          ) : (
            <p className="py-12 text-sm text-text-secondary">
              {t('qrcode_failed', '二维码生成失败')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function MiniProgramThumbnail({ program }: { program: MiniProgram }) {
  const [imageFailed, setImageFailed] = useState(false)

  return (
    <div className="flex h-[50px] w-[50px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface">
      {program.thumbnail_url && !imageFailed ? (
        <img
          src={program.thumbnail_url}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <Smartphone className="h-5 w-5 text-text-muted" aria-hidden="true" />
      )}
    </div>
  )
}

export function MiniProgramApplicationRow({
  program,
  capabilities,
}: {
  program: MiniProgram
  capabilities: ReadonlySet<ApplicationCapability>
}) {
  const { t } = useTranslation('sites')
  const [qrCodeOpen, setQrCodeOpen] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyStateResetTimeoutRef = useRef<number | null>(null)
  const updatedAt = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(program.updated_at))
  const experienceUrl = program.experience_url ?? ''
  const canUseExperienceUrl = capabilities.has('open_experience') && experienceUrl

  useEffect(
    () => () => {
      if (copyStateResetTimeoutRef.current !== null) {
        window.clearTimeout(copyStateResetTimeoutRef.current)
      }
    },
    []
  )

  const copyExperienceUrl = async () => {
    if (!experienceUrl) return
    try {
      await copyTextToClipboard(experienceUrl)
      setCopyState('copied')
      if (copyStateResetTimeoutRef.current !== null) {
        window.clearTimeout(copyStateResetTimeoutRef.current)
      }
      copyStateResetTimeoutRef.current = window.setTimeout(() => {
        copyStateResetTimeoutRef.current = null
        setCopyState('idle')
      }, 1500)
    } catch (error) {
      console.error('Failed to copy mini program URL:', error)
      setCopyState('failed')
    }
  }

  return (
    <article
      data-testid={`mini-program-row-${program.siteid}`}
      className="grid gap-3 border-b border-border py-4 md:grid-cols-[minmax(0,1fr)_120px_120px_120px_120px] md:items-center md:gap-6"
    >
      <div className="flex min-w-0 items-center gap-3">
        <MiniProgramThumbnail program={program} />
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium leading-5 text-text-primary">
            {program.name}
          </h2>
          {program.app_id ? (
            <p className="mt-1 truncate text-sm leading-5 text-text-secondary">
              {t('mini_program_app_id', 'AppID')}：{program.app_id}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 pl-[62px] text-sm md:block md:pl-0">
        <span className="text-text-muted md:hidden">{t('status_column', '状态')}</span>
        <span className="text-text-secondary">{t(`status_${program.status}`, program.status)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 pl-[62px] text-sm md:block md:pl-0">
        <span className="text-text-muted md:hidden">{t('qrcode_column', '二维码')}</span>
        {canUseExperienceUrl ? (
          <>
            <button
              type="button"
              data-testid={`mini-program-qrcode-${program.siteid}`}
              onClick={() => setQrCodeOpen(true)}
              className="inline-flex items-center gap-1.5 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
            >
              <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
              {t('view_qrcode', '查看二维码')}
            </button>
            {qrCodeOpen ? (
              <QrCodeDialog
                title={program.name}
                url={experienceUrl}
                onClose={() => setQrCodeOpen(false)}
              />
            ) : null}
          </>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-4 pl-[62px] text-sm md:block md:pl-0">
        <span className="text-text-muted md:hidden">{t('link_column', '链接')}</span>
        {canUseExperienceUrl ? (
          <button
            type="button"
            data-testid={`mini-program-copy-link-${program.siteid}`}
            onClick={copyExperienceUrl}
            className="inline-flex items-center gap-1.5 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
          >
            {copyState === 'copied' ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {copyState === 'copied'
              ? t('copy_link_copied', '已复制')
              : copyState === 'failed'
                ? t('copy_link_failed', '复制失败')
                : t('copy_link', '复制链接')}
          </button>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-4 pl-[62px] text-sm text-text-secondary md:block md:pl-0">
        <span className="text-text-muted md:hidden">{t('updated_column', '最近更新')}</span>
        <span title={program.updated_at}>{updatedAt}</span>
        {program.version ? <span className="ml-2 text-text-muted">v{program.version}</span> : null}
      </div>
    </article>
  )
}
