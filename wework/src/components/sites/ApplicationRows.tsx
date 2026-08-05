import { useState } from 'react'
import { AlertCircle, Check, ExternalLink, Globe2, Loader2, Smartphone, Upload } from 'lucide-react'
import type { ApplicationCapability, MiniProgram, Site } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { SiteActionsMenu } from './SiteActionsMenu'

export interface ApplicationRowContext {
  capabilities: ReadonlySet<ApplicationCapability>
  publishingIds: ReadonlySet<string>
  deletingSiteId: string | null
  onPublish: (site: Site) => void
  onDelete: (site: Site) => void
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
  const isPublished = site.publish_status === 'published'
  const isPublishing = publishing || site.publish_status === 'publishing'
  const isFailed = site.publish_status === 'failed'

  const openUrl = (url: string) => {
    void openExternalUrl(url).catch(error => {
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
          {site.external_url ? (
            <button
              type="button"
              data-testid={`site-external-url-${site.siteid}`}
              aria-label={t('open_external', { name: site.name })}
              onClick={() => openUrl(site.external_url!)}
              className="flex max-w-full items-center gap-1 text-left text-sm leading-5 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
            >
              <span className="truncate">{site.external_url}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </button>
          ) : isFailed ? (
            <span className="flex items-center gap-1.5 text-sm text-danger">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {site.last_publish_error || t('publish_failed', '发布失败')}
              </span>
            </span>
          ) : (
            <span className="text-sm text-text-muted">—</span>
          )}
        </div>
        {context.capabilities.has('publish') ? (
          <button
            type="button"
            data-testid={`site-publish-${site.siteid}`}
            disabled={isPublished || isPublishing || deleting}
            onClick={() => context.onPublish(site)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-default disabled:text-text-secondary disabled:opacity-70"
          >
            {isPublishing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : isPublished ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {isPublishing
              ? t('publishing', '发布中')
              : isPublished
                ? t('published', '已发布')
                : isFailed
                  ? t('retry_publish', '重试发布')
                  : t('publish', '发布到外网')}
          </button>
        ) : null}
        {context.capabilities.has('delete') ? (
          <SiteActionsMenu
            site={site}
            disabled={isPublishing || deleting}
            onDelete={context.onDelete}
          />
        ) : null}
      </div>
    </article>
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
  const updatedAt = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(program.updated_at))
  const canOpenExperience = capabilities.has('open_experience') && program.experience_url

  const openExperience = () => {
    if (!program.experience_url) return
    void openExternalUrl(program.experience_url).catch(error => {
      console.error('Failed to open mini program experience URL:', error)
    })
  }

  return (
    <article
      data-testid={`mini-program-row-${program.siteid}`}
      className="grid gap-3 border-b border-border py-4 md:grid-cols-[minmax(0,1fr)_140px_120px] md:items-center md:gap-6"
    >
      <div className="flex min-w-0 items-center gap-3">
        <MiniProgramThumbnail program={program} />
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium leading-5 text-text-primary">
            {program.name}
          </h2>
          <p className="mt-1 truncate text-sm leading-5 text-text-secondary">
            {t('mini_program_app_id', 'AppID')}：{program.app_id}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 pl-[62px] text-sm md:block md:pl-0">
        <span className="text-text-muted md:hidden">{t('status_column', '状态')}</span>
        {canOpenExperience ? (
          <button
            type="button"
            data-testid={`mini-program-experience-${program.siteid}`}
            onClick={openExperience}
            className="inline-flex items-center gap-1 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
          >
            {t(`status_${program.status}`, program.status)}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <span className="text-text-secondary">
            {t(`status_${program.status}`, program.status)}
          </span>
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
