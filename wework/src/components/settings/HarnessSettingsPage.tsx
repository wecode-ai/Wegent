import { ChevronDown, FolderOpen, RotateCcw, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useTranslation } from '@/hooks/useTranslation'
import {
  defaultLocalHarnessPreferences,
  formatLocalHarnessArgs,
  formatLocalHarnessEnv,
  localHarnessLabel,
  normalizeLocalHarnessPreferences,
  parseLocalHarnessArgs,
  parseLocalHarnessEnv,
  LOCAL_HARNESS_IDS,
  type ClaudeCodePermissionMode,
  type LocalHarnessId,
  type LocalHarnessPreference,
} from '@/lib/local-harness'
import { listLocalHarnesses, type LocalHarnessDescriptor } from '@/lib/local-terminal'
import { openNativeExecutablePicker } from '@/lib/native-executable-picker'
import { updateAppPreferences } from '@/tauri/appPreferences'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

interface HarnessDraft {
  preference: LocalHarnessPreference
  argsText: string
  envText: string
}

function toDraft(preference: LocalHarnessPreference): HarnessDraft {
  return {
    preference,
    argsText: formatLocalHarnessArgs(preference.args),
    envText: formatLocalHarnessEnv(preference.env),
  }
}

function buildDrafts(preferences: LocalHarnessPreference[]): Record<LocalHarnessId, HarnessDraft> {
  return Object.fromEntries(
    normalizeLocalHarnessPreferences(preferences).map(preference => [
      preference.id,
      toDraft(preference),
    ])
  ) as Record<LocalHarnessId, HarnessDraft>
}

function executableOverrides(drafts: Record<LocalHarnessId, HarnessDraft>) {
  return Object.fromEntries(
    Object.values(drafts).map(({ preference }) => [preference.id, preference.executablePath])
  ) as Partial<Record<LocalHarnessId, string | null>>
}

