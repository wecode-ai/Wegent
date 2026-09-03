import { X } from 'lucide-react'
import { useState } from 'react'
import type { PluginShareGroupSearchItem, PluginShareUserSearchItem } from '@/api/plugins'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginAccessResponse, PluginAccessTarget } from '@/types/api'
import { PluginShareTargetSearch } from './PluginShareTargetSearch'

interface PluginShareDialogProps {
  pluginName: string
  access: PluginAccessResponse
  saving: boolean
  error?: string | null
  onClose: () => void
  onSave: (access: {
    scope: 'private' | 'restricted'
    targets: PluginAccessTarget[]
    allowCopy: boolean
  }) => void
  searchUsers: (query: string) => Promise<PluginShareUserSearchItem[]>
  searchGroups: (query: string) => Promise<PluginShareGroupSearchItem[]>
}

export function PluginShareDialog({
  pluginName,
  access,
  saving,
  error,
  onClose,
  onSave,
  searchUsers,
  searchGroups,
}: PluginShareDialogProps) {
  const { t } = useTranslation('common')
  const [scope, setScope] = useState(access.scope)
  const [targets, setTargets] = useState(access.targets)
  const [allowCopy, setAllowCopy] = useState(access.allowCopy)

  const addTarget = (target: PluginAccessTarget) => {
    setTargets(current =>
      current.some(
        item => item.entityType === target.entityType && item.entityId === target.entityId
      )
        ? current
        : [...current, target]
    )
  }

  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center p-0 sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-share-title"
        data-testid="plugin-share-dialog"
        className="plugin-dialog-surface w-full max-w-lg rounded-b-none p-5 sm:rounded-b-[20px]"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 id="plugin-share-title" className="heading-small text-text-primary">
              {t('workbench.plugins_share_title', '定向分享插件')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">{pluginName}</p>
          </div>
          <button
            type="button"
            data-testid="plugin-share-close"
            aria-label={t('common.close', '关闭')}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20 sm:h-8 sm:w-8"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="mt-5 grid grid-cols-2 gap-2 rounded-xl bg-surface p-1">
          <button
            type="button"
            data-testid="plugin-share-scope-private"
            className={`h-10 rounded-lg text-sm ${
              scope === 'private'
                ? 'bg-background font-medium shadow-sm'
                : 'text-text-secondary hover:bg-background/60'
            }`}
            onClick={() => {
              setScope('private')
              setAllowCopy(false)
            }}
          >
            {t('workbench.plugins_share_private', '仅自己')}
          </button>
          <button
            type="button"
            data-testid="plugin-share-scope-restricted"
            className={`h-10 rounded-lg text-sm ${
              scope === 'restricted'
                ? 'bg-background font-medium shadow-sm'
                : 'text-text-secondary hover:bg-background/60'
            }`}
            onClick={() => setScope('restricted')}
          >
            {t('workbench.plugins_share_restricted', '指定成员')}
          </button>
        </div>

        {scope === 'restricted' && (
          <div className="mt-4">
            <PluginShareTargetSearch
              searchUsers={searchUsers}
              searchGroups={searchGroups}
              onSelect={addTarget}
            />

            <div className="mt-3 flex flex-wrap gap-2" data-testid="plugin-share-targets">
              {targets.map(target => (
                <span
                  key={`${target.entityType}-${target.entityId}`}
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-surface pl-2.5 pr-1 text-sm"
                >
                  {target.displayName}
                  <button
                    type="button"
                    aria-label={`${t('common.remove', '移除')} ${target.displayName}`}
                    className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                    onClick={() =>
                      setTargets(current =>
                        current.filter(
                          item =>
                            item.entityType !== target.entityType ||
                            item.entityId !== target.entityId
                        )
                      )
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>

            <label className="mt-4 flex min-h-11 items-center justify-between gap-4 rounded-xl border border-border/30 px-3 transition-colors hover:bg-surface">
              <span>
                <strong className="block text-sm font-medium">
                  {t('workbench.plugins_share_allow_copy', '允许复制')}
                </strong>
                <small className="block text-xs text-text-muted">
                  {t('workbench.plugins_share_allow_copy_hint', '接收者可创建独立的本地副本')}
                </small>
              </span>
              <input
                type="checkbox"
                checked={allowCopy}
                data-testid="plugin-share-allow-copy"
                className="h-4 w-4 accent-neutral-900"
                onChange={event => setAllowCopy(event.target.checked)}
              />
            </label>
          </div>
        )}

        <p className="mt-4 text-xs text-text-muted">
          {t(
            'workbench.plugins_share_manage_hint',
            '仅用于管理个人插件的可见成员；扩大到组织或全部请使用「发布」。'
          )}
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
        <footer className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="h-10 rounded-lg px-4 text-sm hover:bg-surface"
            onClick={onClose}
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="plugin-share-save"
            disabled={saving || (scope === 'restricted' && targets.length === 0)}
            className="h-10 rounded-lg bg-text-primary px-4 text-sm font-medium text-background disabled:opacity-40"
            onClick={() =>
              onSave({ scope, targets: scope === 'private' ? [] : targets, allowCopy })
            }
          >
            {saving ? t('workbench.plugins_share_saving', '保存中…') : t('common.save', '保存')}
          </button>
        </footer>
      </section>
    </div>
  )
}
