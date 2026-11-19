import { Globe2 } from 'lucide-react'
import { useState } from 'react'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '../../controls/HoverCard'
import { controlPopup } from '../../controls/recipes'
import { useCollaborationPortalTheme } from '../../theme'
import { useMarkdownServices } from '../../markdown/MarkdownServices'
import { useConversationTranslation } from '../ConversationTranslation'
import type {
  WebSearchActivityItem,
  WebSearchSourceItem,
} from './webSearchActivity'

export function WebSearchActivityRows({
  items,
}: {
  items: WebSearchActivityItem[]
}) {
  if (items.length === 0) return null

  return (
    <div
      data-testid="web-search-activity-results"
      className="flex min-w-0 flex-col gap-1.5 text-sm leading-5 text-text-muted"
    >
      {items.map((item) => (
        <div key={item.id} className="flex min-w-0 items-start gap-1.5">
          {item.iconUrl ? (
            <WebSearchFavicon iconUrl={item.iconUrl} domain={item.domain} />
          ) : (
            <Globe2
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={1.7}
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 break-words">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

export function WebSearchSourcesChip({
  sources,
}: {
  sources: WebSearchSourceItem[]
}) {
  const theme = useCollaborationPortalTheme()
  const { openExternalUrl } = useMarkdownServices()
  const { t } = useConversationTranslation()
  if (sources.length === 0) return null

  const primarySource = sources[0]

  return (
    <div className="mt-2 flex min-w-0">
      <HoverCard delay={0} closeDelay={120}>
        <HoverCardTrigger
          render={<button type="button" />}
          data-testid="web-search-sources-chip"
          className="min-h-11 md:min-h-7 inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary/30"
        >
          <WebSearchFavicon
            iconUrl={primarySource.iconUrl}
            domain={primarySource.domain}
          />
          <span>{t('tool_activity.sources')}</span>
        </HoverCardTrigger>
        <HoverCardContent
          {...theme}
          side="top"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          data-testid="web-search-source-popup"
          className={
            theme.className +
            ' ' +
            controlPopup +
            ' w-[min(26rem,calc(100vw-1rem))] p-2 text-left'
          }
        >
          <span className="flex min-w-0 flex-col gap-1">
            {sources.map((source) => (
              <a
                key={source.id}
                href={source.url}
                data-testid="web-search-source-popup-row"
                className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm leading-5 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:bg-muted focus-visible:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border"
                onClick={(event) => {
                  event.preventDefault()
                  void Promise.resolve(openExternalUrl(source.url)).catch(
                    (error) => {
                      console.error('Failed to open web search source:', error)
                    },
                  )
                }}
              >
                <WebSearchFavicon
                  iconUrl={source.iconUrl}
                  domain={source.domain}
                />
                <span className="min-w-0 flex-1 truncate">{source.label}</span>
              </a>
            ))}
          </span>
        </HoverCardContent>
      </HoverCard>
    </div>
  )
}

function WebSearchFavicon({
  iconUrl,
  domain,
}: {
  iconUrl: string
  domain?: string
}) {
  const [hasLoadError, setHasLoadError] = useState(false)

  return (
    <span
      data-testid="web-search-source-icon"
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-base text-text-muted"
      aria-hidden="true"
      title={domain}
    >
      {!hasLoadError ? (
        <img
          src={iconUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setHasLoadError(true)}
        />
      ) : (
        <Globe2 className="h-3 w-3" strokeWidth={1.8} />
      )}
    </span>
  )
}
