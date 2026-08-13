import { useState } from 'react'
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
}

export function AutomationDetailWorkspace({
  draft,
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
}: AutomationDetailWorkspaceProps) {
  const { t } = useTranslation('common')
  const [actionsOpen, setActionsOpen] = useState(false)
  const taskOptions = buildAutomationTaskOptions(runtimeWork, new Set(localDeviceIds))
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
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <header className="flex min-h-16 shrink-0 items-start justify-between gap-4 px-6 pt-4">
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-blue-500">
            {automation
              ? automation.enabled
                ? t('workbench.automation_status_active', '活跃')
                : t('workbench.automation_status_paused', '已暂停')
              : t('workbench.automation_status_new', '新建')}
          </span>
          <input
            data-testid="automation-name-input"
            value={draft.name}
            onChange={event => onChange('name', event.target.value)}
            className="mt-2 w-full border-0 bg-transparent p-0 text-heading-md font-medium tracking-[-0.02em] text-text-primary outline-none placeholder:text-text-tertiary"
            placeholder={t('workbench.automation_name', '名称')}
            autoFocus={!automation}
          />
        </div>
        <div className="relative flex shrink-0 items-center gap-1">
          {automation ? (
            <>
              <button
                type="button"
                data-testid={`automation-detail-actions-${automation.id}`}
                onClick={() => setActionsOpen(open => !open)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface"
                aria-label={t('workbench.automation_actions', '自动化操作')}
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
                    ? t('workbench.automation_pause', '暂停')
                    : t('workbench.automation_resume', '恢复')
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
                    {t('workbench.automation_run_now', '立即运行')}
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
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-28 pt-3">
        <textarea
          data-testid="automation-prompt-input"
          value={draft.prompt}
          onChange={event => onChange('prompt', event.target.value)}
          className="min-h-24 w-full resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary"
          placeholder={t('workbench.automation_prompt', '任务说明')}
        />

        <SectionTitle
          title={t('workbench.automation_details', '详情')}
          action={<Info className="h-4 w-4" />}
        />
        <SettingsGroup>
          <SettingsRow
            label={t('workbench.automation_goal_mode', '持续完成目标')}
            description={t(
              'workbench.automation_goal_description',
              '将任务说明作为目标持续推进，直到目标完成'
            )}
          >
            <SettingsSwitch
              data-testid="automation-goal-switch"
              checked={draft.goalEnabled}
              onCheckedChange={checked => onChange('goalEnabled', checked)}
              aria-label={t('workbench.automation_goal_mode', '持续完成目标')}
            />
          </SettingsRow>
          <SettingsRow label={t('workbench.automation_run_in', '运行于')}>
            <InlineSelect
              dataTestId="automation-conversation-mode"
              value={draft.conversationMode}
              onChange={value => {
                const mode = value as AutomationConversationMode
                onChange('conversationMode', mode)
                if (mode === 'continue_thread' && !draft.continuationAddress) {
                  const currentKey = automationTaskKey(currentRuntimeTask)
                  const target =
                    taskOptions.find(option => option.key === currentKey) ?? taskOptions[0] ?? null
                  onChange('continuationAddress', target?.address ?? null)
                  onChange('source', 'local')
                  if (target) {
                    onChange('deviceId', target.address.deviceId)
                    onChange('workspacePath', target.address.workspacePath ?? '')
                  }
                }
              }}
              options={[
                {
                  value: 'independent',
                  label: t('workbench.automation_new_task', '新任务'),
                },
                {
                  value: 'continue_thread',
                  label: t('workbench.automation_continue_conversation', '现有任务'),
                },
              ]}
            />
          </SettingsRow>
          {draft.conversationMode === 'continue_thread' ? (
            <SettingsRow label={t('workbench.task', '任务')}>
              <AutomationTaskSelect
                value={automationTaskKey(draft.continuationAddress)}
                onChange={value => {
                  const target = taskOptions.find(option => option.key === value)
                  onChange('continuationAddress', target?.address ?? null)
                  if (target) {
                    onChange(
                      'source',
                      localDeviceIds.includes(target.address.deviceId) ? 'local' : 'cloud'
                    )
                    onChange('deviceId', target.address.deviceId)
                    onChange('workspacePath', target.address.workspacePath ?? '')
                  }
                }}
                options={taskOptions}
              />
            </SettingsRow>
          ) : (
            <>
              <SettingsRow label={t('workbench.automation_location', '运行位置')}>
                <InlineSelect
                  dataTestId="automation-source-select"
                  value={draft.source}
                  disabled={Boolean(automation)}
                  onChange={value => onSourceChange(value as AutomationSource)}
                  options={[
                    { value: 'local', label: t('workbench.automation_local', '本地') },
                    {
                      value: 'cloud',
                      label: t('workbench.automation_cloud', '云端'),
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
                      label: t('workbench.automation_select_device', '选择设备'),
                    },
                    ...devices.map(device => ({
                      value: device.device_id,
                      label: deviceDisplayName(device, t),
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
                    { value: '', label: t('workbench.none', '无') },
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
                    { value: '', label: t('workbench.automatic', '自动') },
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
              <SettingsRow label={t('workbench.reasoning', '推理')}>
                <InlineSelect
                  dataTestId="automation-reasoning-select"
                  value={reasoning}
                  onChange={value =>
                    onChange('modelOptions', { ...draft.modelOptions, reasoningEffort: value })
                  }
                  options={[
                    { value: 'low', label: t('workbench.reasoning_low', '低') },
                    { value: 'medium', label: t('workbench.reasoning_medium', '中') },
                    { value: 'high', label: t('workbench.reasoning_high', '高') },
                    { value: 'xhigh', label: t('workbench.reasoning_xhigh', '极高') },
                  ]}
                />
              </SettingsRow>
            </>
          )}
        </SettingsGroup>

        <SectionTitle
          title={t('workbench.automation_frequency', '频率')}
          action={<Settings className="h-4 w-4" />}
        />
        <FrequencySettings draft={draft} onChange={onChange} />

        {automation ? <RunHistory runs={runs} locale={locale} /> : null}
      </div>

      {!automation || dirty ? (
        <footer className="absolute bottom-0 right-0 flex w-full min-w-0 justify-end gap-2 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
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
            disabled={saving}
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
  t: (key: string, fallback: string) => string
): string {
  if (
    device.device_id === 'local-device' ||
    device.device_type === 'local' ||
    device.name === 'Local Executor'
  ) {
    return t('workbench.automation_this_computer', '此电脑')
  }
  return device.name || device.device_id
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
    { value: 'weekdays', label: t('workbench.weekdays', '工作日') },
    { value: 'daily', label: t('workbench.daily', '每天') },
    { value: 'weekly', label: t('workbench.weekly', '每周') },
    { value: 'custom', label: t('workbench.custom', '自定义') },
    { value: 'one_time', label: t('workbench.automation_schedule_once', '仅一次') },
  ]
  const customFrequencyOptions = [
    { value: 'hourly', label: t('workbench.automation_every_hour', '每小时') },
    { value: 'daily', label: t('workbench.daily', '每天') },
    { value: 'weekly', label: t('workbench.weekly', '每周') },
    { value: 'monthly', label: t('workbench.automation_monthly', '每月') },
    { value: 'yearly', label: t('workbench.automation_yearly', '每年') },
  ]
  const repeatValue = draft.scheduleType === 'one_time' ? 'one_time' : draft.cronPreset
  const intervalUnitLabel = {
    hourly: t('workbench.automation_hour_unit', '小时'),
    daily: t('workbench.automation_day_unit', '天'),
    weekly: t('workbench.automation_week_unit', '周'),
    monthly: t('workbench.automation_month_unit', '月'),
    yearly: t('workbench.automation_year_unit', '年'),
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
      <SettingsRow label={t('workbench.automation_repeat', '重复')}>
        <MenuSelect
          testId="automation-repeat-menu"
          value={repeatValue}
          options={repeatOptions}
          onChange={setRepeat}
        />
      </SettingsRow>
      {draft.scheduleType === 'one_time' ? (
        <SettingsRow label={t('workbench.automation_execute_at', '执行时间')}>
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
          <SettingsRow label={t('workbench.automation_repeat', '重复')}>
            <MenuSelect
              testId="automation-custom-frequency-menu"
              value={draft.customFrequency}
              options={customFrequencyOptions}
              onChange={value => onChange('customFrequency', value as CustomFrequency)}
              pill
            />
          </SettingsRow>
          <SettingsRow label={t('workbench.automation_every', '每隔')}>
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
          {draft.customFrequency === 'weekly' ? (
            <SettingsRow label={t('workbench.automation_on', '开启')}>
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
        <SettingsRow label={t('workbench.automation_on', '开启')}>
          <WeekdayMenu
            testId="automation-weekly-day"
            value={[draft.weeklyDay]}
            single
            onChange={value => onChange('weeklyDay', value[0] ?? '1')}
          />
        </SettingsRow>
      ) : null}
      {draft.scheduleType === 'cron' &&
      !(draft.cronPreset === 'custom' && draft.customFrequency === 'hourly') ? (
        <SettingsRow label={t('workbench.automation_time', '时间')}>
          <TimeMenu
            testId="automation-cron-time"
            value={draft.cronTime}
            onChange={value => onChange('cronTime', value)}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow label={t('workbench.automation_notifications', '通知')}>
        <MenuSelect
          testId="automation-notification-menu"
          value={draft.notificationPolicy}
          options={[
            { value: 'all_runs', label: t('workbench.automation_all_runs', '所有运行') },
            {
              value: 'attention_only',
              label: t('workbench.automation_attention_only', '仅需要关注时'),
            },
            { value: 'never', label: t('workbench.automation_notifications_never', '不通知') },
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
  options: ReturnType<typeof buildAutomationTaskOptions>
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
            {selected?.label ?? t('workbench.automation_select_pinned_task', '选择一个已固定任务')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
        </span>
      }
    >
      {close => (
        <div className="w-full min-w-0">
          <div className="px-3 pb-2 pt-1 text-sm font-medium text-text-tertiary">
            {t('workbench.automation_target_task', '目标任务')}
          </div>
          {options.length ? (
            options.map(option => (
              <button
                key={option.key}
                type="button"
                data-testid={`automation-target-task-select-option-${option.key}`}
                onClick={() => {
                  onChange(option.key)
                  close()
                }}
                className="flex h-10 w-full items-center rounded-xl px-3 text-left text-sm font-medium hover:bg-surface"
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.key === value ? <Check className="h-4 w-4 shrink-0" /> : null}
              </button>
            ))
          ) : (
            <p className="whitespace-normal px-3 pb-2 text-sm font-medium leading-6 text-text-primary">
              {t(
                'workbench.automation_pin_local_task_first',
                '请先置顶一个本地任务，再使用已安排任务'
              )}
            </p>
          )}
        </div>
      )}
    </PopupMenu>
  )
}

function RunHistory({ runs, locale }: { runs: AutomationRun[]; locale: string }) {
  const { t } = useTranslation('common')
  return (
    <div className="mt-8" data-testid="automation-run-history">
      <h3 className="mb-2 px-1 text-sm font-medium text-text-tertiary">
        {t('workbench.automation_run_history', '运行记录')}
      </h3>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border px-4">
        {runs.length === 0 ? (
          <p className="py-4 text-sm text-text-secondary">
            {t('workbench.automation_no_runs', '尚无运行记录')}
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
    pending: t('workbench.automation_status_pending', '等待中'),
    running: t('workbench.automation_status_running', '运行中'),
    succeeded: t('workbench.automation_status_succeeded', '已完成'),
    failed: t('workbench.automation_status_failed', '失败'),
    skipped: t('workbench.automation_status_skipped', '已跳过'),
    needs_attention: t('workbench.automation_status_attention', '需要关注'),
    cancelled: t('workbench.automation_status_cancelled', '已取消'),
  }
  return labels[status] ?? status
}

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
