import { Loader2, RefreshCw, Save, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useTranslation } from '@/hooks/useTranslation'
import {
  defaultLocalHarnessPreferences,
  formatLocalHarnessArgs,
  formatLocalHarnessEnv,
  localHarnessLabel,
  normalizeLocalHarnessPreferences,
  parseLocalHarnessArgs,
  parseLocalHarnessEnv,
  type ClaudeCodePermissionMode,
  type LocalHarnessId,
  type LocalHarnessPreference,
} from '@/lib/local-harness'
import { listLocalHarnesses, type LocalHarnessDescriptor } from '@/lib/local-terminal'
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
  modelsText: string
  argsText: string
  envText: string
}

function toDraft(preference: LocalHarnessPreference): HarnessDraft {
  return {
    preference,
    modelsText: formatLocalHarnessArgs(preference.models),
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
  const [status, setStatus] = useState<string | null>(null)

  if (draftSource !== storedPreferences) {
    setDraftSource(storedPreferences)
    setDrafts(buildDrafts(storedPreferences))
  }

  const overrides = useMemo(() => executableOverrides(drafts), [drafts])
  const storedOverrides = useMemo(
    () => executableOverrides(buildDrafts(storedPreferences)),
    [storedPreferences]
  )

  const refresh = async () => {
    setDetecting(true)
    setStatus(null)
    try {
      setDescriptors(await listLocalHarnesses(overrides))
    } catch (error) {
      console.error('Failed to detect local harnesses:', error)
      setDescriptors([])
      setStatus(t('workbench.harness_settings_detection_failed', '运行工具检测失败'))
    } finally {
      setDetecting(false)
    }
  }

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
          setStatus(t('workbench.harness_settings_detection_failed', '运行工具检测失败'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [storedOverrides, t])

  const updateDraft = (id: LocalHarnessId, updater: (draft: HarnessDraft) => HarnessDraft) => {
    setDrafts(current => ({ ...current, [id]: updater(current[id]) }))
    setStatus(null)
  }

  const save = async () => {
    const nextPreferences: LocalHarnessPreference[] = []
    for (const id of ['opencode', 'claude_code'] as const) {
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
        models: parseLocalHarnessArgs(draft.modelsText),
        args: parseLocalHarnessArgs(draft.argsText),
        env: parsedEnv.env,
      })
    }

    setSaving(true)
    setStatus(null)
    try {
      const preferences = await updateAppPreferences({ localHarnesses: nextPreferences })
      setDrafts(buildDrafts(preferences.localHarnesses))
      setStatus(t('workbench.harness_settings_saved', '运行工具设置已保存'))
    } catch (error) {
      console.error('Failed to save local harness settings:', error)
      setStatus(t('workbench.harness_settings_save_failed', '运行工具设置保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsPage data-testid="harness-settings-page">
      <SettingsPageHeader
        title={t('workbench.harness_settings_title', '运行工具')}
        description={t(
          'workbench.harness_settings_description',
          '配置 Wework 中可直接启动的本地编码工具。参数按行传递，不经过 shell 解析。'
        )}
        actions={
          <>
            <button
              type="button"
              data-testid="refresh-harness-settings"
              onClick={() => void refresh()}
              disabled={detecting || saving}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${detecting ? 'animate-spin' : ''}`} />
              {t('common.refresh', '刷新')}
            </button>
            <button
              type="button"
              data-testid="save-harness-settings"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t('common.save', '保存')}
            </button>
          </>
        }
      />

      <div className="space-y-5">
        {(['opencode', 'claude_code'] as const).map(id => {
          const draft = drafts[id]
          const descriptor = descriptors.find(item => item.id === id)
          const label = localHarnessLabel(id)
          return (
            <section key={id} data-testid={`harness-settings-${id}`}>
              <div className="mb-2 flex items-center gap-2">
                <SquareTerminal className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                <h2 className="text-sm font-medium text-text-primary">{label}</h2>
                <span className="text-xs text-text-muted">
                  {detecting
                    ? t('workbench.harness_status_detecting', '检测中')
                    : descriptor?.installed
                      ? descriptor.version || t('workbench.harness_status_installed', '已安装')
                      : t('workbench.harness_status_not_installed', '未检测到')}
                </span>
              </div>
              <SettingsGroup>
                <SettingsRow
                  label={t('workbench.harness_enabled', '启用')}
                  description={t(
                    'workbench.harness_enabled_description',
                    '在新对话的运行工具选择器中显示此工具。'
                  )}
                  control={
                    <SettingsSwitch
                      data-testid={`harness-enabled-${id}`}
                      checked={draft.preference.enabled}
                      onCheckedChange={enabled =>
                        updateDraft(id, current => ({
                          ...current,
                          preference: { ...current.preference, enabled },
                        }))
                      }
                    />
                  }
                />
                <SettingsRow
                  label={t('workbench.harness_executable_path', '可执行文件')}
                  description={
                    descriptor?.executable_path ||
                    t(
                      'workbench.harness_executable_path_description',
                      '留空时从 PATH 和工具默认安装目录中检测。'
                    )
                  }
                  control={
                    <input
                      data-testid={`harness-executable-${id}`}
                      value={draft.preference.executablePath ?? ''}
                      onChange={event =>
                        updateDraft(id, current => ({
                          ...current,
                          preference: {
                            ...current.preference,
                            executablePath: event.target.value,
                          },
                        }))
                      }
                      placeholder={id === 'claude_code' ? 'claude' : 'opencode'}
                      className="h-8 w-72 rounded-lg border border-border bg-background px-2.5 text-sm text-text-primary outline-none focus:border-focus max-sm:w-full"
                    />
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
                  label={t('workbench.harness_models', '模型')}
                  description={t(
                    'workbench.harness_models_description',
                    '每行一个模型 ID；启动新会话时可在输入框中选择。'
                  )}
                  className="items-start"
                  control={
                    <textarea
                      data-testid={`harness-models-${id}`}
                      value={draft.modelsText}
                      onChange={event =>
                        updateDraft(id, current => ({ ...current, modelsText: event.target.value }))
                      }
                      rows={3}
                      placeholder={
                        id === 'claude_code'
                          ? 'sonnet\nopus'
                          : 'openai/gpt-5.2\nanthropic/claude-sonnet-4-6'
                      }
                      className="w-72 resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-code text-text-primary outline-none focus:border-focus max-sm:w-full"
                    />
                  }
                />
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
