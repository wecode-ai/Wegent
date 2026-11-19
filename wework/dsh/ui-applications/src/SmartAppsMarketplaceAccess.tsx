import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { createMarketplaceAccessSource } from './marketplaceAccessSource'
import { useCallback, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import type {
  SmartAppAccess,
  SmartAppAccessTarget,
  SmartAppMarketplaceItem,
  SmartAppsApi,
} from '@/api/smartApps'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export function TargetPicker({
  api,
  targets,
  onChange,
}: {
  api: SmartAppsApi
  targets: SmartAppAccessTarget[]
  onChange: (targets: SmartAppAccessTarget[]) => void
}) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const resource = useMemo(
    () =>
      createAsyncResource<SmartAppAccessTarget[]>(
        query,
        async () => {
          const [users, groups] = await Promise.all([
            api.searchUsers(query),
            api.searchGroups(query),
          ])
          return [
            ...users.map(user => ({
              entityType: 'user' as const,
              entityId: String(user.id),
              displayName: user.user_name,
            })),
            ...groups.map(group => ({
              entityType: 'namespace' as const,
              entityId: String(group.id),
              displayName: group.display_name || group.name,
            })),
          ]
        },
        { delayMs: 250 }
      ),
    [api, query]
  )
  const result = useSyncExternalStore(
    query.trim() ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const results = result.data ?? []

  return (
    <div>
      <label className="relative block">
        <Search className="absolute left-3 top-3 h-4 w-4 text-text-muted" />
        <ControlInput
          data-testid="smart-app-target-search"
          value={query}
          placeholder={t('workbench.smart_apps_target_search', '搜索成员或部门')}
          className="h-10 w-full rounded-lg border border-border pl-9 pr-3 text-sm"
          onChange={event => setQuery(event.target.value)}
        />
      </label>
      {results.length ? (
        <div className="mt-1 max-h-36 overflow-y-auto rounded-lg border bg-background p-1">
          {results.map(result => (
            <ControlButton
              variant="unstyled"
              key={`${result.entityType}-${result.entityId}`}
              type="button"
              className="flex w-full justify-between rounded-md px-3 py-2 text-sm hover:bg-surface"
              onClick={() => {
                if (
                  !targets.some(
                    value =>
                      value.entityType === result.entityType && value.entityId === result.entityId
                  )
                )
                  onChange([...targets, result])
                setQuery('')
              }}
            >
              <span>{result.displayName}</span>
              <span className="text-xs text-text-muted">
                {result.entityType === 'user'
                  ? t('workbench.smart_apps_member', '成员')
                  : t('workbench.smart_apps_department', '部门')}
              </span>
            </ControlButton>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {targets.map(target => (
          <span
            key={`${target.entityType}-${target.entityId}`}
            className="inline-flex items-center gap-1 rounded-lg bg-surface px-2 py-1 text-sm"
          >
            {target.displayName}
            <ControlButton
              variant="unstyled"
              type="button"
              aria-label={t('workbench.smart_apps_remove_target', '移除 {{name}}').replace(
                '{{name}}',
                target.displayName
              )}
              onClick={() => onChange(targets.filter(value => value !== target))}
            >
              <X className="h-3 w-3" />
            </ControlButton>
          </span>
        ))}
      </div>
    </div>
  )
}

export function SmartAppShareDialog({
  api,
  item,
  onClose,
  onSaved,
}: {
  api: SmartAppsApi
  item: SmartAppMarketplaceItem
  onClose: () => void
  onSaved: (access: SmartAppAccess) => void
}) {
  const { t } = useTranslation('common')
  const resource = useMemo(() => createMarketplaceAccessSource(api, item.id), [api, item.id])
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, { t, onSaved }),
    [resource, t, onSaved]
  )
  const { access, scope, targets, saving, error } = useSyncExternalStore(
    subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const { setScope, setTargets, save } = resource
  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4">
      <DialogSurface
        onClose={onClose}
        render={
          <section
            data-testid="smart-app-share-dialog"
            className="plugin-dialog-surface w-full max-w-lg p-5"
          />
        }
      >
        <header className="flex justify-between">
          <div>
            <h2 className="heading-small">{t('workbench.smart_apps_manage_access', '管理分享')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{item.displayName}</p>
          </div>
          <ControlButton
            variant="unstyled"
            aria-label={t('common.close', '关闭')}
            data-testid="smart-app-share-close"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </header>
        {access ? (
          <>
            <div className="mt-5 grid grid-cols-3 gap-2 rounded-xl bg-surface p-1">
              <ControlButton
                variant="unstyled"
                type="button"
                className={`h-11 rounded-lg ${scope === 'private' ? 'bg-background shadow-sm' : ''}`}
                onClick={() => setScope('private')}
                data-testid="smart-app-share-scope-private"
              >
                {t('workbench.smart_apps_private', '仅自己')}
              </ControlButton>
              <ControlButton
                variant="unstyled"
                type="button"
                className={`h-11 rounded-lg ${scope === 'restricted' ? 'bg-background shadow-sm' : ''}`}
                onClick={() => setScope('restricted')}
                data-testid="smart-app-share-scope-restricted"
              >
                {t('workbench.smart_apps_restricted', '指定成员/部门')}
              </ControlButton>
              <ControlButton
                variant="unstyled"
                type="button"
                className={`h-11 rounded-lg ${scope === 'public' ? 'bg-background shadow-sm' : ''}`}
                onClick={() => setScope('public')}
                data-testid="smart-app-share-scope-public"
              >
                {t('workbench.smart_apps_public', '全员')}
              </ControlButton>
            </div>
            {scope === 'restricted' ? (
              <div className="mt-4">
                <TargetPicker api={api} targets={targets} onChange={setTargets} />
              </div>
            ) : (
              <p className="mt-4 text-sm text-text-secondary">
                {scope === 'public'
                  ? t(
                      'workbench.smart_apps_share_public_hint',
                      '将当前已发布版本 v{{version}} 上架到智能应用市场，所有成员均可查看和安装。本地后续修改不会自动同步，需发布新版本。'
                    ).replace('{{version}}', item.version)
                  : t(
                      'workbench.smart_apps_revoke_hint',
                      '取消分享后，接收者不能继续下载或更新；已安装到本地的副本仍可离线运行。'
                    )}
              </p>
            )}
          </>
        ) : (
          <p className="mt-5 text-sm text-text-muted">
            {t('workbench.smart_apps_loading', '正在加载…')}
          </p>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <footer className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} data-testid="smart-app-share-cancel">
            {t('common.cancel', '取消')}
          </Button>
          <Button
            disabled={!access || saving}
            onClick={() => void save()}
            data-testid="smart-app-share-save"
          >
            {saving ? t('workbench.smart_apps_saving', '保存中…') : t('common.save', '保存')}
          </Button>
        </footer>
      </DialogSurface>
    </div>
  )
}
