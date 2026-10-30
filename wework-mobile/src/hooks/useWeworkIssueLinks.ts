import { useCallback, useEffect, useRef } from 'react'

import {
  parseWeworkIssueLink,
  weworkAppLinkOrigins,
  type WeworkIssueDestination,
} from '@/domain/weworkIssueLink'

export function useWeworkIssueLinks(
  url: string | null,
  webUrl: string | undefined,
  isReady: () => boolean,
  navigate: (destination: WeworkIssueDestination) => void,
  onConsumed: () => void
): () => void {
  const pending = useRef<WeworkIssueDestination | null>(null)
  const requestRevision = useRef(0)

  useEffect(() => {
    if (!url) return
    const issue = parseWeworkIssueLink(url, weworkAppLinkOrigins(webUrl))
    if (issue) {
      requestRevision.current += 1
      const destination = { ...issue, focusRequest: `mobile-${requestRevision.current}` }
      if (isReady()) navigate(destination)
      else pending.current = destination
    }
    onConsumed()
  }, [isReady, navigate, onConsumed, url, webUrl])

  return useCallback(() => {
    const destination = pending.current
    if (!destination) return
    pending.current = null
    navigate(destination)
  }, [navigate])
}
