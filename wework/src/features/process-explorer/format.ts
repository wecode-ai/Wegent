export function formatMemory(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export function formatCpu(percent: number | null): string {
  return percent === null ? '—' : percent.toFixed(1)
}

export function formatAge(startedAt: number | null, now = Date.now()): string {
  if (startedAt === null) return '—'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export interface LaunchDetailParts {
  command: string
  args: string | null
}

/**
 * Windows launch details can use the NT object-manager prefix
 * (`\??\C:\...`). It is an implementation detail, not part of the path.
 */
export function normalizeLaunchDetail(detail: string): string {
  return detail.replace(/^\\\?\?\\/, '').trim()
}

/**
 * Splits the OS-reported launch detail into the executable and its arguments.
 * Only Windows details are split: macOS executable paths commonly contain
 * spaces, so guessing there would truncate the path.
 */
export function splitLaunchDetail(detail: string, platform: string): LaunchDetailParts {
  const normalized = normalizeLaunchDetail(detail)
  if (!normalized) return { command: '', args: null }
  if (platform !== 'win32') return { command: normalized, args: null }

  const quoted = normalized.match(/^"([^"]+)"(?:\s+(.*))?$/)
  if (quoted) return { command: quoted[1], args: quoted[2]?.trim() || null }

  const executable = normalized.match(/^(.*?\.(?:exe|com|bat|cmd))(?:\s+(.*))?$/i)
  if (executable) return { command: executable[1], args: executable[2]?.trim() || null }

  return { command: normalized, args: null }
}
