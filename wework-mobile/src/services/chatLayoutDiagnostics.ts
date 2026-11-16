export const CHAT_LAYOUT_DIAGNOSTICS_FILE = 'chat-layout-diagnostics.jsonl'

const MAX_RECORDS = 1000
const WRITE_INTERVAL_MS = 500
const records: string[] = []
let pending = false
let writing = false
let pendingTimer: ReturnType<typeof setTimeout> | undefined
let lastWriteStartedAt: number | undefined

/** Accepts only the sanitized JSON produced by the chat layout diagnostics hook. */
export function recordChatLayoutDiagnostic(record: string): void {
  if (process.env.EXPO_PUBLIC_CHAT_LAYOUT_DIAGNOSTICS !== '1') return
  records.push(record)
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
  pending = true
  scheduleWrite()
}

function scheduleWrite() {
  if (!pending || writing || pendingTimer !== undefined) return
  const delay =
    lastWriteStartedAt === undefined
      ? WRITE_INTERVAL_MS
      : Math.max(0, lastWriteStartedAt + WRITE_INTERVAL_MS - Date.now())
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined
    void writeSnapshot()
  }, delay)
}

async function writeSnapshot(): Promise<void> {
  if (process.env.EXPO_PUBLIC_CHAT_LAYOUT_DIAGNOSTICS !== '1') {
    pending = false
    return
  }
  writing = true
  pending = false
  lastWriteStartedAt = Date.now()
  const snapshot = `${records.join('\n')}\n`
  try {
    const fileSystem = await import('expo-file-system/legacy')
    if (!fileSystem.cacheDirectory)
      throw new Error('The application cache directory is unavailable')
    await fileSystem.writeAsStringAsync(
      `${fileSystem.cacheDirectory}${CHAT_LAYOUT_DIAGNOSTICS_FILE}`,
      snapshot
    )
  } catch (error) {
    console.warn('[ChatLayout] Failed to write diagnostic cache snapshot', error)
  } finally {
    writing = false
    scheduleWrite()
  }
}
