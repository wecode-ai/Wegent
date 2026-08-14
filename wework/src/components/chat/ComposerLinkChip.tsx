import { useEffect, useMemo, useState } from 'react'
import { openExternalUrl } from '@/lib/external-links'
import {
  faviconPlaceholderUrl,
  GENERIC_LINK_ICON_SRC,
  resolveAndProbeIcon,
  resolveFavicon,
} from '@/lib/favicon-resolver'
import { getRecognizedLink } from '@/lib/link-preview'

export interface ComposerLinkChipPayload {
  url: string
  label: string
}

interface ComposerLinkChipProps {
  payload: ComposerLinkChipPayload
}

function LinkChipIcon({
  url,
  defaultIconUrl,
  provider,
}: {
  url: string
  defaultIconUrl?: string
  provider: string
}) {
  const [iconUrl, setIconUrl] = useState(defaultIconUrl)
  const [iconFailed, setIconFailed] = useState(false)

  useEffect(() => {
    if (provider !== 'web') return
    let cancelled = false
    resolveAndProbeIcon(
      faviconPlaceholderUrl(url),
      resolveFavicon(url),
      setIconUrl,
      () => cancelled
    )
    return () => {
      cancelled = true
    }
  }, [provider, url])

  if (iconUrl && !iconFailed) {
    return (
      <img
        className="composer-mention-icon"
        src={iconUrl}
        alt=""
        loading="lazy"
        onError={() => setIconFailed(true)}
      />
    )
  }
  return <img className="composer-mention-icon" src={GENERIC_LINK_ICON_SRC} alt="" loading="lazy" />
}

export function ComposerLinkChip({ payload }: ComposerLinkChipProps) {
  const recognized = useMemo(() => getRecognizedLink(payload.url), [payload.url])
  const href = recognized?.fullUrl ?? payload.url

  return (
    <a
      data-testid="composer-link-chip"
      data-composer-link-url={href}
      data-composer-link-provider={recognized?.provider ?? 'external'}
      href={href}
      className="composer-link-node composer-mention-link inline-flex cursor-pointer items-center"
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        void openExternalUrl(href)
      }}
      title={href}
    >
      <span className="composer-mention-icon-slot" aria-hidden="true">
        <LinkChipIcon
          key={payload.url}
          url={payload.url}
          defaultIconUrl={recognized?.iconUrl}
          provider={recognized?.provider ?? 'external'}
        />
      </span>
      <span className="composer-mention-label">{payload.label}</span>
    </a>
  )
}
