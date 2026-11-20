import type { SetStateAction } from 'react'
import type { SmartAppsApi, SmartAppAccess, SmartAppAccessTarget } from '@/api/smartApps'
import type { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'
type Translate = ReturnType<typeof useTranslation>['t']
interface AccessSnapshot {
  access: SmartAppAccess | null
  scope: SmartAppAccess['scope']
  targets: SmartAppAccessTarget[]
  saving: boolean
  error: string | null
}
/** Access discovery and edits belong to the exact API and publication. */
export function createMarketplaceAccessSource(api: SmartAppsApi, itemId: number) {
  let snapshot: AccessSnapshot = {
    access: null,
    scope: 'restricted',
    targets: [],
    saving: false,
    error: null,
  }
  let input: { t: Translate; onSaved(access: SmartAppAccess): void } | null = null
  const listeners = new Set<() => void>()
  let generation = 0
  let started = false
  const publish = (change: Partial<AccessSnapshot>) => {
    snapshot = { ...snapshot, ...change }
    listeners.forEach(listener => listener())
  }
  async function load() {
    const current = generation
    try {
      const access = await api.getAccess(itemId)
      if (listeners.size && current === generation)
        publish({ access, scope: access.scope, targets: access.targets })
    } catch (error) {
      if (listeners.size && current === generation && input)
        publish({
          error: getSmartAppErrorMessage(
            error,
            input.t('workbench.smart_apps_access_load_failed', '分享范围加载失败'),
            input.t
          ),
        })
    }
  }
  return {
    getSnapshot: () => snapshot,
    setScope(scope: AccessSnapshot['scope']) {
      publish({ scope })
    },
    setTargets(value: SetStateAction<SmartAppAccessTarget[]>) {
      publish({ targets: typeof value === 'function' ? value(snapshot.targets) : value })
    },
    async save() {
      if (!input || !listeners.size || !snapshot.access) return
      const { t, onSaved } = input
      const current = generation
      const isCurrent = () => listeners.size > 0 && current === generation
      if (snapshot.scope === 'restricted' && !snapshot.targets.length) {
        publish({
          error: t(
            'workbench.smart_apps_access_target_required',
            '请至少选择一个成员或部门，或切换为仅自己'
          ),
        })
        return
      }
      const request = {
        scope: snapshot.scope,
        targets: snapshot.scope === 'restricted' ? snapshot.targets : [],
      }
      publish({ saving: true })
      try {
        const access = await api.updateAccess(itemId, request)
        publish({ access })
        if (isCurrent()) onSaved(access)
      } catch (error) {
        if (isCurrent())
          publish({
            error: getSmartAppErrorMessage(
              error,
              t('workbench.smart_apps_access_save_failed', '分享范围保存失败'),
              t
            ),
          })
      } finally {
        publish({ saving: false })
      }
    },
    subscribe(listener: () => void, next: NonNullable<typeof input>) {
      input = next
      listeners.add(listener)
      if (!started) {
        started = true
        if (!snapshot.access) void load()
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          generation++
          started = false
        })
      }
    },
  }
}
