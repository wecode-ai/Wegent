export const APP_UPDATE_PENDING_RELEASE_NOTES_KEY = 'wework:pendingAppReleaseNotes'

export interface WeworkInstalledReleaseNotes {
  version: string
  body: string
}

export function readPendingWeworkReleaseNotes(): WeworkInstalledReleaseNotes | null {
  const raw = window.localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as Partial<WeworkInstalledReleaseNotes>
    if (typeof value.version !== 'string' || typeof value.body !== 'string') {
      throw new Error('Invalid release notes record')
    }

    const version = value.version.trim()
    const body = value.body.trim()
    if (!version || !body) {
      throw new Error('Incomplete release notes record')
    }

    return { version, body }
  } catch {
    window.localStorage.removeItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)
    return null
  }
}

export function writePendingWeworkReleaseNotes(releaseNotes: WeworkInstalledReleaseNotes) {
  window.localStorage.setItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY, JSON.stringify(releaseNotes))
}

export function clearPendingWeworkReleaseNotes(version?: string) {
  if (version) {
    const releaseNotes = readPendingWeworkReleaseNotes()
    if (releaseNotes?.version !== version) return
  }

  window.localStorage.removeItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)
}
