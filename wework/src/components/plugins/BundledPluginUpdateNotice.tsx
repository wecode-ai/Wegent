import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  ensureBundledPluginInstalled,
  getBundledPluginUpdateState,
  subscribeBundledPluginUpdates,
} from '@/desktop/localExecutor'

export function BundledPluginUpdateNotice({ name }: { name: string }) {
  const { t } = useTranslation()
  const state = useSyncExternalStore(subscribeBundledPluginUpdates, () =>
    getBundledPluginUpdateState(name)
  )
  if (!state || state.status === 'ready') return null
  const message =
    state.status === 'updating'
      ? t('workbench.bundled_plugin_updating', '正在更新内置插件…')
      : state.status === 'deferred'
        ? t(
            'workbench.bundled_plugin_update_deferred',
            '插件将在当前任务结束后更新，请稍后再使用。'
          )
        : t('workbench.bundled_plugin_update_failed', '内置插件更新失败，旧版本已保留。请重试。')
  return (
    <div
      role="status"
      data-testid={`bundled-plugin-update-${name}`}
      className="mt-4 text-sm text-text-secondary"
    >
      {message}
      {state.status === 'failed' && (
        <Button
          variant="outline"
          className="ml-3"
          data-testid={`bundled-plugin-update-retry-${name}`}
          onClick={() => {
            void ensureBundledPluginInstalled(name).catch(error =>
              console.warn('[plugins] bundled plugin update failed', error)
            )
          }}
        >
          {t('common.retry', '重试')}
        </Button>
      )}
    </div>
  )
}