export function HarnessSettingsPage() {
  const { t } = useTranslation('common')
  const preferencesState = useAppPreferencesState()
  const storedPreferences =
    preferencesState?.preferences.localHarnesses ?? defaultLocalHarnessPreferences
  const [drafts, setDrafts] = useState(() => buildDrafts(storedPreferences))
  const [draftSource, setDraftSource] = useState(storedPreferences)
  const [descriptors, setDescriptors] = useState<LocalHarnessDescriptor[]>([])
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<LocalHarnessId | null>(null)
  const draftRevisionRef = useRef(0)

  if (!dirty && draftSource !== storedPreferences) {
    setDraftSource(storedPreferences)
    setDrafts(buildDrafts(storedPreferences))
  }

  const overrides = useMemo(() => executableOverrides(drafts), [drafts])
  const storedOverrides = useMemo(
    () => executableOverrides(buildDrafts(storedPreferences)),
    [storedPreferences]
  )

  useEffect(() => {
    let cancelled = false
    void listLocalHarnesses(storedOverrides)
      .then(harnesses => {
        if (!cancelled) {
          setDescriptors(harnesses)
        }
      })
      .catch(error => {
        console.error('Failed to detect local harnesses:', error)
        if (!cancelled) {
          setDescriptors([])
          setStatus(t('workbench.harness_settings_detection_failed', '编码工具检测失败'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [storedOverrides, t])

  const updateDraft = (id: LocalHarnessId, updater: (draft: HarnessDraft) => HarnessDraft) => {
    setDrafts(current => ({ ...current, [id]: updater(current[id]) }))
    draftRevisionRef.current += 1
    setDirty(true)
    setStatus(null)
  }

  useEffect(() => {
    if (!dirty || saving) return

    const timeout = window.setTimeout(() => {
      const revision = draftRevisionRef.current
      const nextPreferences: LocalHarnessPreference[] = []
      for (const id of LOCAL_HARNESS_IDS) {
        const draft = drafts[id]
        const parsedEnv = parseLocalHarnessEnv(draft.envText)
        if (parsedEnv.error) {
          setStatus(
            t('workbench.harness_settings_env_invalid', {
              name: localHarnessLabel(id),
              line: parsedEnv.error.split(':')[1],
              defaultValue: `${localHarnessLabel(id)} 的环境变量第 ${
                parsedEnv.error.split(':')[1]
              } 行无效`,
            })
          )
          return
        }
        nextPreferences.push({
          ...draft.preference,
          executablePath: draft.preference.executablePath?.trim() || null,
          args: parseLocalHarnessArgs(draft.argsText),
          env: parsedEnv.env,
        })
      }

      setSaving(true)
      setStatus(t('workbench.harness_settings_saving', '正在保存…'))
      void updateAppPreferences({ localHarnesses: nextPreferences })
        .then(preferences => {
          if (draftRevisionRef.current === revision) {
            setDraftSource(preferences.localHarnesses)
            setDrafts(buildDrafts(preferences.localHarnesses))
            setDirty(false)
            setStatus(t('workbench.harness_settings_saved', '编码工具设置已自动保存'))
          }
        })
        .catch(error => {
          console.error('Failed to save local harness settings:', error)
          setStatus(t('workbench.harness_settings_save_failed', '编码工具设置保存失败'))
        })
        .finally(() => setSaving(false))
    }, 400)

    return () => window.clearTimeout(timeout)
  }, [dirty, drafts, saving, t])

  const applyExecutablePath = async (id: LocalHarnessId, executablePath: string | null) => {
    updateDraft(id, current => ({
      ...current,
      preference: { ...current.preference, executablePath },
    }))
    setDetecting(true)
    try {
      setDescriptors(await listLocalHarnesses({ ...overrides, [id]: executablePath }))
    } catch (error) {
      console.error('Failed to detect local harnesses:', error)
      setStatus(t('workbench.harness_settings_detection_failed', '编码工具检测失败'))
    } finally {
      setDetecting(false)
    }
  }

  const selectExecutable = async (
    id: LocalHarnessId,
    label: string,
    descriptor?: LocalHarnessDescriptor
  ) => {
    const selected = await openNativeExecutablePicker(
      drafts[id].preference.executablePath || descriptor?.executable_path || undefined,
      t('workbench.harness_executable_picker_title', {
        name: label,
        defaultValue: `选择 ${label} 可执行文件`,
      })
    )
    if (selected) {
      await applyExecutablePath(id, selected)
    }
  }

  return (
    <SettingsPage data-testid="harness-settings-page">
      <SettingsPageHeader
        title={
          <span className="flex items-center gap-2">
            {t('workbench.harness_settings_title', '编码工具')}
            <ExperimentalBadge testId="harness-settings-experimental-badge" />
          </span>
        }
        description={t(
          'workbench.harness_settings_description',
          '配置 Wework 中可直接启动的本地编码工具。默认使用工具自己的模型配置；也可以显式选择 Wework 模型，通过本地 Messages 路由使用代理与云端模型能力。'
        )}
      />

      <div className="space-y-3">
        {LOCAL_HARNESS_IDS.map(id => {
          const draft = drafts[id]
          const descriptor = descriptors.find(item => item.id === id)
          const label = localHarnessLabel(id)
          const expanded = expandedId === id
          const resolvedExecutable =
            draft.preference.executablePath ||
            descriptor?.executable_path ||
            t('workbench.harness_executable_auto', '自动检测')
          return (
            <section
              key={id}
              data-testid={`harness-settings-${id}`}
              className="overflow-hidden rounded-2xl border border-border bg-surface/70"
            >
              <div className={`flex items-center ${expanded ? 'border-b border-border' : ''}`}>
                <button
                  type="button"
                  data-testid={`harness-settings-toggle-${id}`}
                  aria-expanded={expanded}
                  aria-controls={`harness-settings-panel-${id}`}
                  onClick={() => setExpandedId(current => (current === id ? null : id))}
                  className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
                >
                  <SquareTerminal
                    className="h-4 w-4 shrink-0 text-text-secondary"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text-primary">
                        {label}
                      </span>
                      <ExperimentalBadge testId={`harness-settings-${id}-experimental-badge`} />
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-text-muted">
                      {detecting
                        ? t('workbench.harness_status_detecting', '检测中')
                        : descriptor?.installed
                          ? descriptor.version || t('workbench.harness_status_installed', '已安装')
                          : t('workbench.harness_status_not_installed', '未检测到')}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-text-secondary transition-transform ${
                      expanded ? 'rotate-180' : ''
                    }`}
                    aria-hidden="true"
                  />
                </button>
                <div className="flex min-h-14 shrink-0 items-center px-4">
                  <SettingsSwitch
                    data-testid={`harness-enabled-${id}`}
                    aria-label={t('workbench.harness_enabled_tool', {
                      name: label,
                      defaultValue: `启用 ${label}`,
                    })}
                    checked={draft.preference.enabled}
                    onCheckedChange={enabled =>
                      updateDraft(id, current => ({
                        ...current,
                        preference: { ...current.preference, enabled },
                      }))
                    }
                  />
                </div>
              </div>
              {expanded ? (
                <SettingsGroup
                  id={`harness-settings-panel-${id}`}
                  data-testid={`harness-settings-panel-${id}`}
                  className="rounded-none border-0 bg-transparent"
                >
                  <SettingsRow
                    label={t('workbench.harness_executable_path', '可执行文件')}
                    description={t(
                      'workbench.harness_executable_path_description',
                      '选择可执行文件路径；未指定时从 PATH 和工具默认安装目录中检测。'
                    )}
                    control={
                      <div className="flex w-72 min-w-0 items-center gap-1.5 max-sm:w-full">
                        <span
                          data-testid={`harness-executable-path-${id}`}
                          title={resolvedExecutable}
                          className="min-w-0 flex-1 truncate text-right text-code text-text-secondary"
                        >
                          {resolvedExecutable}
                        </span>
                        <button
                          type="button"
                          data-testid={`harness-executable-select-${id}`}
                          onClick={() => void selectExecutable(id, label, descriptor)}
                          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm text-text-primary hover:bg-muted"
                        >
                          <FolderOpen className="h-4 w-4" aria-hidden="true" />
                          {t('workbench.harness_executable_select', '选择…')}
                        </button>
                        {draft.preference.executablePath ? (
                          <button
                            type="button"
                            data-testid={`harness-executable-reset-${id}`}
                            aria-label={t('workbench.harness_executable_reset', '恢复自动检测')}
                            title={t('workbench.harness_executable_reset', '恢复自动检测')}
                            onClick={() => void applyExecutablePath(id, null)}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
                          >
                            <RotateCcw className="h-4 w-4" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    }
                  />
                  {id === 'claude_code' ? (
                    <SettingsRow
                      label={t('workbench.harness_permission_mode', '权限模式')}
                      description={t(
                        'workbench.harness_permission_mode_description',
                        '启动 Claude Code 时应用；危险绕过模式会跳过权限确认。'
                      )}
                      control={
                        <select
                          data-testid="harness-permission-mode-claude_code"
                          value={draft.preference.permissionMode}
                          onChange={event =>
                            updateDraft(id, current => ({
                              ...current,
                              preference: {
                                ...current.preference,
                                permissionMode: event.target.value as ClaudeCodePermissionMode,
                              },
                            }))
                          }
                          className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm text-text-primary outline-none focus:border-focus"
                        >
                          <option value="default">
                            {t('workbench.harness_permission_default', '默认')}
                          </option>
                          <option value="plan">
                            {t('workbench.harness_permission_plan', '计划模式')}
                          </option>
                          <option value="bypass">
                            {t('workbench.harness_permission_bypass', '跳过权限确认（危险）')}
                          </option>
                        </select>
                      }
                    />
                  ) : null}
                  <SettingsRow
                    label={t('workbench.harness_default_args', '默认参数')}
                    description={t(
                      'workbench.harness_default_args_description',
                      '每行一个参数，任务提示词会由 Wework 按工具协议追加。'
                    )}
                    className="items-start"
                    control={
                      <textarea
                        data-testid={`harness-args-${id}`}
                        value={draft.argsText}
                        onChange={event =>
                          updateDraft(id, current => ({ ...current, argsText: event.target.value }))
                        }
                        rows={3}
                        className="w-72 resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-code text-text-primary outline-none focus:border-focus max-sm:w-full"
                      />
                    }
                  />
                  <SettingsRow
                    label={t('workbench.harness_environment', '环境变量')}
                    description={t(
                      'workbench.harness_environment_description',
                      '每行一个 NAME=VALUE；内容只保存在当前设备。'
                    )}
                    className="items-start"
                    control={
                      <textarea
                        data-testid={`harness-env-${id}`}
                        value={draft.envText}
                        onChange={event =>
                          updateDraft(id, current => ({ ...current, envText: event.target.value }))
                        }
                        rows={3}
                        className="w-72 resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-code text-text-primary outline-none focus:border-focus max-sm:w-full"
                      />
                    }
                  />
                </SettingsGroup>
              ) : null}
            </section>
          )
        })}
      </div>

      {status ? (
        <p data-testid="harness-settings-status" className="mt-4 text-sm text-text-secondary">
          {status}
        </p>
      ) : null}
    </SettingsPage>
  )
}
