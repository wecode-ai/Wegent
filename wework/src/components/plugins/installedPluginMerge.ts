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

function pluginKey(item: InstalledPlugin): string {
  return String(item.spec.source.pluginKey || item.metadata.name || '')
    .trim()
    .toLowerCase()
}

export function mergeInstalledPlugins(
  cloudItems: InstalledPlugin[],
  localItems: InstalledPlugin[],
  currentDeviceId = ''
): InstalledPlugin[] {
  const merged = new Map<string, InstalledPlugin>()
  const cloudPluginKeys = new Set<string>()

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
      const key = pluginKey(item)
      if (key) cloudPluginKeys.add(key)
    }
  }

  for (const item of localItems) {
    if (item.spec.origin === 'created' || item.spec.source.type === 'local') {
      const id = localPluginId(item)
      if (id) merged.set(`created:${id}`, item)
      continue
    }

    // Keep local Codex marketplace installs visible in management/library even when
    // cloud installs exist. Skip only when the cloud catalog already owns the same key.
    const key = pluginKey(item)
    if (key && cloudPluginKeys.has(key)) continue
    const id = localPluginId(item)
    if (id) merged.set(`runtime:${id}`, item)
  }

  return Array.from(merged.values())
}

export function installedPluginSourceLabel(
  item: InstalledPlugin,
  t?: (key: string, defaultValue?: string) => string
): string {
  if (item.spec.sourceLabel) return item.spec.sourceLabel
  if (item.spec.origin === 'created' || item.spec.source.type === 'local') {
    const status = item.spec.sourcePayload?.submissionStatus
    if (status === 'approved') {
      return t
        ? t('workbench.plugins_created_source_approved', '我创建的 · 已发布')
        : '我创建的 · 已发布'
    }
    if (status === 'rejected') {
      return t
        ? t('workbench.plugins_created_source_rejected', '我创建的 · 已拒绝')
        : '我创建的 · 已拒绝'
    }
    if (item.spec.sourcePayload?.submissionId || status === 'pending') {
      return t
        ? t('workbench.plugins_created_source_pending', '我创建的 · 审核中')
        : '我创建的 · 审核中'
    }
    return t ? t('workbench.plugins_created_by_me', '我创建的') : '我创建的'
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
  return typeof item.spec.pluginId === 'number'
}
