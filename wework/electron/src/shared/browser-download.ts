export interface BrowserDownloadRecord {
  id: string
  label: string
  nativeLabel: string
  fileName: string
  path: string | null
  status: 'started' | 'progress' | 'paused' | 'finished' | 'failed' | 'deleted'
  receivedBytes: number
  totalBytes: number
  startedAtMs: number
  updatedAtMs: number
  fileExists?: boolean
}

export interface BrowserDownloadEvent extends BrowserDownloadRecord {
  revision: number
  historyRemoval?: true
}

export type BrowserDownloadChange =
  | BrowserDownloadEvent
  | { cleared: true; revision: number }
  | { historyUnavailable: boolean; revision: number }

export const BROWSER_DOWNLOAD_SNAPSHOT_SIZE = 200

export function isLiveDownload(record: BrowserDownloadRecord): boolean {
  return record.status === 'started' || record.status === 'progress' || record.status === 'paused'
}

export function browserDownloadSnapshot(
  records: Iterable<BrowserDownloadRecord>
): BrowserDownloadRecord[] {
  const sorted = Array.from(records).sort(
    (a, b) => b.startedAtMs - a.startedAtMs || a.id.localeCompare(b.id)
  )
  let available = BROWSER_DOWNLOAD_SNAPSHOT_SIZE - sorted.filter(isLiveDownload).length
  return sorted.filter(record => {
    if (isLiveDownload(record)) return true
    if (available <= 0) return false
    available -= 1
    return true
  })
}
