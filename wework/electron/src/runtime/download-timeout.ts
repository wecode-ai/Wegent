export function createDownloadInactivityTimeout(timeoutMs: number): {
  signal: AbortSignal
  refresh: () => void
  clear: () => void
} {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | null = null
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const refresh = () => {
    clear()
    timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref()
  }
  refresh()
  return { signal: controller.signal, refresh, clear }
}
