import { Link2 } from 'lucide-react'
import { useMemo } from 'react'
import { openExternalUrl } from '@/lib/external-links'
import { getRecognizedLink } from '@/lib/link-preview'

export interface ComposerLinkChipPayload {
  url: string
  label: string
}

interface ComposerLinkChipProps {
  payload: ComposerLinkChipPayload
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

export function ComposerLinkChip({ payload }: ComposerLinkChipProps) {
  const recognized = useMemo(() => getRecognizedLink(payload.url), [payload.url])
  const hostname = safeHostname(payload.url)
  const iconUrl = recognized?.iconUrl ?? (hostname ? `https://${hostname}/favicon.ico` : undefined)

  return (
    <a
      data-testid="composer-link-chip"
      data-composer-link-url={payload.url}
      data-composer-link-provider={recognized?.provider ?? 'external'}
      href={payload.url}
      className="composer-link-node composer-mention-link inline-flex cursor-pointer items-center"
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        void openExternalUrl(payload.url)
      }}
      title={payload.url}
    >
      <span className="composer-mention-icon-slot" aria-hidden="true">
        {iconUrl ? (
          <img className="composer-mention-icon" src={iconUrl} alt="" loading="lazy" />
        ) : (
          <Link2 className="composer-mention-icon h-4 w-4" />
        )}
      </span>
      <span className="composer-mention-label">{payload.label}</span>
    </a>
  )
}
