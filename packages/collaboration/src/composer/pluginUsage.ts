const PLUGIN_USAGE_STORAGE_KEY = 'wework:plugin-usage-30d'
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function normalizePluginKey(pluginName: string): string {
  return pluginName.trim().toLowerCase()
}

function readUsageMap(): Record<string, number[]> {
  try {
    const raw = window.localStorage.getItem(PLUGIN_USAGE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        Array.isArray(value) && value.every(item => typeof item === 'number')
          ? [[key, value as number[]]]
          : []
      )
    )
  } catch {
    return {}
  }
}

function writeUsageMap(map: Record<string, number[]>): void {
  window.localStorage.setItem(PLUGIN_USAGE_STORAGE_KEY, JSON.stringify(map))
}

export function getPluginUseCount30d(pluginName: string): number {
  const key = normalizePluginKey(pluginName)
  if (!key) return 0
  const cutoff = Date.now() - THIRTY_DAYS_MS
  return (readUsageMap()[key] ?? []).filter(timestamp => timestamp >= cutoff).length
}

export function recordPluginUsage(pluginName: string): void {
  const key = normalizePluginKey(pluginName)
  if (!key) return
  const map = readUsageMap()
  const cutoff = Date.now() - THIRTY_DAYS_MS
  map[key] = [...(map[key] ?? []).filter(timestamp => timestamp >= cutoff), Date.now()]
  writeUsageMap(map)
}

const PLUGIN_MENTION_PATTERN = /\[\$([^\]]+)\]\((plugin:\/\/[^)]+)\)/g

export function recordPluginUsageFromInput(input: string): void {
  const seen = new Set<string>()
  for (const match of input.matchAll(PLUGIN_MENTION_PATTERN)) {
    const pluginName = match[1]?.trim()
    if (!pluginName || seen.has(pluginName)) continue
    seen.add(pluginName)
    recordPluginUsage(pluginName)
  }
}
