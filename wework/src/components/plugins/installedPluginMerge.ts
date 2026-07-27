import type { InstalledPlugin } from '@/types/api'

export function localPluginId(item: InstalledPlugin): string | null {
  const payload = item.spec.sourcePayload
  const value =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>).localId : null
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const labels = item.metadata.labels
  const labelId =
    labels && typeof labels === 'object' ? (labels as Record<string, unknown>).id : null
  return typeof labelId === 'string' || typeof labelId === 'number' ? String(labelId) : null
}

export function mergeInstalledPlugins(
  cloudItems: InstalledPlugin[],
  localItems: InstalledPlugin[],
  currentDeviceId = ''
): InstalledPlugin[] {
  const merged = new Map<string, InstalledPlugin>()
  for (const item of cloudItems) {
    if (item.spec.pluginId && item.spec.releaseId) {
      if (
        currentDeviceId &&
        item.spec.installState !== 'installed' &&
        item.spec.installState !== 'update_available'
      ) {
        continue
      }
      merged.set(`market:${item.spec.pluginId}:${item.spec.releaseId}`, item)
    }
  }
  for (const item of localItems) {
    if (item.spec.origin !== 'created' && item.spec.source.type !== 'local') {
      if (cloudItems.length === 0) {
        const id = localPluginId(item)
        if (id) merged.set(`runtime:${id}`, item)
      }
      continue
    }
    const id = localPluginId(item)
    if (id) merged.set(`created:${id}`, item)
  }
  return Array.from(merged.values())
}

export function installedPluginSourceLabel(item: InstalledPlugin): string {
  if (item.spec.sourceLabel) return item.spec.sourceLabel
  if (item.spec.origin === 'created' || item.spec.source.type === 'local') {
    if (item.spec.sourcePayload?.submissionStatus === 'approved') {
      return '我创建的 · 已发布'
    }
    if (item.spec.sourcePayload?.submissionId) {
      return '我创建的 · 审核中'
    }
    return '我创建的'
  }
  if (item.spec.sourceProvider === 'codex') {
    return 'Codex 官方 · Wework 镜像'
  }
  if (item.spec.sourceProvider === 'user') {
    return '社区插件'
  }
  return 'Wegent 官方'
}

export function isCloudManagedInstalledPlugin(item: InstalledPlugin): boolean {
  return item.spec.origin === 'market' || typeof item.spec.pluginId === 'number'
}
