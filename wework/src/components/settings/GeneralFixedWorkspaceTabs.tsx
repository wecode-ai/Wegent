import { ArrowDown, ArrowUp, Pin, X } from 'lucide-react'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { FixedWorkspaceTabPreference } from '@/desktop/appPreferences'
import { INTERACTIONS_PATH } from '@/features/notifications/RuntimeInteractionsContext'
import {
  COLLABORATION_EXP_PATH,
  COLLABORATION_EXP_TAB_ID,
  isCollaborationExpPath,
} from '@/features/collaboration-exp/collaborationExpFeature'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsRow } from './settings-ui'

interface GeneralFixedWorkspaceTabsProps {
  fixedWorkspaceTabs: FixedWorkspaceTabPreference[]
  startupWorkspaceTabId: string
  collaborationExperienceEnabled: boolean
  experimentalFeaturesEnabled: boolean
  installedSmartApps: HarnessAppInstallation[]
  disabled: boolean
  onSave: (tabs: FixedWorkspaceTabPreference[], startupWorkspaceTabId?: string) => Promise<void>
}

const BUILT_IN_FIXED_TAB_OPTIONS = ['task', 'board', 'agent'] as const

function moveFixedTab(
  tabs: FixedWorkspaceTabPreference[],
  sourceIndex: number,
  targetIndex: number
): FixedWorkspaceTabPreference[] {
  const next = [...tabs]
  const source = next[sourceIndex]
  next[sourceIndex] = next[targetIndex]
  next[targetIndex] = source
  return next
}

