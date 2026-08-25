const SMART_APP_DEVELOPMENT_PREVIEW_KEY = 'wework:pending-smart-app-development-preview'

export interface PendingSmartAppDevelopmentPreview {
  installationId: string
  displayName: string
}

function isPendingSmartAppDevelopmentPreview(
  value: unknown
): value is PendingSmartAppDevelopmentPreview {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PendingSmartAppDevelopmentPreview>
  return (
    typeof candidate.installationId === 'string' &&
    candidate.installationId.trim().length > 0 &&
    typeof candidate.displayName === 'string' &&
    candidate.displayName.trim().length > 0
  )
}

export function queueSmartAppDevelopmentPreview(preview: PendingSmartAppDevelopmentPreview): void {
  window.sessionStorage.setItem(SMART_APP_DEVELOPMENT_PREVIEW_KEY, JSON.stringify(preview))
}

export function consumeSmartAppDevelopmentPreview(): PendingSmartAppDevelopmentPreview | null {
  const raw = window.sessionStorage.getItem(SMART_APP_DEVELOPMENT_PREVIEW_KEY)
  if (!raw) return null
  window.sessionStorage.removeItem(SMART_APP_DEVELOPMENT_PREVIEW_KEY)
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPendingSmartAppDevelopmentPreview(parsed) ? parsed : null
  } catch {
    return null
  }
}
