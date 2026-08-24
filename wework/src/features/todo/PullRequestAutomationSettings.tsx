import { useState } from 'react'
import type { CloudProject, PullRequestAutoRepairStatus } from '@/api/deliveries'
import { SettingsGroup, SettingsRow } from '@/components/common/SettingsGroup'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

const statusOptions: PullRequestAutoRepairStatus[] = [
  'checks_failed',
  'merge_conflict',
  'merge_queue_failed',
  'merge_queue_timed_out',
  'merge_queue_conflicting',
]

export function PullRequestAutomationSettings({
  value,
  canManage,
  busy,
  onSave,
}: {
  value: NonNullable<CloudProject['pull_request_automation']>
  canManage: boolean
  busy: boolean
  onSave: (value: NonNullable<CloudProject['pull_request_automation']>) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [draft, setDraft] = useState(value)

  const save = async (next: typeof draft) => {
    setDraft(next)
    await onSave(next)
  }

  return (
    <section className="mt-6" data-testid="pull-request-automation-settings">
      <h3 className="text-heading-sm font-medium text-text-primary">
        {t('workbench.pull_request_automation_title', 'PR 自动修复')}
      </h3>
      <p className="mt-1 text-sm text-text-muted">
        {t(
          'workbench.pull_request_automation_description',
          '当 PR 或 Merge Queue 出现选定异常时，继续原任务会话让 AI 修复。'
        )}
      </p>
      <div className="mt-3">
        <SettingsGroup>
          <SettingsRow label={t('workbench.pull_request_automation_enabled', '自动修复')}>
            <SettingsSwitch
              data-testid="pull-request-automation-enabled"
              checked={draft.enabled}
              disabled={!canManage || busy}
              onCheckedChange={enabled => void save({ ...draft, enabled })}
            />
          </SettingsRow>
          <SettingsRow label={t('workbench.pull_request_automation_statuses', '触发状态')}>
            <div className="flex flex-wrap gap-2">
              {statusOptions.map(status => {
                const selected = draft.statuses.includes(status)
                return (
                  <button
                    key={status}
                    type="button"
                    data-testid={`pull-request-automation-status-${status}`}
                    aria-pressed={selected}
                    disabled={!canManage || busy}
                    onClick={() => {
                      const statuses = selected
                        ? draft.statuses.filter(item => item !== status)
                        : [...draft.statuses, status]
                      void save({ ...draft, statuses })
                    }}
                    className={cn(
                      'h-8 rounded-lg border px-2.5 text-xs transition disabled:opacity-50',
                      selected
                        ? 'border-text-primary bg-text-primary text-background'
                        : 'border-border bg-background text-text-secondary hover:bg-muted'
                    )}
                  >
                    {t(`workbench.pull_request_automation_status_${status}`, status)}
                  </button>
                )
              })}
            </div>
          </SettingsRow>
          <SettingsRow label={t('workbench.pull_request_automation_prompt', '附加指令')}>
            <textarea
              data-testid="pull-request-automation-prompt"
              value={draft.prompt}
              disabled={!canManage || busy}
              onChange={event => setDraft({ ...draft, prompt: event.target.value })}
              onBlur={() => void onSave(draft)}
              placeholder={t(
                'workbench.pull_request_automation_prompt_placeholder',
                '例如：优先分析失败日志，不要通过重试掩盖间歇性问题。'
              )}
              className="min-h-20 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-focus disabled:opacity-50"
            />
          </SettingsRow>
        </SettingsGroup>
      </div>
    </section>
  )
}
