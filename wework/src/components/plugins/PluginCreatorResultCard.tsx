import { Boxes } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { resolvePluginAssetUrl } from './plugin-assets'

export interface PluginCreatorResultCardProps {
  name: string
  description?: string | null
  logoUrl?: string | null
  validationSummary?: string | null
  statusLabel?: string | null
  onViewPlugin?: () => void
  onPublish?: () => void
}

export function PluginCreatorResultCard({
  name,
  description,
  logoUrl,
  validationSummary,
  statusLabel,
  onViewPlugin,
  onPublish,
}: PluginCreatorResultCardProps) {
  const { t } = useTranslation('common')
  const logo = resolvePluginAssetUrl(logoUrl || '')

  return (
    <article
      data-testid="plugin-creator-result-card"
      className="overflow-hidden rounded-xl border border-border/30 bg-background"
    >
      <div className="flex items-start gap-3 border-b border-border/25 px-4 py-3">
        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-border/30 bg-surface">
          {logo ? (
            <img src={logo} alt="" className="h-full w-full object-cover" />
          ) : (
            <Boxes className="h-5 w-5 text-text-muted" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-text-primary">{name}</h3>
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
            {statusLabel ||
              t('workbench.plugins_creator_workspace_status', '已保存在当前对话工作区')}
          </p>
          {description ? (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-secondary">{description}</p>
          ) : null}
        </div>
      </div>
      {validationSummary ? (
        <div className="border-b border-border/25 px-4 py-3 text-xs leading-5 text-text-secondary">
          {validationSummary}
        </div>
      ) : null}
      <div className="flex justify-end gap-2 px-4 py-3">
        {onViewPlugin && (
          <button
            type="button"
            data-testid="plugin-creator-view-plugin"
            className="h-8 rounded-lg border border-border/30 px-3 text-sm font-medium text-text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
            onClick={onViewPlugin}
          >
            {t('workbench.plugins_creator_view_plugin', '查看插件')}
          </button>
        )}
        {onPublish && (
          <button
            type="button"
            data-testid="plugin-creator-publish-plugin"
            className="h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
            onClick={onPublish}
          >
            {t('workbench.plugins_share_and_publish_title', '分享与发布')}
          </button>
        )}
      </div>
    </article>
  )
}
