import type { PluginOperationNoticeState } from './PluginOperationNotice'

export function pluginOperationNoticeAutoDismissDelay(
  notice: PluginOperationNoticeState | null
): number | null {
  if (notice?.kind === 'success' && !notice.actionLabel) return 4_000
  if (notice?.id === 'plugin-reconciliation-error') return 8_000
  return null
}
