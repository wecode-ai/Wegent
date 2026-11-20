import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useTranslation } from '@/hooks/useTranslation'
import {
  defaultLocalHarnessPreferences,
  LOCAL_HARNESS_IDS,
  localHarnessLabel,
  type ClaudeCodePermissionMode,
  type LocalHarnessId,
} from '@/lib/local-harness'
import { listLocalHarnesses, type LocalHarnessDescriptor } from '@/lib/local-terminal'
import { openNativeExecutablePicker } from '@/lib/native-executable-picker'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ChevronDown, FolderOpen, RotateCcw, SquareTerminal } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createHarnessSettingsEditor } from './harnessSettingsEditor'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

export function HarnessSettingsPage() {
  const { t } = useTranslation('common')
  const preferencesState = useAppPreferencesState()
  const storedPreferences =
    preferencesState?.preferences.localHarnesses ?? defaultLocalHarnessPreferences
  const [editor] = useState(() => createHarnessSettingsEditor(storedPreferences))
  const subscribe = useCallback(
    (listener: () => void) => editor.subscribe(listener, storedPreferences),
    [editor, storedPreferences]
  )
  const state = useSyncExternalStore(subscribe, editor.getSnapshot)
  const { drafts } = state
  const updateDraft = editor.updateDraft
  const [expandedId, setExpandedId] = useState<LocalHarnessId | null>(null)
  const status =
    state.status.kind === 'saving'
      ? t('workbench.harness_settings_saving')
      : state.status.kind === 'saved'
        ? t('workbench.harness_settings_saved')
        : state.status.kind === 'failed'
          ? t('workbench.harness_settings_save_failed')
          : state.status.kind === 'invalid'
            ? t('workbench.harness_settings_env_invalid', {
                name: localHarnessLabel(state.status.id),
                line: state.status.line,
              })
            : null

  const overrides = useMemo(
    () => ({
      opencode: drafts.opencode.preference.executablePath,
      claude_code: drafts.claude_code.preference.executablePath,
      kimi_code: drafts.kimi_code.preference.executablePath,
    }),
    [
      drafts.opencode.preference.executablePath,
      drafts.claude_code.preference.executablePath,
      drafts.kimi_code.preference.executablePath,
    ]
  )
  const detection = useMemo(
    () =>
      createAsyncResource('settings/local-harness-detection', () => listLocalHarnesses(overrides)),
    [overrides]
  )
  const detected = useSyncExternalStore(detection.subscribe, detection.getSnapshot)
  const descriptors = detected.data ?? []
  const detecting = !detected.settled || detected.status === 'loading'
  const applyExecutablePath = (id: LocalHarnessId, executablePath: string | null) => {
    updateDraft(id, current => ({
      ...current,
      preference: { ...current.preference, executablePath },
    }))
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
      applyExecutablePath(id, selected)
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
                <ControlButton
                  variant="unstyled"
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
                        : detected.status === 'error'
                          ? t('workbench.harness_settings_detection_failed')
                          : descriptor?.installed
                            ? descriptor.version ||
                              t('workbench.harness_status_installed', '已安装')
                            : t('workbench.harness_status_not_installed', '未检测到')}
                    </span>
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-text-secondary transition-transform ${
                      expanded ? 'rotate-180' : ''
                    }`}
                    aria-hidden="true"
                  />
                </ControlButton>
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
                    children={
                      <div className="flex w-72 min-w-0 items-center gap-1.5 max-sm:w-full">
                        <span
                          data-testid={`harness-executable-path-${id}`}
                          title={resolvedExecutable}
                          className="min-w-0 flex-1 truncate text-right text-code text-text-secondary"
                        >
                          {resolvedExecutable}
                        </span>
                        <ControlButton
                          variant="outline"
                          size="sm"
                          type="button"
                          data-testid={`harness-executable-select-${id}`}
                          onClick={() => void selectExecutable(id, label, descriptor)}
                          className="shrink-0"
                        >
                          <FolderOpen className="h-4 w-4" aria-hidden="true" />
                          {t('workbench.harness_executable_select', '选择…')}
                        </ControlButton>
                        {draft.preference.executablePath ? (
                          <ControlButton
                            variant="unstyled"
                            type="button"
                            data-testid={`harness-executable-reset-${id}`}
                            aria-label={t('workbench.harness_executable_reset', '恢复自动检测')}
                            title={t('workbench.harness_executable_reset', '恢复自动检测')}
                            onClick={() => void applyExecutablePath(id, null)}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
                          >
                            <RotateCcw className="h-4 w-4" aria-hidden="true" />
                          </ControlButton>
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
                      children={
                        <SelectRoot
                          value={normalizeSelectValue(draft.preference.permissionMode)}
                          onValueChange={selectedValue => {
                            if (selectedValue !== null)
                              return updateDraft(id, current => ({
                                ...current,
                                preference: {
                                  ...current.preference,
                                  permissionMode: selectedValue as ClaudeCodePermissionMode,
                                },
                              }))
                          }}
                        >
                          <SelectTrigger
                            aria-label={t('workbench.harness_permission_mode')}
                            data-testid="harness-permission-mode-claude_code"
                          />
                          <SelectContent>
                            <SelectItem value="default">
                              {t('workbench.harness_permission_default', '默认')}
                            </SelectItem>
                            <SelectItem value="acceptEdits">
                              {t('workbench.harness_permission_accept_edits', '自动接受编辑')}
                            </SelectItem>
                            <SelectItem value="plan">
                              {t('workbench.harness_permission_plan', '计划模式')}
                            </SelectItem>
                            <SelectItem value="auto">
                              {t('workbench.harness_permission_auto', '自动模式')}
                            </SelectItem>
                            <SelectItem value="bypass">
                              {t('workbench.harness_permission_bypass', '跳过权限确认（危险）')}
                            </SelectItem>
                          </SelectContent>
                        </SelectRoot>
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
                    children={
                      <ControlTextarea
                        data-testid={`harness-args-${id}`}
                        value={draft.argsText}
                        onChange={event =>
                          updateDraft(id, current => ({ ...current, argsText: event.target.value }))
                        }
                        rows={3}
                        className="w-72 resize-y text-code max-sm:w-full"
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
                    children={
                      <ControlTextarea
                        data-testid={`harness-env-${id}`}
                        value={draft.envText}
                        onChange={event =>
                          updateDraft(id, current => ({ ...current, envText: event.target.value }))
                        }
                        rows={3}
                        className="w-72 resize-y text-code max-sm:w-full"
                      />
                    }
                  />
                </SettingsGroup>
              ) : null}
            </section>
          )
        })}
      </div>

      {detected.status === 'error' && (
        <div
          data-testid="harness-settings-detection-error"
          className="mt-4 text-sm text-text-secondary"
        >
          <p>{t('workbench.harness_settings_detection_failed')}</p>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="harness-settings-retry-detection"
            onClick={() => void detection.reload()}
            className="mt-2 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-8"
          >
            {t('common.retry')}
          </ControlButton>
        </div>
      )}
      {state.status.kind === 'failed' && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="harness-settings-retry-save"
          onClick={editor.retry}
          className="mt-4 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-8"
        >
          {t('common.retry')}
        </ControlButton>
      )}
      {status ? (
        <p data-testid="harness-settings-status" className="mt-4 text-sm text-text-secondary">
          {status}
        </p>
      ) : null}
    </SettingsPage>
  )
}