export function GeneralFixedWorkspaceTabs({
  fixedWorkspaceTabs,
  startupWorkspaceTabId,
  collaborationExperienceEnabled,
  experimentalFeaturesEnabled,
  installedSmartApps,
  disabled,
  onSave,
}: GeneralFixedWorkspaceTabsProps) {
  const { t } = useTranslation('common')
  const visibleFixedWorkspaceTabs = fixedWorkspaceTabs.filter(
    tab => collaborationExperienceEnabled || !isCollaborationExpPath(tab.contentRoute ?? '')
  )

  return (
    <SettingsRow
      label={t('workbench.general_settings_fixed_workspace_tabs', '固定标签页')}
      description={t(
        'workbench.general_settings_fixed_workspace_tabs_description',
        '每次启动时按顺序打开；通过加号创建的普通标签页不会在重启后恢复。'
      )}
      className="py-4"
      labelClassName="font-normal"
      control={
        <div className="w-full space-y-2 md:w-[360px]" data-testid="general-fixed-tabs">
          {visibleFixedWorkspaceTabs.map((tab, index) => {
            const label =
              tab.kind === 'smart_app'
                ? (tab.title ?? t('workbench.smart_apps_title', '智能工作台'))
                : tab.kind === 'auxiliary'
                  ? (tab.title ??
                    (tab.contentRoute === INTERACTIONS_PATH
                      ? t('interactions.title', '待你处理')
                      : isCollaborationExpPath(tab.contentRoute ?? '')
                        ? t('workbench.workspace_tab_collaboration_exp', '协作 exp')
                        : t('workbench.workspace_tab_auxiliary', '工作区')))
                  : (tab.title ?? t(`workbench.general_settings_default_workspace_tab_${tab.kind}`))
            return (
              <div
                key={tab.id}
                data-testid={`general-fixed-tab-${tab.id}`}
                className="flex min-h-11 items-center gap-1 rounded-lg border border-border bg-background px-2 md:h-9 md:min-h-0"
              >
                <button
                  type="button"
                  data-testid={`general-fixed-tab-startup-${tab.id}`}
                  disabled={disabled}
                  aria-pressed={startupWorkspaceTabId === tab.id}
                  aria-label={t(
                    'workbench.general_settings_startup_workspace_tab',
                    '设为启动标签页'
                  )}
                  onClick={() => void onSave(fixedWorkspaceTabs, tab.id)}
                  className="flex h-11 w-11 items-center justify-center rounded hover:bg-muted md:h-6 md:w-6"
                  title={t('workbench.general_settings_startup_workspace_tab', '设为启动标签页')}
                >
                  <Pin
                    className={
                      startupWorkspaceTabId === tab.id ? 'h-3.5 w-3.5 fill-current' : 'h-3.5 w-3.5'
                    }
                  />
                </button>
                <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                <button
                  type="button"
                  data-testid={`general-fixed-tab-up-${tab.id}`}
                  disabled={disabled || index === 0}
                  onClick={() => {
                    void onSave(
                      moveFixedTab(
                        fixedWorkspaceTabs,
                        fixedWorkspaceTabs.findIndex(item => item.id === tab.id),
                        fixedWorkspaceTabs.findIndex(
                          item => item.id === visibleFixedWorkspaceTabs[index - 1]?.id
                        )
                      )
                    )
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded hover:bg-muted disabled:opacity-30 md:h-6 md:w-6"
                  aria-label={t('workbench.move_up', '上移')}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-testid={`general-fixed-tab-down-${tab.id}`}
                  disabled={disabled || index === visibleFixedWorkspaceTabs.length - 1}
                  onClick={() => {
                    void onSave(
                      moveFixedTab(
                        fixedWorkspaceTabs,
                        fixedWorkspaceTabs.findIndex(item => item.id === tab.id),
                        fixedWorkspaceTabs.findIndex(
                          item => item.id === visibleFixedWorkspaceTabs[index + 1]?.id
                        )
                      )
                    )
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded hover:bg-muted disabled:opacity-30 md:h-6 md:w-6"
                  aria-label={t('workbench.move_down', '下移')}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-testid={`general-fixed-tab-remove-${tab.id}`}
                  disabled={disabled || visibleFixedWorkspaceTabs.length === 1}
                  onClick={() => void onSave(fixedWorkspaceTabs.filter(item => item.id !== tab.id))}
                  className="flex h-11 w-11 items-center justify-center rounded hover:bg-muted disabled:opacity-30 md:h-6 md:w-6"
                  aria-label={t('workbench.remove', '移除')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
          <select
            data-testid="general-fixed-tab-add"
            disabled={disabled}
            value=""
            onChange={event => {
              const value = event.target.value
              if (!value) return
              const builtIn = BUILT_IN_FIXED_TAB_OPTIONS.find(kind => kind === value)
              const smartApp = installedSmartApps.find(app => `smart_app:${app.id}` === value)
              const nextTab: FixedWorkspaceTabPreference | null = builtIn
                ? { id: `fixed-${builtIn}`, kind: builtIn }
                : value === COLLABORATION_EXP_TAB_ID && collaborationExperienceEnabled
                  ? {
                      id: COLLABORATION_EXP_TAB_ID,
                      kind: 'auxiliary',
                      contentRoute: COLLABORATION_EXP_PATH,
                    }
                  : smartApp
                    ? {
                        id: `fixed-smart-app-${smartApp.id}`,
                        kind: 'smart_app',
                        installationId: smartApp.id,
                        title: smartApp.manifest.displayName,
                      }
                    : null
              if (nextTab) {
                void onSave([...fixedWorkspaceTabs, nextTab])
              }
            }}
            className="h-11 w-full rounded-lg border border-dashed border-border bg-background px-2 text-sm text-text-secondary md:h-9"
          >
            <option value="">
              {t('workbench.general_settings_add_fixed_workspace_tab', '+ 添加固定标签页')}
            </option>
            {BUILT_IN_FIXED_TAB_OPTIONS.filter(
              kind => !fixedWorkspaceTabs.some(tab => tab.kind === kind)
            ).map(kind => (
              <option key={kind} value={kind}>
                {t(`workbench.general_settings_default_workspace_tab_${kind}`)}
              </option>
            ))}
            {collaborationExperienceEnabled &&
            !fixedWorkspaceTabs.some(tab => isCollaborationExpPath(tab.contentRoute ?? '')) ? (
              <option value={COLLABORATION_EXP_TAB_ID}>
                {t('workbench.workspace_tab_collaboration_exp', '协作 exp')}
              </option>
            ) : null}
            {(experimentalFeaturesEnabled ? installedSmartApps : [])
              .filter(
                app =>
                  !fixedWorkspaceTabs.some(
                    tab => tab.kind === 'smart_app' && tab.installationId === app.id
                  )
              )
              .map(app => (
                <option key={app.id} value={`smart_app:${app.id}`}>
                  {app.manifest.displayName}
                </option>
              ))}
          </select>
        </div>
      }
    />
  )
}
