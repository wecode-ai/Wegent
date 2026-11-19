import { useState } from 'react'
import type { SitesApi } from '@/api/sites'

/** API and site changes start a fresh modal form, including any pending operation state. */
export function useSiteDialogScope(api: SitesApi, siteId: string) {
  const [restoreFocus] = useState(() => {
    const opener = document.activeElement
    return () => (opener instanceof HTMLElement ? opener : null)
  })
  const [owner, setOwner] = useState({ api, siteId, revision: 0 })
  if (owner.api !== api || owner.siteId !== siteId) {
    setOwner({ api, siteId, revision: owner.revision + 1 })
  }
  return { key: owner.revision, restoreFocus }
}
