import { useState } from 'react'
import { Globe2 } from 'lucide-react'
import { openExternalUrl } from '@/lib/external-links'
import type { WebSearchActivityItem, WebSearchSourceItem } from './webSearchActivity'

export function WebSearchActivityRows({ items }: { items: WebSearchActivityItem[] }) {
  if (items.length === 0) return null

  return (
    <div
      data-testid="web-search-activity-results"
      className="flex min-w-0 flex-col gap-1.5 text-[13px] leading-5 text-text-muted"
    >
      {items.map(item => (
        <div key={item.id} className="flex min-w-0 items-start gap-1.5">
          {item.iconUrl ? <WebSearchFavicon iconUrl={item.iconUrl} domain={item.domain} /> : null}
          <span className="min-w-0 break-words">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

export function WebSearchSourcesChip({ sources }: { sources: WebSearchSourceItem[] }) {
  if (sources.length === 0) return null

  const primarySource = sources[0]

  return (
    <div className="mt-2 flex min-w-0">
      <span className="group/web-search-sources relative inline-flex min-w-0">
        <button
          type="button"
          data-testid="web-search-sources-chip"
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <WebSearchFavicon iconUrl={primarySource.iconUrl} domain={primarySource.domain} />
          <span>来源</span>
        </button>
        <span className="absolute bottom-full left-0 z-popover hidden max-w-[calc(100vw-3rem)] pb-1 group-hover/web-search-sources:block group-focus-within/web-search-sources:block">
          <span
            data-testid="web-search-source-popup"
            className="block w-[min(26rem,calc(100vw-3rem))] rounded-xl border border-border bg-popover p-2 text-left text-text-primary shadow-2xl"
          >
            <span className="flex min-w-0 flex-col gap-1">
              {sources.map(source => (
                <a
                  key={source.id}
                  href={source.url}
                  data-testid="web-search-source-popup-row"
                  className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] leading-5 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
                  onClick={event => {
                    event.preventDefault()
                    void openExternalUrl(source.url).catch(error => {
                      console.error('Failed to open web search source:', error)
                    })
                  }}
                >
                  <WebSearchFavicon iconUrl={source.iconUrl} domain={source.domain} />
                  <span className="min-w-0 flex-1 truncate">{source.label}</span>
                </a>
              ))}
            </span>
          </span>
        </span>
      </span>
    </div>
  )
}

function WebSearchFavicon({ iconUrl, domain }: { iconUrl: string; domain?: string }) {
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
