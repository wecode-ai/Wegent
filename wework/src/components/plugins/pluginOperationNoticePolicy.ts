import type { PluginOperationNoticeState } from './PluginOperationNotice'

export function pluginOperationNoticeAutoDismissDelay(
  notice: PluginOperationNoticeState | null
): number | null {
  if (notice?.kind === 'success' && !notice.actionLabel) return 4_000
  if (notice?.kind === 'error' && !notice.actionLabel) return 8_000
  return null
}
