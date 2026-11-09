import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  CirclePause,
  CirclePlay,
  Info,
  Loader2,
  MoreHorizontal,
  Play,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { isCurrentAppDevice } from '@/lib/app-device-registration'
import {
  canUseForProjectCreation,
  isCloudDevice,
  isDeviceBelowWeWorkVersion,
  isRemoteDevice,
  WEWORK_MIN_EXECUTOR_VERSION,
} from '@/lib/device-capabilities'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import {
  MenuSelect,
  PopupMenu,
  TimeMenu,
  WeekdayMenu,
  type MenuOption,
} from '@/components/common/MenuSelect'
import { SectionTitle, SettingsGroup, SettingsRow } from '@/components/common/SettingsGroup'
import type {
  DeviceInfo,
  RuntimeProjectWork,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'
import type {
  Automation,
  AutomationConversationMode,
  AutomationRun,
  AutomationSource,
} from '@/types/automation'
import {
  buildAutomationProjectOptions,
  buildAutomationTaskOptions,
  automationTaskKey,
  type AutomationDraft,
  type CronPreset,
  type CustomFrequency,
} from './automationDraft'

interface AutomationDetailWorkspaceProps {
  draft: AutomationDraft
  inheritStandIn?: boolean
  calendarMode?: boolean
  compact?: boolean
  dialogMode?: boolean
  automation: Automation | null
  runs: AutomationRun[]
  locale: string
  devices: DeviceInfo[]
  projects: RuntimeProjectWork[]
  models: UnifiedModel[]
  currentRuntimeTask: RuntimeTaskAddress | null
  runtimeWork: RuntimeWorkListResponse | null
  localDeviceIds: string[]
  cloudAvailable: boolean
  saving: boolean
  dirty: boolean
  running: boolean
  onChange: <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => void
  onModelChange: (model: UnifiedModel | null) => void
  onSourceChange: (source: AutomationSource) => void
  onClose: () => void
  onSave: () => void
  onRun: () => void
  onToggle: () => void
  onDelete: () => void
  onOpenRun?: (run: AutomationRun) => void
  validationError?: string | null
}

export function AutomationDetailWorkspace({
  draft,
  inheritStandIn = false,
  calendarMode = false,
  compact = false,
  dialogMode = false,
  automation,
  runs,
  locale,
  devices,
  projects,
  models,
  currentRuntimeTask,
  runtimeWork,
  localDeviceIds,
  cloudAvailable,
  saving,
  dirty,
  running,
  onChange,
  onModelChange,
  onSourceChange,
  onClose,
  onSave,
  onRun,
  onToggle,
  onDelete,
  onOpenRun,
  validationError,
}: AutomationDetailWorkspaceProps) {
  const { t } = useTranslation('common')
  const [actionsOpen, setActionsOpen] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!validationError) return
    if (!draft.name.trim()) nameRef.current?.focus()
    else if (!draft.prompt.trim()) promptRef.current?.focus()
  }, [validationError, draft.name, draft.prompt])
  const localDeviceIdSet = new Set(localDeviceIds)
  const taskOptions: AutomationTaskMenuOption[] = buildAutomationTaskOptions(runtimeWork).map(
    option => {
      const device = findWorkbenchDevice(devices, option.address.deviceId)
      return {
        ...option,
        label: `${option.label} · ${
          device
            ? deviceOptionLabel(device, localDeviceIds, t)
            : t('workbench.environment_device_unknown', '未知设备')
        }`,
        disabled: !device || !canUseForProjectCreation(device),
      }
    }
  )
  const sourceDevices = devices.filter(device =>
    draft.source === 'cloud'
      ? isCloudDevice(device) || isRemoteDevice(device)
      : !isCloudDevice(device) && !isRemoteDevice(device)
  )
  const reasoning = draft.modelOptions.reasoningEffort ?? 'medium'
  const selectedModel = models.find(
    model =>
      model.type === draft.modelType &&
      (model.name === draft.modelId || (model.modelId ?? model.name) === draft.modelId)
  )
  const projectOptions = buildAutomationProjectOptions(projects, draft.deviceId)
  const selectedProject =
    projectOptions.find(option => option.workspacePath === draft.workspacePath) ?? null
  const projectOptionLabel = (option: (typeof projectOptions)[number]) => {
    if (option.workspaceKind !== 'worktree') return option.name
    const worktreeLabel = t('workbench.project_workspace_kind_worktree', 'Worktree')
    return option.workspaceLabel && option.workspaceLabel !== option.name
      ? `${option.name} · ${worktreeLabel} · ${option.workspaceLabel}`
      : `${option.name} · ${worktreeLabel}`
  }

  return (
    <section
      data-testid="automation-detail-panel"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <header
        className={`flex shrink-0 items-start justify-between gap-3 ${compact ? 'pb-3' : 'min-h-16 px-6 pt-4'}`}
      >
        <div className="min-w-0 flex-1">
          <span
            className={`block text-sm font-medium ${compact ? 'text-text-secondary' : 'text-blue-500'}`}
          >
            {automation
              ? automation.enabled
                ? t('todo.automation_status_active', '活跃')
                : t('todo.automation_status_paused', '已暂停')
              : t('todo.automation_status_new', '新建')}
          </span>
          <input
            ref={nameRef}
            aria-label={t('todo.automation_name', '名称')}
            aria-invalid={Boolean(validationError && !draft.name.trim())}
            data-testid="automation-name-input"
            value={draft.name}
            onChange={event => onChange('name', event.target.value)}
            className={
              compact
                ? 'mt-2 min-h-9 w-full rounded-lg border border-solid border-border bg-background px-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary'
                : 'mt-2 w-full border-0 bg-transparent p-0 text-heading-md font-medium tracking-[-0.02em] text-text-primary outline-none placeholder:text-text-tertiary'
            }
            placeholder={t('todo.automation_name', '名称')}
            autoFocus={!automation}
          />
        </div>
        {!dialogMode && (
          <div className="relative flex shrink-0 items-center gap-1">
            {automation ? (
              <>
                <button
                  type="button"
                  data-testid={`automation-detail-actions-${automation.id}`}
                  onClick={() => setActionsOpen(open => !open)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface"
                  aria-label={t('todo.automation_actions', '自动化操作')}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  data-testid={`automation-detail-toggle-${automation.id}`}
                  onClick={onToggle}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface"
                  aria-label={
                    automation.enabled
                      ? t('todo.automation_pause', '暂停')
                      : t('todo.automation_resume', '恢复')
                  }
                >
                  {automation.enabled ? (
                    <CirclePause className="h-4 w-4" />
                  ) : (
                    <CirclePlay className="h-4 w-4" />
                  )}
                </button>
                {actionsOpen ? (
                  <div className="absolute right-16 top-9 z-popover w-36 rounded-xl border border-border bg-background p-1 shadow-lg">
                    <button
                      type="button"
                      data-testid="automation-run-now-button"
                      onClick={() => {
                        setActionsOpen(false)
                        onRun()
                      }}
                      disabled={running}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface disabled:opacity-50"
                    >
                      {running ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                      {t('todo.automation_run_now', '立即运行')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActionsOpen(false)
                        onDelete()
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm text-red-600 hover:bg-red-500/5"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('workbench.delete', '删除')}
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              data-testid="automation-detail-close"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface"
              aria-label={t('workbench.close', '关闭')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </header>

      <div className={`min-h-0 flex-1 overflow-y-auto ${compact ? 'pb-4' : 'px-6 pb-28 pt-3'}`}>
        <textarea
          ref={promptRef}
          aria-label={t(
            calendarMode ? 'standIn.workspace.calendar_event' : 'todo.automation_prompt',
            '任务说明'
          )}
          aria-invalid={Boolean(validationError && !draft.prompt.trim())}
          data-testid="automation-prompt-input"
          value={draft.prompt}
          onChange={event => onChange('prompt', event.target.value)}
          className={`min-h-24 w-full resize-y appearance-none border border-solid border-border bg-background px-3 py-3 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary ${compact ? 'rounded-lg' : 'rounded-2xl'}`}
          placeholder={t(
            calendarMode ? 'standIn.workspace.calendar_event' : 'todo.automation_prompt',
            '任务说明'
          )}
        />

        {validationError && (
          <p role="alert" data-testid="automation-draft-error" className="mt-2 text-sm text-error">
            {validationError}
          </p>
        )}

        {!calendarMode && (
          <>
            <SectionTitle
              title={t('todo.automation_details', '详情')}
              action={<Info className="h-4 w-4" />}
            />
            <SettingsGroup>
              <SettingsRow
                label={t('todo.automation_goal_mode', '持续完成目标')}
                description={t(
                  'todo.automation_goal_description',
                  '将任务说明作为目标持续推进，直到目标完成'
                )}
              >
                <SettingsSwitch
                  data-testid="automation-goal-switch"
                  checked={draft.goalEnabled}
                  onCheckedChange={checked => onChange('goalEnabled', checked)}
                  aria-label={t('todo.automation_goal_mode', '持续完成目标')}
                />
              </SettingsRow>
              <SettingsRow label={t('todo.automation_run_in', '运行于')}>
                <InlineSelect
                  dataTestId="automation-conversation-mode"
                  value={draft.conversationMode}
                  onChange={value => {
                    const mode = value as AutomationConversationMode
                    onChange('conversationMode', mode)
                    if (mode === 'continue_thread' && !draft.continuationAddress) {
                      const currentKey = automationTaskKey(currentRuntimeTask)
                      const target =
                        taskOptions.find(option => option.key === currentKey && !option.disabled) ??
                        taskOptions.find(option => !option.disabled) ??
                        null
                      onChange('continuationAddress', target?.address ?? null)
                      if (target) {
                        onChange(
                          'source',
                          localDeviceIdSet.has(target.address.deviceId) ? 'local' : 'cloud'
                        )
                        onChange('deviceId', target.address.deviceId)
                        onChange('workspacePath', target.address.workspacePath ?? '')
                      }
                    }
                  }}
                  options={[
                    {
                      value: 'independent',
                      label: t('todo.automation_new_task', '新任务'),
                    },
                    {
                      value: 'continue_thread',
                      label: t('todo.automation_continue_conversation', '现有任务'),
                    },
                  ]}
                />
              </SettingsRow>
              {draft.conversationMode === 'continue_thread' ? (
                <SettingsRow label={t('workbench.task', '任务')}>
                  <AutomationTaskSelect
                    value={automationTaskKey(draft.continuationAddress)}
                    onChange={value => {
                      const target = taskOptions.find(
                        option => option.key === value && !option.disabled
                      )
                      onChange('continuationAddress', target?.address ?? null)
                      if (target) {
                        onChange(
                          'source',
                          localDeviceIdSet.has(target.address.deviceId) ? 'local' : 'cloud'
                        )
                        onChange('deviceId', target.address.deviceId)
                        onChange('workspacePath', target.address.workspacePath ?? '')
                      }
                    }}
                    options={taskOptions}
                  />
                </SettingsRow>
              ) : inheritStandIn ? (
                <p className="px-3 py-2 text-xs text-text-muted">
                  {t('standIn.workspace.schedule_inherits_settings')}
                </p>
              ) : (
                <>
                  <SettingsRow label={t('todo.automation_location', '运行位置')}>
                    <InlineSelect
                      dataTestId="automation-source-select"
                      value={draft.source}
                      disabled={Boolean(automation)}
                      onChange={value => onSourceChange(value as AutomationSource)}
                      options={[
                        { value: 'local', label: t('todo.automation_local', '本地') },
                        {
                          value: 'cloud',
                          label: t('todo.automation_cloud', '云端'),
                          disabled: !cloudAvailable,
                        },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('workbench.device', '设备')}>
                    <InlineSelect
                      dataTestId="automation-device-select"
                      value={draft.deviceId}
                      onChange={value => {
                        onChange('deviceId', value)
                        onChange(
                          'workspacePath',
                          currentRuntimeTask?.deviceId === value
                            ? (currentRuntimeTask.workspacePath ?? '')
                            : ''
                        )
                        if (currentRuntimeTask?.deviceId !== value) {
                          onChange('conversationMode', 'independent')
                        }
                      }}
                      options={[
                        {
                          value: '',
                          label: t('todo.automation_select_device', '选择设备'),
                        },
                        ...sourceDevices.map(device => ({
                          value: device.device_id,
                          label: deviceOptionLabel(device, localDeviceIds, t),
                          disabled: !canUseForProjectCreation(device),
                        })),
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('workbench.project', '项目')}>
                    <InlineSelect
                      dataTestId="automation-project-select"
                      value={selectedProject?.key ?? ''}
                      onChange={value => {
                        const project = projectOptions.find(option => option.key === value)
                        onChange('workspacePath', project?.workspacePath ?? '')
                      }}
                      options={[
                        { value: '', label: t('todo.none', '无') },
                        ...projectOptions.map(project => ({
                          value: project.key,
                          label: projectOptionLabel(project),
                        })),
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('workbench.model', '模型')}>
                    <InlineSelect
                      dataTestId="automation-model-select"
                      value={
                        selectedModel
                          ? `${selectedModel.type}:${selectedModel.modelId ?? selectedModel.name}`
                          : ''
                      }
                      onChange={value => {
                        const [modelType, ...modelIdParts] = value.split(':')
                        const modelId = modelIdParts.join(':')
                        onModelChange(
                          models.find(
                            model =>
                              model.type === modelType && (model.modelId ?? model.name) === modelId
                          ) ?? null
                        )
                      }}
                      options={[
                        { value: '', label: t('todo.automatic', '自动') },
                        ...models.map(model => {
                          const modelId = model.modelId ?? model.name
                          return {
                            value: `${model.type}:${modelId}`,
                            label: model.displayName ?? model.name,
                          }
                        }),
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('todo.reasoning', '推理')}>
                    <InlineSelect
                      dataTestId="automation-reasoning-select"
                      value={reasoning}
                      onChange={value =>
                        onChange('modelOptions', { ...draft.modelOptions, reasoningEffort: value })
                      }
                      options={[
                        { value: 'low', label: t('todo.reasoning_low', '低') },
                        { value: 'medium', label: t('todo.reasoning_medium', '中') },
                        { value: 'high', label: t('todo.reasoning_high', '高') },
                        { value: 'xhigh', label: t('todo.reasoning_xhigh', '极高') },
                      ]}
                    />
                  </SettingsRow>
                </>
              )}
            </SettingsGroup>
          </>
        )}

        <SectionTitle
          title={t('todo.automation_frequency', '频率')}
          action={<Settings className="h-4 w-4" />}
        />
        <FrequencySettings draft={draft} onChange={onChange} />
        {calendarMode && (
          <p className="mt-2 text-xs text-text-muted">
            {t('standIn.workspace.schedule_inherits_settings')}
          </p>
        )}

        {automation && !dialogMode ? (
          <RunHistory runs={runs} locale={locale} onOpenRun={onOpenRun} />
        ) : null}
      </div>

      {dialogMode || !automation || dirty ? (
        <footer
          className={`flex w-full min-w-0 justify-end gap-2 border-t border-border py-3 ${compact ? 'shrink-0 bg-background' : 'absolute bottom-0 right-0 bg-background/95 px-6 backdrop-blur'}`}
        >
          {dialogMode && automation && (
            <button
              type="button"
              data-testid={`automation-detail-toggle-${automation.id}`}
              disabled={saving}
              onClick={onToggle}
              className="h-8 rounded-lg px-3 text-sm hover:bg-surface"
            >
              {t(automation.enabled ? 'todo.automation_pause' : 'todo.automation_resume')}
            </button>
          )}
          {!automation ? (
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-lg px-3 text-sm hover:bg-surface"
            >
              {t('workbench.cancel', '取消')}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="automation-save-button"
            onClick={onSave}
            disabled={saving || (dialogMode && !dirty)}
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('workbench.save', '保存')}
          </button>
        </footer>
      ) : null}
    </section>
  )
}

function deviceDisplayName(
  device: DeviceInfo,
  localDeviceIds: string[],
  t: (key: string, fallback: string) => string
): string {
  const name = isCurrentAppDevice(device, localDeviceIds)
    ? t('todo.automation_this_computer', '此电脑')
    : device.name?.trim() || t('workbench.environment_device_unknown', '未知设备')
  return isRemoteDevice(device)
    ? `${name} · ${t('workbench.remote_host_docker_group', '远程 Docker 设备')}`
    : name
}

function deviceOptionLabel(
  device: DeviceInfo,
  localDeviceIds: string[],
  t: (key: string, fallback: string, options?: Record<string, string>) => string
): string {
  const name = deviceDisplayName(device, localDeviceIds, t)
  if (device.status === 'offline') {
    return `${name} · ${t('workbench.project_device_status_offline', '离线')}`
  }
  if (isDeviceBelowWeWorkVersion(device)) {
    return `${name} · ${t(
      'workbench.remote_host_upgrade_required',
      `需升级到 v${WEWORK_MIN_EXECUTOR_VERSION}`,
      { version: WEWORK_MIN_EXECUTOR_VERSION }
    )}`
  }
  if (!canUseForProjectCreation(device)) {
    return `${name} · ${t('workbench.project_device_status_unavailable', '不可用')}`
  }
  return name
}

function FrequencySettings({
  draft,
  onChange,
}: {
  draft: AutomationDraft
  onChange: <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => void
}) {
  const { t } = useTranslation('common')
  const repeatOptions = [
    { value: 'weekdays', label: t('todo.weekdays', '工作日') },
    { value: 'daily', label: t('todo.daily', '每天') },
    { value: 'weekly', label: t('todo.weekly', '每周') },
    { value: 'custom', label: t('todo.custom', '自定义') },
    { value: 'one_time', label: t('todo.automation_schedule_once', '仅一次') },
  ]
  const customFrequencyOptions = [
    { value: 'hourly', label: t('todo.automation_every_hour', '每小时') },
    { value: 'daily', label: t('todo.daily', '每天') },
    { value: 'weekly', label: t('todo.weekly', '每周') },
    { value: 'monthly', label: t('todo.automation_monthly', '每月') },
    { value: 'yearly', label: t('todo.automation_yearly', '每年') },
    { value: 'cron', label: t('todo.automation_cron_expression') },
  ]
  const repeatValue = draft.scheduleType === 'one_time' ? 'one_time' : draft.cronPreset
  const intervalUnitLabel = {
    hourly: t('todo.automation_hour_unit', '小时'),
    daily: t('todo.automation_day_unit', '天'),
    weekly: t('todo.automation_week_unit', '周'),
    monthly: t('todo.automation_month_unit', '月'),
    yearly: t('todo.automation_year_unit', '年'),
    cron: '',
  }[draft.customFrequency]

  const setRepeat = (value: string) => {
    if (value === 'one_time') {
      onChange('scheduleType', 'one_time')
      return
    }
    onChange('scheduleType', 'cron')
    onChange('cronPreset', value as CronPreset)
  }

  return (
    <SettingsGroup>
      <SettingsRow label={t('todo.automation_repeat', '重复')}>
        <MenuSelect
          testId="automation-repeat-menu"
          value={repeatValue}
          options={repeatOptions}
          onChange={setRepeat}
        />
      </SettingsRow>
      {draft.scheduleType === 'one_time' ? (
        <SettingsRow label={t('todo.automation_execute_at', '执行时间')}>
          <input
            data-testid="automation-execute-at-input"
            type="datetime-local"
            step="1"
            value={draft.executeAt}
            onChange={event => onChange('executeAt', event.target.value)}
            className="bg-transparent text-right text-sm outline-none"
          />
        </SettingsRow>
      ) : null}
      {draft.scheduleType === 'cron' && draft.cronPreset === 'custom' ? (
        <>
          <SettingsRow label={t('todo.automation_repeat', '重复')}>
            <MenuSelect
              testId="automation-custom-frequency-menu"
              value={draft.customFrequency}
              options={customFrequencyOptions}
              onChange={value => onChange('customFrequency', value as CustomFrequency)}
              pill
            />
          </SettingsRow>
          {draft.customFrequency === 'cron' ? (
            <SettingsRow label={t('todo.automation_cron_expression')}>
              <input
                data-testid="automation-cron-expression"
                aria-label={t('todo.automation_cron_expression')}
                value={draft.cronExpression}
                onChange={event => onChange('cronExpression', event.target.value)}
                className="w-40 bg-transparent text-right text-sm outline-none"
              />
            </SettingsRow>
          ) : (
            <SettingsRow label={t('todo.automation_every', '每隔')}>
              <span className="flex items-center gap-2 text-sm">
                <input
                  data-testid="automation-custom-interval"
                  type="number"
                  min="1"
                  value={draft.customInterval}
                  onChange={event => onChange('customInterval', event.target.value)}
                  className="w-10 bg-transparent text-right outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="text-text-secondary">{intervalUnitLabel}</span>
              </span>
            </SettingsRow>
          )}
          {draft.customFrequency === 'weekly' ? (
            <SettingsRow label={t('todo.automation_on', '开启')}>
              <WeekdayMenu
                testId="automation-custom-weekdays"
                value={draft.customWeekdays}
                onChange={value => onChange('customWeekdays', value)}
              />
            </SettingsRow>
          ) : null}
        </>
      ) : null}
      {draft.scheduleType === 'cron' && draft.cronPreset === 'weekly' ? (
        <SettingsRow label={t('todo.automation_on', '开启')}>
          <WeekdayMenu
            testId="automation-weekly-day"
            value={[draft.weeklyDay]}
            single
            onChange={value => onChange('weeklyDay', value[0] ?? '1')}
          />
        </SettingsRow>
      ) : null}
      {draft.scheduleType === 'cron' &&
      !(draft.cronPreset === 'custom' && ['hourly', 'cron'].includes(draft.customFrequency)) ? (
        <SettingsRow label={t('todo.automation_time', '时间')}>
          <TimeMenu
            testId="automation-cron-time"
            value={draft.cronTime}
            onChange={value => onChange('cronTime', value)}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow label={t('todo.automation_notifications', '通知')}>
        <MenuSelect
          testId="automation-notification-menu"
          value={draft.notificationPolicy}
          options={[
            { value: 'all_runs', label: t('todo.automation_all_runs', '所有运行') },
            {
              value: 'attention_only',
              label: t('todo.automation_attention_only', '仅需要关注时'),
            },
            { value: 'never', label: t('todo.automation_notifications_never', '不通知') },
          ]}
          onChange={value =>
            onChange('notificationPolicy', value as AutomationDraft['notificationPolicy'])
          }
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

function InlineSelect({
  dataTestId,
  value,
  disabled,
  onChange,
  options,
}: {
  dataTestId: string
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  options: MenuOption[]
}) {
  return (
    <MenuSelect
      testId={dataTestId}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
    />
  )
}

function AutomationTaskSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: AutomationTaskMenuOption[]
}) {
  const { t } = useTranslation('common')
  const selected = options.find(option => option.key === value)
  return (
    <PopupMenu
      testId="automation-target-task-select"
      menuWidth={352}
      trigger={
        <span className="inline-flex h-8 max-w-72 items-center justify-end gap-1.5 rounded-full bg-surface px-2 text-sm font-medium">
          <span className="truncate">
            {selected?.label ?? t('todo.automation_select_pinned_task', '选择一个已固定任务')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
        </span>
      }
    >
      {close => (
        <div className="w-full min-w-0">
          <div className="px-3 pb-2 pt-1 text-sm font-medium text-text-tertiary">
            {t('todo.automation_target_task', '目标任务')}
          </div>
          {options.length ? (
            options.map(option => (
              <button
                key={option.key}
                type="button"
                data-testid={`automation-target-task-select-option-${option.key}`}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return
                  onChange(option.key)
                  close()
                }}
                className="flex h-10 w-full items-center rounded-xl px-3 text-left text-sm font-medium hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.key === value ? <Check className="h-4 w-4 shrink-0" /> : null}
              </button>
            ))
          ) : (
            <p className="whitespace-normal px-3 pb-2 text-sm font-medium leading-6 text-text-primary">
              {t(
                'todo.automation_pin_local_task_first',
                '请先置顶一个可用设备上的任务，再使用已安排任务'
              )}
            </p>
          )}
        </div>
      )}
    </PopupMenu>
  )
}

type AutomationTaskMenuOption = ReturnType<typeof buildAutomationTaskOptions>[number] & {
  disabled: boolean
}

function RunHistory({
  runs,
  locale,
  onOpenRun,
}: {
  runs: AutomationRun[]
  locale: string
  onOpenRun?(run: AutomationRun): void
}) {
  const { t } = useTranslation('common')
  return (
    <div className="mt-8" data-testid="automation-run-history">
      <h3 className="mb-2 px-1 text-sm font-medium text-text-tertiary">
        {t('todo.automation_run_history', '运行记录')}
      </h3>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border px-4">
        {runs.length === 0 ? (
          <p className="py-4 text-sm text-text-secondary">
            {t('todo.automation_no_runs', '尚无运行记录')}
          </p>
        ) : (
          runs.slice(0, 20).map(run => (
            <div
              key={run.id}
              data-testid={`automation-run-${run.id}`}
              className="flex min-h-12 items-center gap-3 py-2 text-sm"
            >
              <span data-testid={`automation-run-status-${run.id}`} className="w-24 shrink-0">
                {runStatusLabel(run.status, t)}
              </span>
              <span className="min-w-0 flex-1 truncate text-text-tertiary">
                {formatDate(run.scheduledFor, locale)}
              </span>
              {run.error ? (
                <span className="max-w-48 truncate text-red-600" title={run.error}>
                  {run.error}
                </span>
              ) : null}
              {run.taskId && run.deviceId && onOpenRun && (
                <button
                  type="button"
                  data-testid={`automation-run-open-${run.id}`}
                  onClick={() => onOpenRun(run)}
                  className="min-h-8 shrink-0 rounded-md px-2 text-sm underline hover:bg-surface"
                >
                  {t('standIn.workspace.open_work')}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function runStatusLabel(
  status: AutomationRun['status'],
  t: (key: string, fallback: string) => string
) {
  const labels: Record<AutomationRun['status'], string> = {
    pending: t('todo.automation_status_pending', '等待中'),
    running: t('todo.automation_status_running', '运行中'),
    succeeded: t('todo.automation_status_succeeded', '已完成'),
    failed: t('todo.automation_status_failed', '失败'),
    skipped: t('todo.automation_status_skipped', '已跳过'),
    needs_attention: t('todo.automation_status_attention', '需要关注'),
    cancelled: t('todo.automation_status_cancelled', '已取消'),
  }
  return labels[status] ?? status
}

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
